import { userMethods } from './store/methods/users.mjs';
import { siteMethods } from './store/methods/sites.mjs';
import { cameraMethods } from './store/methods/cameras.mjs';
import { alarmMethods } from './store/methods/alarms.mjs';
import { notifyMethods } from './store/methods/notify.mjs';
import { auditMethods } from './store/methods/audit.mjs';
import { maintenanceMethods } from './store/methods/maintenance.mjs';
export { parseRoi } from './store/helpers.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  DEFAULT_SITE_ID,
  createSchema,
  migrateLegacy,
  migrateCameraSchemaV2,
  migrateSchemaV3,
  migrateSchemaV4,
  migrateSchemaV5,
  migrateSchemaV6,
  migrateSchemaV7,
  ensureDefaultSite,
} from './schema.mjs';

/**
 * SQLite 数据存储（node:sqlite 同步驱动）。
 *
 * 本类只保留会话与基础设施方法；领域方法按模块拆分后经
 * `Object.assign(Store.prototype, …)` 挂载：
 * - 用户：./store/methods/users.mjs
 * - 站点：./store/methods/sites.mjs
 * - 点位：./store/methods/cameras.mjs
 * - 告警：./store/methods/alarms.mjs
 * - 通知：./store/methods/notify.mjs
 * - 审计：./store/methods/audit.mjs
 * - 保留期/演示清理：./store/methods/maintenance.mjs
 *
 * 行级辅助（ROI 编解码、行对象映射）见 ./store/helpers.mjs。
 */
export class Store {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.db 已初始化的数据库连接。
   * @param {string} options.dataDir 数据目录（数据库与备份所在）。
   * @param {{encrypt(value:string):string, decrypt(value:string):string}} options.secretBox 对称加解密盒。
   */
  constructor({ db, dataDir, secretBox }) {
    this.db = db;
    this.dataDir = dataDir;
    this.secretBox = secretBox;
    this.closed = false;
  }

  /**
   * IMMEDIATE 事务包装：同步执行 fn，异常时回滚后原样抛出。
   *
   * @template T
   * @param {() => T} fn 事务体（同步函数，内部用 this.db 执行多条语句）。
   * @returns {T} fn 的返回值。
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  }

  /**
   * 读取 meta 表键值。
   *
   * @param {string} key 键名。
   * @param {string|null} [fallback] 无记录时的回退值。
   * @returns {string|null} 键值（恒为字符串）或回退值。
   */
  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  /**
   * 写入 meta 表键值（UPSERT）。
   *
   * @param {string} key 键名。
   * @param {string|number|boolean} value 值（存储前转为字符串）。
   * @returns {void}
   */
  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, String(value));
  }

  /** @returns {number} 当前 schema 版本号。 */
  get schemaVersion() {
    return Number(this.getMeta('schema_version', SCHEMA_VERSION));
  }

  /** @returns {boolean} 是否尚未完成初始化（无用户且未标记 setup_complete）。 */
  get needsSetup() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    return this.getMeta('setup_complete', '0') !== '1' && Number(count) === 0;
  }

  /** @returns {boolean} 是否已完成初始化。 */
  get setupComplete() {
    return this.getMeta('setup_complete', '0') === '1';
  }

  /** @returns {void} 标记初始化完成（创建超管后调用）。 */
  completeSetup() {
    this.setMeta('setup_complete', '1');
  }

  /** @returns {string} 默认站点 ID（未自定义时回退到 DEFAULT_SITE_ID）。 */
  get defaultSiteId() {
    return this.getMeta('default_site_id', DEFAULT_SITE_ID);
  }

  /**
   * 库内总量统计（登录后首页/系统页展示）。
   *
   * @returns {import('./types.mjs').StoreStats}
   */
  stats() {
    return {
      users: Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count),
      cameras: Number(
        this.db.prepare('SELECT COUNT(*) AS count FROM cameras').get().count,
      ),
      activeAlarms: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM alarms WHERE status IN ('pending','confirmed')",
          )
          .get().count,
      ),
      alarms: Number(this.db.prepare('SELECT COUNT(*) AS count FROM alarms').get().count),
    };
  }

  /**
   * 在线备份数据库：VACUUM INTO 导出快照并按份数滚动清理旧备份。
   *
   * @param {string} [backupDir] 备份目录，默认 dataDir/backups。
   * @param {number} [retain] 保留份数，默认 14。
   * @returns {Promise<string>} 本次备份文件绝对路径。
   */
  async backup(backupDir = path.join(this.dataDir, 'backups'), retain = 14) {
    await fsp.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `app-${stamp}.db`);
    const escaped = destination.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    const files = (await fsp.readdir(backupDir))
      .filter((file) => /^app-.*\.db$/.test(file))
      .sort()
      .reverse();
    await Promise.all(
      files.slice(retain).map((file) =>
        fsp.rm(path.join(backupDir, file), { force: true }),
      ),
    );
    return destination;
  }

  /** @returns {boolean} 数据库连通性（SELECT 1 探测）。 */
  health() {
    const row = this.db.prepare('SELECT 1 AS ok').get();
    return row?.ok === 1;
  }

  /** @returns {void} 关闭数据库连接（幂等）。 */
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

Object.assign(Store.prototype, userMethods, siteMethods, cameraMethods, alarmMethods, notifyMethods, auditMethods, maintenanceMethods);

function backupCorruptFiles(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const file of ['app.db', 'app.db-wal', 'app.db-shm']) {
    const source = path.join(dataDir, file);
    if (fs.existsSync(source)) {
      try {
        fs.copyFileSync(source, path.join(dataDir, `${file}.corrupt-${stamp}`));
      } catch {
        // 备份失败也不能掩盖原始错误。
      }
    }
  }
}

/**
 * 打开并初始化数据存储：建目录、建库、跑建表与全部版本迁移，
 * 损坏时把旧库文件备份为 *.corrupt-* 再抛错（不掩盖原始故障现场）。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（自动创建，权限 0o700）。
 * @param {{encrypt(value:string):string, decrypt(value:string):string}} options.secretBox 对称加解密盒。
 * @param {object|null} [options.legacyData] 旧版 JSON 存量数据（首次迁移用）。
 * @returns {Promise<Store>} 就绪的 Store 实例。
 * @throws {Error} SQLite 初始化失败（已保留损坏文件备份）。
 */
export async function openStore({ dataDir, secretBox, legacyData = null }) {
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'app.db');
  let db;
  try {
    db = new DatabaseSync(databasePath);
    try {
      await fsp.chmod(databasePath, 0o600);
      await fsp.chmod(dataDir, 0o700);
    } catch {
      // Windows 或非 POSIX 文件系统可能不支持 chmod。
    }
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    createSchema(db);
    if (!db.prepare("SELECT value FROM meta WHERE key = 'initialized'").get()) {
      migrateLegacy(db, secretBox, legacyData);
    }
    migrateCameraSchemaV2(db);
    migrateSchemaV3(db);
    migrateSchemaV4(db);
    migrateSchemaV5(db);
    migrateSchemaV6(db);
    migrateSchemaV7(db);
    ensureDefaultSite(db);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    backupCorruptFiles(dataDir);
    throw new Error(`SQLite 数据库初始化失败，已保留损坏文件备份：${error.message}`);
  }
  return new Store({ db, dataDir, secretBox });
}

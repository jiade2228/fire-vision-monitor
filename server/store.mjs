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
  ensureDefaultSite,
} from './schema.mjs';

/** 屏蔽区一律按 0-100 的百分比矩形存储，最多 8 个。 */










export class Store {
  constructor({ db, dataDir, secretBox }) {
    this.db = db;
    this.dataDir = dataDir;
    this.secretBox = secretBox;
    this.closed = false;
  }

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

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, String(value));
  }

  get schemaVersion() {
    return Number(this.getMeta('schema_version', SCHEMA_VERSION));
  }

  get needsSetup() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    return this.getMeta('setup_complete', '0') !== '1' && Number(count) === 0;
  }

  get setupComplete() {
    return this.getMeta('setup_complete', '0') === '1';
  }

  completeSetup() {
    this.setMeta('setup_complete', '1');
  }

  

  

  

  

  

  

  

  get defaultSiteId() {
    return this.getMeta('default_site_id', DEFAULT_SITE_ID);
  }

  

  

  

  

  

  

  

  /** 站点管理员可管理的站点；普通用户返回空数组。 */
  

  

  

  

  

  

  

  

  

  

  

  

  

  

  /** 超过指定时间仍未确认的告警，用于升级提醒。 */
  

  

  /** 按站点/级别/状态聚合时间段内的告警数量，供每日摘要使用。 */
  

  /** 按上海时区按天聚合告警（含空缺的日期无行），供趋势看板使用。 */
  

  

  

  

  

  

  

  

  

  

  

  

  /** 仅取模板正文（供渠道对象内联解析）。 */
  

  

  

  

  

  

  

  /** 站点渠道 + 全局渠道（site_id IS NULL）。 */
  

  /** 抢占一次推送（唯一索引去重）：返回 true 表示本次应发送。 */
  

  

  /** 某渠道自 sinceTs 以来连续失败的次数（遇到一次成功即停止计数）。 */
  

  

  

  /** 清理超期的已关闭告警，返回需要删除的媒体文件名。 */
  

  /**
   * 演示数据清理：删除演示点位产生的告警及其事件、推送日志与媒体文件引用。
   * 口径为「camera_id 命中历史演示点位」或「camera_name 等于演示点位名」双取，
   * 避免演示点位删除后（camera_id 变孤儿）漏清；真实告警不受影响。
   * 审计日志保留（操作留痕不因清理而消失）。调用方负责删物理媒体文件。
   */
  

  /** 统计演示告警数量与媒体文件数，供前端按钮展示「将清除什么」。 */
  

  /**
   * 磁盘水位：从最老的已关闭告警开始清掉媒体文件（保留告警记录本身），
   * 返回被清空的文件名，调用方负责删除物理文件。
   */
  

  

  

  /**
   * 审计日志筛选查询（审计界面用）。
   * action 支持前缀匹配（如 'camera' 命中 camera.create/update/delete/test/import）；
   * q 匹配 username/detail/target_id；from/to 为毫秒时间戳（含头含尾）。
   */
  

  

  

  /**
   * 审计日志按天数清理（与告警/推送日志的保留语义对齐）。
   * 与上面的「按条数上限」互补：条数上限防无限膨胀，天数清理满足保留期约定。
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

  health() {
    const row = this.db.prepare('SELECT 1 AS ok').get();
    return row?.ok === 1;
  }

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


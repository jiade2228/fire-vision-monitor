import { userMethods } from './store/methods/users.mjs';
import { siteMethods } from './store/methods/sites.mjs';
import { cameraMethods } from './store/methods/cameras.mjs';
import { alarmMethods } from './store/methods/alarms.mjs';
import { notifyMethods } from './store/methods/notify.mjs';
import { auditMethods } from './store/methods/audit.mjs';
import { maintenanceMethods } from './store/methods/maintenance.mjs';
import { recordingsMethods } from './store/methods/recordings.mjs';
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
  migrateSchemaV8,
  migrateSchemaV9,
  migrateSchemaV10,
  ensurePerformanceIndexes,
  seedBuiltinTemplates,
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
    // 事务嵌套深度：Store.transaction 支持重入（内层直接并入外层事务）。
    this.txDepth = 0;
    // 权限修订号：任何账号/站点授权变更都会递增它。
    // SSE 广播据此缓存「用户 + 可见站点」，既去掉 N+1 查询，
    // 又保证撤权/停用后长连接在**下一次广播**就立即停止收到新告警。
    this.authRevision = 0;
  }

  /**
   * IMMEDIATE 事务包装：同步执行 fn，异常时回滚后原样抛出。
   *
   * 支持重入：若当前已在事务中，内层调用直接执行 fn 并复用外层事务
   * （SQLite 不允许嵌套 BEGIN），因此组合调用（如 updateAlarm 内部再调用
   * 其它事务型方法）不会抛「cannot start a transaction within a transaction」。
   *
   * @template T
   * @param {() => T} fn 事务体（同步函数，内部用 this.db 执行多条语句）。
   * @returns {T} fn 的返回值。
   */
  transaction(fn) {
    if (this.txDepth > 0) {
      // 已在外层事务中：直接执行，失败由外层统一回滚。
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.txDepth = 1;
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
    } finally {
      this.txDepth = 0;
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

  /**
   * 递增权限修订号。所有会改变「用户身份 / 角色 / 停用状态 / 站点授权」的
   * 写入都必须调用，SSE 广播缓存才会在下一次广播立即失效。
   * @returns {number} 新的修订号。
   */
  bumpAuthRevision() {
    this.authRevision += 1;
    return this.authRevision;
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
   * 在线备份数据库：VACUUM INTO 导出快照并按份数/体积滚动清理旧备份。
   *
   * 可靠性要点（此前缺失，导致「备份看起来在，出事时才发现是坏的」）：
   * 1. 先写 `.partial` 临时文件，**校验通过后才原子改名**为正式备份名——
   *    磁盘写满导致 VACUUM INTO 中途失败时，不会留下一个「看起来像备份」
   *    的半截文件（它此前会匹配 `app-*.db` 并计入份数）。
   * 2. 校验内容：能以只读方式打开、`PRAGMA integrity_check` 为 ok、
   *    关键业务表存在且行数与主库一致（数量级校验）。
   * 3. 轮转双约束：份数上限 `retain` + 总量上限 `maxBytes`。
   *    仅按份数轮转时，备份目录会随库体积线性放大（14 份 × 库大小）。
   *
   * @param {string} [backupDir] 备份目录，默认 dataDir/backups。
   * @param {number} [retain] 保留份数，默认 14。
   * @param {number} [maxBytes] 备份目录总量上限（字节），0 表示不限。
   * @returns {Promise<string>} 本次备份文件绝对路径。
   */
  async backup(
    backupDir = path.join(this.dataDir, 'backups'),
    retain = 14,
    maxBytes = 0,
  ) {
    await fsp.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDir, `app-${stamp}.db`);
    const partial = `${destination}.partial`;
    const escaped = partial.replaceAll("'", "''");
    try {
      this.db.exec(`VACUUM INTO '${escaped}'`);
      this.verifyBackupFile(partial);
      await fsp.rename(partial, destination);
    } catch (error) {
      // 失败时清掉半成品，绝不留下「计入份数但内容不完整」的备份。
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.rotateBackups(backupDir, retain, maxBytes);
    this.setMeta('last_backup_at', String(Date.now()));
    this.setMeta('last_backup_status', 'ok');
    return destination;
  }

  /**
   * 校验备份文件确实是一个能打开、没损坏、且含业务数据的数据库。
   *
   * @param {string} file 备份文件绝对路径。
   * @returns {void}
   * @throws {Error} 校验不通过时抛出，附带可读原因。
   */
  verifyBackupFile(file) {
    let probe = null;
    try {
      try {
        probe = new DatabaseSync(file, { readOnly: true });
        const integrity = probe.prepare('PRAGMA integrity_check').get();
        const verdict = String(integrity?.integrity_check ?? '').toLowerCase();
        if (verdict !== 'ok') {
          throw new Error(`备份完整性校验未通过：${verdict || '未知结果'}`);
        }
        // 关键表必须存在且行数与主库同一量级（备份刚导出，行数应完全一致）。
        const table = probe
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='alarms'")
          .get();
        if (!Number(table?.count)) {
          throw new Error('备份缺少 alarms 表，无法用于恢复');
        }
        const backed = Number(probe.prepare('SELECT COUNT(*) AS count FROM alarms').get().count);
        const live = Number(this.db.prepare('SELECT COUNT(*) AS count FROM alarms').get().count);
        if (backed !== live) {
          throw new Error(`备份告警数与主库不一致（备份 ${backed} / 主库 ${live}）`);
        }
      } catch (error) {
        // 文件损坏 / 不是数据库 / 无法打开：统一转成可读的中文错误。
        // 注意「打开」本身不一定报错，真正的失败点常常是随后的 prepare。
        if (/^备份/.test(String(error?.message ?? ''))) throw error;
        throw new Error(`备份文件无法打开或已损坏：${error.message}`);
      }
    } finally {
      try {
        probe?.close();
      } catch {
        // 关闭失败不影响校验结论
      }
    }
  }

  /**
   * 备份轮转：份数上限 + 总量上限双约束。
   *
   * @param {string} backupDir 备份目录。
   * @param {number} retain 保留份数。
   * @param {number} maxBytes 总量上限（字节），0 表示不限。
   * @returns {Promise<{removed: string[], kept: string[], bytes: number}>} 轮转结果。
   */
  async rotateBackups(backupDir, retain, maxBytes) {
    const names = (await fsp.readdir(backupDir))
      .filter((file) => /^app-.*\.db$/.test(file))
      .sort()
      .reverse();
    const removed = [];
    const kept = [];
    let bytes = 0;
    for (const name of names) {
      const full = path.join(backupDir, name);
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        continue;
      }
      // 份数超限，或（设了总量上限且加入后超限）时淘汰最旧的备份。
      const overCount = kept.length >= Math.max(1, retain);
      const overBytes = maxBytes > 0 && bytes + size > maxBytes && kept.length > 0;
      if (overCount || overBytes) {
        await fsp.rm(full, { force: true }).catch(() => undefined);
        removed.push(name);
        continue;
      }
      kept.push(name);
      bytes += size;
    }
    return { removed, kept, bytes };
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

Object.assign(Store.prototype, userMethods, siteMethods, cameraMethods, alarmMethods, notifyMethods, auditMethods, maintenanceMethods, recordingsMethods);

const CORRUPT_BACKUP_FILES = ['app.db', 'app.db-wal', 'app.db-shm'];

/**
 * 判定初始化异常是否属于「数据库文件本身损坏」。
 *
 * 只有这类错误值得保留现场副本；锁竞争、迁移逻辑错误等属于运行态故障，
 * 一律当成损坏会在 data/ 下反复堆积 *.corrupt-*，并给出误导性的诊断信息。
 * 11 = SQLITE_CORRUPT，26 = SQLITE_NOTADB。
 *
 * @param {unknown} error 捕获到的异常。
 * @returns {boolean} 是否为真实的文件损坏。
 */
export function isDatabaseCorruptionError(error) {
  const errcode = Number(error?.errcode);
  if (errcode === 11 || errcode === 26) return true;
  return /SQLITE_(CORRUPT|NOTADB)|not a database|malformed|corrupt(ed)? (database|image)/i.test(
    String(error?.message ?? error ?? ''),
  );
}

/** 文件内容签名（大小 + 头部 4KB），用于判断已有备份是否与本次等价。 */
function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, 4096);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return `${stat.size}:${buffer.toString('hex')}`;
  } catch {
    return `missing:${path.basename(file)}`;
  }
}

/**
 * 备份损坏现场；若最近一次备份的主库与 WAL 内容与本次完全一致则跳过，
 * 避免「实例反复启动失败」无限生成同质副本。
 * shm 只是共享内存索引，每次运行都会重建，因此不参与判重（但仍随现场复制）。
 *
 * @internal 供回归测试直接调用。
 * @param {string} dataDir 数据目录。
 * @returns {boolean} 是否产生了新备份。
 */
export function backupCorruptFiles(dataDir) {
  const current = ['app.db', 'app.db-wal']
    .map((file) => fileSignature(path.join(dataDir, file)))
    .join('|');
  const previous = fs
    .readdirSync(dataDir)
    .filter((file) => /^app\.db\.corrupt-/.test(file))
    .sort()
    .reverse()[0];
  if (previous) {
    const suffix = previous.slice('app.db.corrupt'.length);
    const saved = ['app.db', 'app.db-wal']
      .map((file) => fileSignature(path.join(dataDir, `${file}.corrupt${suffix}`)))
      .join('|');
    if (saved === current) return false;
  }

  // 备份名带毫秒时间戳；同一毫秒内再次损坏时追加序号，避免覆盖上一份现场。
  // 守护重启循环会在极短时间内反复触发损坏（Linux 上尤其明显），若直接覆盖，
  // 运维就看不到历史损坏现场了。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let suffix = stamp;
  let counter = 1;
  while (fs.existsSync(path.join(dataDir, `app.db.corrupt-${suffix}`))) {
    suffix = `${stamp}-${counter}`;
    counter += 1;
  }
  for (const file of CORRUPT_BACKUP_FILES) {
    const source = path.join(dataDir, file);
    if (fs.existsSync(source)) {
      try {
        fs.copyFileSync(source, path.join(dataDir, `${file}.corrupt-${suffix}`));
      } catch {
        // 备份失败也不能掩盖原始错误。
      }
    }
  }
  return true;
}

/**
 * 打开并初始化数据存储：建目录、建库、跑建表与全部版本迁移，
 * 真实文件损坏时把旧库备份为 *.corrupt-* 再抛错（不掩盖原始故障现场）；
 * 其他初始化失败（如多实例锁竞争）原样抛出真实原因，不生成误导性备份。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（自动创建，权限 0o700）。
 * @param {{encrypt(value:string):string, decrypt(value:string):string}} options.secretBox 对称加解密盒。
 * @param {object|null} [options.legacyData] 旧版 JSON 存量数据（首次迁移用）。
 * @returns {Promise<Store>} 就绪的 Store 实例。
 * @throws {Error} SQLite 初始化失败（附原始异常作为 cause）。
 */
export async function openStore({ dataDir, secretBox, legacyData = null }) {
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'app.db');
  let db;
  try {
    db = new DatabaseSync(databasePath);
    // 必须先设 busy_timeout：切换 journal_mode 需要排他锁，
    // 多实例启动竞争时若尚未设置超时会立刻抛 SQLITE_BUSY。
    db.exec('PRAGMA busy_timeout = 5000');
    try {
      await fsp.chmod(databasePath, 0o600);
      await fsp.chmod(dataDir, 0o700);
    } catch {
      // Windows 或非 POSIX 文件系统可能不支持 chmod。
    }
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
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
    migrateSchemaV8(db);
    migrateSchemaV9(db);
    migrateSchemaV10(db);
    // 内置模板幂等补种：全新库直接建 V10 schema，不会执行 V6 迁移，
    // 因此模板从来没被播种过。放在所有迁移之后统一补，INSERT OR IGNORE
    // 保证不会覆盖用户改过的内容，也顺带修复历史库误删内置模板的情况。
    seedBuiltinTemplates(db);
    ensureDefaultSite(db);
    // 补齐 V9 性能索引。必须在所有表结构迁移之后：
    // alarms 表在 V4/V7 迁移中才补上 clip_file / site_id 列，
    // 提前建索引会让存量旧库直接启动失败。
    ensurePerformanceIndexes(db);
    // 采集查询统计信息（sqlite_stat1）。
    // 必须在所有索引建好之后执行：没有统计信息时，规划器会忽略部分索引
    // （实测媒体水位清理退回「全表扫描 + 临时排序」），
    // 有统计信息后才走「SCAN alarms USING INDEX idx_alarm_media_old」。
    // ANALYZE 只写 sqlite_stat1 系统表，失败不影响数据正确性。
    try {
      db.exec('ANALYZE');
    } catch {
      // 统计信息缺失只影响查询计划，不影响功能。
    }
  } catch (error) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    if (isDatabaseCorruptionError(error)) {
      backupCorruptFiles(dataDir);
      throw new Error(`SQLite 数据库初始化失败，已保留损坏文件备份：${error.message}`, {
        cause: error,
      });
    }
    throw new Error(
      `SQLite 数据库初始化失败：${error.message}。数据库未判定为损坏，未生成损坏备份；请确认数据目录没有被其他实例占用。`,
      { cause: error },
    );
  }
  return new Store({ db, dataDir, secretBox });
}

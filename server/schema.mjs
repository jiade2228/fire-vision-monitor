// 数据库 schema 定义与版本迁移（V1→V10）。由 store.mjs 的 openStore 调用。
// 本模块只依赖 node:crypto，所有函数接收已打开的 DatabaseSync 实例。
import crypto from 'node:crypto';


export const SCHEMA_VERSION = 10;

/**
 * V10：服务端会话登记表。
 *
 * 纯新增表，不影响 users 表任何既有列 —— 升级安全、无数据风险。
 * 用途：让登出只撤销「当前会话」，而不是把该账号所有设备的令牌一起作废。
 */
export const AUTH_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_session_user
    ON auth_sessions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_auth_session_expires
    ON auth_sessions(expires_at);
`;

/** 持续录像分段索引（V8）。文件系统是事实源，本表只作为查询缓存。 */
export const RECORDING_SEGMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS recording_segments (
    id TEXT PRIMARY KEY,
    camera_id TEXT NOT NULL,
    file TEXT NOT NULL UNIQUE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    protected INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_recording_cam_start
    ON recording_segments(camera_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_recording_started
    ON recording_segments(started_at);
`;

/**
 * V9 性能索引：只建索引，不改任何表结构，因此对存量库与新库都安全、可回滚。
 *
 * 背景（20 万告警 / 50 万审计日志 / 20 万录像段基准库实测）：
 *   - 管理员告警列表 `ORDER BY created_at DESC` 走全表扫描 + USE TEMP B-TREE，38 ms/请求；
 *   - 磁盘水位清理按「已关闭 + 有媒体文件」过滤后升序取最旧，同样临时排序，单次 1.2 秒；
 *   - 按渠道删除推送日志无索引，2.3 秒。
 *
 * 注意（重要）：这些索引**不能**写进 createSchema。
 * createSchema 对存量库是「不重建已有表」的，它先于 V4/V7 迁移执行，
 * 而旧版 alarms 表还没有 clip_file / site_id 列 —— 在那里建索引会直接报
 * "no such column: clip_file" 让整个启动失败。
 * 因此统一由 ensurePerformanceIndexes() 在**所有表结构迁移完成之后**执行。
 *
 * 与 createSchema 共用同一段 DDL，保证新库与升级库结构完全一致。
 */
export const PERFORMANCE_INDEXES_DDL = `
  -- 告警列表（无站点过滤时按创建时间倒序）：单列降序索引，避免临时排序
  CREATE INDEX IF NOT EXISTS idx_alarm_created
    ON alarms(created_at DESC);
  -- 磁盘水位清理：WHERE 条件与 ORDER BY created_at ASC 同时命中该部分索引
  CREATE INDEX IF NOT EXISTS idx_alarm_media_old
    ON alarms(created_at)
    WHERE status IN ('archived','false')
      AND (snapshot_file IS NOT NULL OR clip_file IS NOT NULL);
  -- 推送日志的渠道维度：查询与「删除某渠道历史推送」都走索引
  CREATE INDEX IF NOT EXISTS idx_notify_channel
    ON notification_logs(channel_id, created_at DESC);
  -- 录像段保护位维度：解除保护、按保护状态统计用量
  CREATE INDEX IF NOT EXISTS idx_seg_protected
    ON recording_segments("protected", started_at);
  -- 审计日志按 action 前缀筛选时的分页总数：此前 COUNT 全表 SCAN，
  -- 10 万行实测 13.8ms；覆盖索引后 5.5ms，且查询语义完全不变。
  CREATE INDEX IF NOT EXISTS idx_audit_action_created
    ON audit_logs(action, created_at DESC);
  -- 删除账号时清理孤儿引用：这四列此前无索引，单用户删除实测约 58ms 全表扫描。
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_alarm_event_user ON alarm_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_alarm_created_by ON alarms(created_by);
  CREATE INDEX IF NOT EXISTS idx_alarm_updated_by ON alarms(updated_by);
`;

/**
 * 补齐 V9 性能索引（幂等）。
 *
 * 必须在所有表结构迁移（V2~V8）完成之后调用：
 * alarms 表在 V4/V7 迁移中会被重建，clip_file / site_id 列是那时才有的。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的数据库。
 * @returns {void}
 */
export function ensurePerformanceIndexes(db) {
  db.exec(PERFORMANCE_INDEXES_DDL);
}

export function now() {
  return Date.now();
}

export function bool(value) {
  return Boolean(value);
}

export function jsonSteps(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Boolean) : [false, false, false, false];
  } catch {
    return [false, false, false, false];
  }
}

export function normalizeSourceForFingerprint(protocol, sourceUrl) {
  if (!sourceUrl || protocol === 'none') return null;
  try {
    const url = new URL(sourceUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'rtsp:' && url.port === '554') ||
      (url.protocol === 'rtsps:' && url.port === '322')
    ) {
      url.port = '';
    }
    const params = [...url.searchParams.entries()].sort(([a], [b]) =>
      a === b ? 0 : a.localeCompare(b),
    );
    url.search = '';
    for (const [key, value] of params) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return sourceUrl.trim();
  }
}

export function sourceFingerprint(protocol, sourceUrl) {
  const normalized = normalizeSourceForFingerprint(protocol, sourceUrl);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function migrateLegacy(db, secretBox, legacyData) {
  const hasLegacy =
    legacyData &&
    ((Array.isArray(legacyData.users) && legacyData.users.length > 0) ||
      (Array.isArray(legacyData.cameras) && legacyData.cameras.length > 0));
  if (!hasLegacy) {
    // 三条 meta 写入必须原子且可重入：初始化中途被 kill 后，再次启动不能因唯一约束永久失败。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('setup_complete', '0') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run();
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('initialized', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run();
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 事务可能已被自动回滚，保留原始错误。
      }
      throw error;
    }
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const insertUser = db.prepare(`
      INSERT INTO users
      (id, username, display_name, role, salt, password_hash, disabled, token_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    for (const user of legacyData.users ?? []) {
      insertUser.run(
        user.id ?? crypto.randomUUID(),
        String(user.username ?? '').trim(),
        String(user.displayName ?? user.username ?? ''),
        ['admin', 'operator', 'viewer'].includes(user.role) ? user.role : 'viewer',
        String(user.salt ?? ''),
        String(user.passwordHash ?? ''),
        user.disabled ? 1 : 0,
        Number(user.createdAt) || now(),
      );
    }

    const insertCamera = db.prepare(`
      INSERT INTO cameras
      (id, code, name, zone, protocol, source_url, source_key, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let index = 0;
    for (const camera of legacyData.cameras ?? []) {
      index += 1;
      const protocol = ['none', 'hls', 'http', 'rtsp'].includes(camera.protocol)
        ? camera.protocol
        : 'none';
      const sourceUrl = typeof camera.sourceUrl === 'string' ? camera.sourceUrl : '';
      const storedUrl = protocol === 'rtsp' && sourceUrl
        ? secretBox.encrypt(sourceUrl)
        : sourceUrl;
      insertCamera.run(
        camera.id ?? crypto.randomUUID(),
        String(camera.code ?? `CAM-${String(index).padStart(2, '0')}`),
        String(camera.name ?? '未命名点位').slice(0, 24),
        String(camera.zone ?? '未分区').slice(0, 32),
        protocol,
        storedUrl,
        sourceFingerprint(protocol, sourceUrl),
        camera.enabled === false ? 0 : 1,
        Number(camera.createdAt) || now(),
        Number(camera.updatedAt) || now(),
      );
    }
    const setupComplete = (legacyData.users ?? []).length > 0 ? '1' : '0';
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('setup_complete', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(setupComplete);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('initialized', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
      is_site_admin INTEGER NOT NULL DEFAULT 0,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      zone TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('none','hls','http','rtsp','edge')),
      source_url TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      site_id TEXT,
      detect_enabled INTEGER NOT NULL DEFAULT 1,
      detect_sensitivity TEXT,
      detect_roi TEXT,
      schedule TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 注意：cameras(site_id) 的索引必须等 migrateSchemaV3 补列后再建。
    -- 旧库（schema v2）没有 site_id 列，此处提前建索引会直接报 no such column。

    CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_source_key
      ON cameras(source_key) WHERE source_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_members (
      user_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      PRIMARY KEY (user_id, site_id)
    );
    CREATE INDEX IF NOT EXISTS idx_site_member_user ON site_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_site_member_site ON site_members(site_id);

    CREATE TABLE IF NOT EXISTS alarms (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      camera_name TEXT NOT NULL,
      zone TEXT NOT NULL,
      site_id TEXT,
      level TEXT NOT NULL CHECK(level IN ('fire','smoke','offline','camera_abnormal')),
      confidence REAL NOT NULL,
      hotspot_x REAL NOT NULL,
      hotspot_y REAL NOT NULL,
      snapshot_file TEXT,
      clip_file TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','confirmed','false','archived')),
      note TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[false,false,false,false]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      false_at INTEGER,
      archived_at INTEGER,
      created_by TEXT,
      updated_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alarm_status_created
      ON alarms(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alarm_camera_status
      ON alarms(camera_id, status, created_at DESC);
    -- 注意：alarms(site_id) 的索引必须等 migrateSchemaV4 重建表后再建，
    -- 旧库（schema v3）的 alarms 没有 site_id 列，此处提前建索引会报 no such column。

    CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_active_camera
      ON alarms(camera_id) WHERE status IN ('pending','confirmed');

    CREATE TABLE IF NOT EXISTS alarm_events (
      id TEXT PRIMARY KEY,
      alarm_id TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alarm_events_alarm
      ON alarm_events(alarm_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT NOT NULL DEFAULT '',
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created
      ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS notify_channels (
      id TEXT PRIMARY KEY,
      site_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('webhook','wecom','dingtalk')),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      template_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notify_site ON notify_channels(site_id);

    CREATE TABLE IF NOT EXISTS notification_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id TEXT PRIMARY KEY,
      alarm_id TEXT,
      channel_id TEXT,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_dedupe
      ON notification_logs(alarm_id, channel_id, event);
    CREATE INDEX IF NOT EXISTS idx_notify_created
      ON notification_logs(created_at DESC);

    ${RECORDING_SEGMENTS_DDL}
    ${AUTH_SESSIONS_DDL}
  `);
}

export function migrateCameraSchemaV2(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE cameras RENAME TO cameras_v1');
    db.exec(`
      CREATE TABLE cameras (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        zone TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK(protocol IN ('none','hls','http','rtsp','edge')),
        source_url TEXT NOT NULL DEFAULT '',
        source_key TEXT,
        site_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO cameras
      (id, code, name, zone, protocol, source_url, source_key, site_id, enabled, created_at, updated_at)
      SELECT id, code, name, zone, protocol, source_url, source_key, NULL, enabled, created_at, updated_at
      FROM cameras_v1;
      DROP TABLE cameras_v1;
      CREATE INDEX IF NOT EXISTS idx_camera_site ON cameras(site_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_source_key
        ON cameras(source_key) WHERE source_key IS NOT NULL;
    `);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

export const DEFAULT_SITE_ID = '00000000-0000-0000-0000-000000000001';

export function migrateSchemaV3(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 3) return;
  const hasSiteColumn = db
    .prepare("PRAGMA table_info(cameras)")
    .all()
    .some((row) => row.name === 'site_id');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasSiteColumn) {
      db.exec('ALTER TABLE cameras ADD COLUMN site_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_camera_site ON cameras(site_id)');
    const exists = db.prepare('SELECT id FROM sites WHERE id = ?').get(DEFAULT_SITE_ID);
    if (!exists) {
      db.prepare('INSERT INTO sites (id, name, code, created_at) VALUES (?, ?, ?, ?)').run(
        DEFAULT_SITE_ID,
        '默认站点',
        'DEFAULT',
        now(),
      );
    }
    db.prepare(
      "UPDATE cameras SET site_id = ? WHERE site_id IS NULL OR site_id = ''",
    ).run(DEFAULT_SITE_ID);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('default_site_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(DEFAULT_SITE_ID);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

export function migrateSchemaV4(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 4) return;

  const alarmColumns = new Set(
    db.prepare('PRAGMA table_info(alarms)').all().map((row) => row.name),
  );
  const cameraColumns = new Set(
    db.prepare('PRAGMA table_info(cameras)').all().map((row) => row.name),
  );
  const clipExpr = alarmColumns.has('clip_file') ? 'a.clip_file' : 'NULL';
  const siteExpr = alarmColumns.has('site_id')
    ? 'COALESCE(a.site_id, c.site_id)'
    : 'c.site_id';

  db.exec('BEGIN IMMEDIATE');
  try {
    // alarms 需要新增 site_id / clip_file，并把 level 约束扩展到 offline。
    // SQLite 无法修改 CHECK，只能重建表；索引会跟随旧表，必须先删后建。
    db.exec('DROP INDEX IF EXISTS idx_alarm_status_created');
    db.exec('DROP INDEX IF EXISTS idx_alarm_camera_status');
    db.exec('DROP INDEX IF EXISTS idx_alarm_active_camera');
    db.exec('DROP INDEX IF EXISTS idx_alarm_site_created');
    db.exec('ALTER TABLE alarms RENAME TO alarms_v3');
    db.exec(`
      CREATE TABLE alarms (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL,
        camera_name TEXT NOT NULL,
        zone TEXT NOT NULL,
        site_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('fire','smoke','offline')),
        confidence REAL NOT NULL,
        hotspot_x REAL NOT NULL,
        hotspot_y REAL NOT NULL,
        snapshot_file TEXT,
        clip_file TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','false','archived')),
        note TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[false,false,false,false]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        false_at INTEGER,
        archived_at INTEGER,
        created_by TEXT,
        updated_by TEXT
      )
    `);
    db.exec(`
      INSERT INTO alarms
      (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
       snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
       confirmed_at, false_at, archived_at, created_by, updated_by)
      SELECT a.id, a.camera_id, a.camera_name, a.zone, ${siteExpr}, a.level, a.confidence,
             a.hotspot_x, a.hotspot_y, a.snapshot_file, ${clipExpr}, a.status, a.note,
             a.steps_json, a.created_at, a.updated_at, a.confirmed_at, a.false_at,
             a.archived_at, a.created_by, a.updated_by
      FROM alarms_v3 a LEFT JOIN cameras c ON c.id = a.camera_id
    `);
    db.exec('DROP TABLE alarms_v3');
    db.exec(`
      CREATE INDEX idx_alarm_status_created ON alarms(status, created_at DESC);
      CREATE INDEX idx_alarm_camera_status ON alarms(camera_id, status, created_at DESC);
      CREATE INDEX idx_alarm_site_created ON alarms(site_id, created_at DESC);
      CREATE UNIQUE INDEX idx_alarm_active_camera
        ON alarms(camera_id) WHERE status IN ('pending','confirmed');
    `);

    if (!cameraColumns.has('detect_enabled')) {
      db.exec('ALTER TABLE cameras ADD COLUMN detect_enabled INTEGER NOT NULL DEFAULT 1');
    }
    if (!cameraColumns.has('detect_sensitivity')) {
      db.exec('ALTER TABLE cameras ADD COLUMN detect_sensitivity TEXT');
    }
    if (!cameraColumns.has('detect_roi')) {
      db.exec('ALTER TABLE cameras ADD COLUMN detect_roi TEXT');
    }

    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notify_channels'").get()) {
      db.exec(`
        CREATE TABLE notify_channels (
          id TEXT PRIMARY KEY,
          site_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('webhook','wecom','dingtalk')),
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          secret TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_notify_site ON notify_channels(site_id);
        CREATE TABLE notification_logs (
          id TEXT PRIMARY KEY,
          alarm_id TEXT,
          channel_id TEXT,
          event TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_notify_dedupe
          ON notification_logs(alarm_id, channel_id, event);
        CREATE INDEX idx_notify_created ON notification_logs(created_at DESC);
      `);
    }

    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

export function migrateSchemaV5(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 5) return;
  const userColumns = new Set(
    db.prepare('PRAGMA table_info(users)').all().map((row) => row.name),
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!userColumns.has('is_site_admin')) {
      db.exec('ALTER TABLE users ADD COLUMN is_site_admin INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

/**
 * 内置通知模板定义（单一来源）。
 *
 * 迁移与恢复脚本共用这一份，避免内容漂移。INSERT OR IGNORE 语义保证
 * 不会覆盖用户已改过的同名模板。
 */
export const BUILTIN_TEMPLATES = Object.freeze([
  {
    id: 'builtin-default',
    name: '标准告警（默认）',
    body:
      '【{level}】{site} / {camera}（{zone}）\n识别：{level} · 置信度 {confidence}%\n时间：{time}\n请立即登录平台核实处置，处置入口：{link}',
  },
  {
    id: 'builtin-concise',
    name: '精简告警',
    body: '{time} {site}/{camera} 触发{level}（{confidence}%），请尽快核实：{link}',
  },
]);

/**
 * 幂等补种内置模板（供 V6 迁移与恢复脚本共用）。
 * @param {import('node:sqlite').DatabaseSync} db 已打开且表存在的数据库。
 * @returns {number} 实际新增条数。
 */
export function seedBuiltinTemplates(db) {
  const ts = now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notification_templates
     (id, name, body, builtin, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  let inserted = 0;
  for (const tpl of BUILTIN_TEMPLATES) {
    inserted += insert.run(tpl.id, tpl.name, tpl.body, ts, ts).changes;
  }
  return inserted;
}

export function migrateSchemaV6(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 6) return;
  const channelColumns = new Set(
    db.prepare('PRAGMA table_info(notify_channels)').all().map((row) => row.name),
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!channelColumns.has('template_id')) {
      db.exec('ALTER TABLE notify_channels ADD COLUMN template_id TEXT');
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS notification_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    // 内置模板仅首次迁移时写入（INSERT OR IGNORE 保证重复迁移不覆盖用户改动）。
    seedBuiltinTemplates(db);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '6') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

export function ensureDefaultSite(db) {
  // 此时 site_id 列已由 createSchema（新库）或 migrateSchemaV3/V4（旧库）保证存在。
  db.exec('CREATE INDEX IF NOT EXISTS idx_camera_site ON cameras(site_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alarm_site_created ON alarms(site_id, created_at DESC)');
  if (!db.prepare('SELECT id FROM sites WHERE id = ?').get(DEFAULT_SITE_ID)) {
    db.prepare('INSERT INTO sites (id, name, code, created_at) VALUES (?, ?, ?, ?)').run(
      DEFAULT_SITE_ID,
      '默认站点',
      'DEFAULT',
      now(),
    );
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('default_site_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(DEFAULT_SITE_ID);
  }
  // 迁移或手动清空后，任何未归属站点的摄像头统一归入默认站点，避免不可见。
  db.prepare("UPDATE cameras SET site_id = ? WHERE site_id IS NULL OR site_id = ''").run(
    DEFAULT_SITE_ID,
  );
}

/**
 * V7：alarms.level 约束扩展 camera_abnormal（画面异常告警）；cameras 增加 schedule（布防时间表）。
 * SQLite 无法修改 CHECK，只能重建表；索引跟随旧表，必须先删后建。
 */
export function migrateSchemaV7(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 7) return;
  const cameraColumns = new Set(
    db.prepare('PRAGMA table_info(cameras)').all().map((row) => row.name),
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!cameraColumns.has('schedule')) {
      db.exec('ALTER TABLE cameras ADD COLUMN schedule TEXT');
    }
    db.exec('DROP INDEX IF EXISTS idx_alarm_status_created');
    db.exec('DROP INDEX IF EXISTS idx_alarm_camera_status');
    db.exec('DROP INDEX IF EXISTS idx_alarm_active_camera');
    db.exec('DROP INDEX IF EXISTS idx_alarm_site_created');
    db.exec('ALTER TABLE alarms RENAME TO alarms_v6');
    db.exec(`
      CREATE TABLE alarms (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL,
        camera_name TEXT NOT NULL,
        zone TEXT NOT NULL,
        site_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('fire','smoke','offline','camera_abnormal')),
        confidence REAL NOT NULL,
        hotspot_x REAL NOT NULL,
        hotspot_y REAL NOT NULL,
        snapshot_file TEXT,
        clip_file TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','false','archived')),
        note TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[false,false,false,false]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        false_at INTEGER,
        archived_at INTEGER,
        created_by TEXT,
        updated_by TEXT
      )
    `);
    db.exec(`
      INSERT INTO alarms
      (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
       snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
       confirmed_at, false_at, archived_at, created_by, updated_by)
      SELECT id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
             snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
             confirmed_at, false_at, archived_at, created_by, updated_by
      FROM alarms_v6
    `);
    db.exec('DROP TABLE alarms_v6');
    db.exec(`
      CREATE INDEX idx_alarm_status_created ON alarms(status, created_at DESC);
      CREATE INDEX idx_alarm_camera_status ON alarms(camera_id, status, created_at DESC);
      CREATE INDEX idx_alarm_site_created ON alarms(site_id, created_at DESC);
      CREATE UNIQUE INDEX idx_alarm_active_camera
        ON alarms(camera_id) WHERE status IN ('pending','confirmed');
    `);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '7') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

/**
 * V8：持续录像分段索引。仅新增表与索引，不动既有业务表；
 * 与 createSchema 共用同一段 DDL，保证新库与升级库结构一致。
 *
 * 注意：录像段文件放在 data/continuous/（独立目录），
 * 不与 data/recordings/ 下的告警短视频 mp4 混放，避免被现有水位扫描误清理。
 */
export function migrateSchemaV8(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 8) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(RECORDING_SEGMENTS_DDL);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '8') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

/**
 * V9：补齐关键性能索引。只执行 CREATE INDEX（不改表结构、不删数据），
 * 与 createSchema 共用 PERFORMANCE_INDEXES_DDL，保证新库与升级库结构一致。
 * 存量 V8 库在此处完成索引补建；全新库由 createSchema 直接建好并跳过本迁移。
 */
export function migrateSchemaV9(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 9) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // 索引必须在 V4/V7 之后建：那时 alarms 才有 clip_file / site_id 列。
    ensurePerformanceIndexes(db);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}

/**
 * V10：新增 auth_sessions 表（服务端会话登记）。
 *
 * 目的：让「登出」只撤销当前会话，而不是像改造前那样通过 users.token_version
 * 把该账号所有设备/标签页的令牌一起作废。
 *
 * 表结构说明：
 *   - sid：会话 ID（UUID），主键，与令牌载荷中的 sid 对应。
 *   - user_id：所属账号。
 *   - revoked_at：撤销时间；非空即表示已撤销。
 *   - expires_at：过期时间；清理任务据此回收过期行。
 *
 * 兼容性：这是**纯新增表**，不改 users 表结构、不影响既有列，
 * 因此升级无需停机、不会丢失任何数据。
 */
export function migrateSchemaV10(db) {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  if (version >= 10) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(AUTH_SESSIONS_DDL);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite 可能已自动回滚；吞掉 ROLLBACK 失败才能抛出真实的迁移错误。
    }
    throw error;
  }
}


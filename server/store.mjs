import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 5;

function now() {
  return Date.now();
}

function bool(value) {
  return Boolean(value);
}

function jsonSteps(value) {
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

function sourceFingerprint(protocol, sourceUrl) {
  const normalized = normalizeSourceForFingerprint(protocol, sourceUrl);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function migrateLegacy(db, secretBox, legacyData) {
  const hasLegacy =
    legacyData &&
    ((Array.isArray(legacyData.users) && legacyData.users.length > 0) ||
      (Array.isArray(legacyData.cameras) && legacyData.cameras.length > 0));
  if (!hasLegacy) {
    db.prepare("INSERT INTO meta(key, value) VALUES('setup_complete', '0')").run();
    db.prepare("INSERT INTO meta(key, value) VALUES('initialized', '1')").run();
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
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
    db.exec('ROLLBACK');
    throw error;
  }
}

function createSchema(db) {
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notify_site ON notify_channels(site_id);

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
  `);
}

function migrateCameraSchemaV2(db) {
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
    db.exec('ROLLBACK');
    throw error;
  }
}

const DEFAULT_SITE_ID = '00000000-0000-0000-0000-000000000001';

function migrateSchemaV3(db) {
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
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateSchemaV4(db) {
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
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateSchemaV5(db) {
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
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureDefaultSite(db) {
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

/** 屏蔽区一律按 0-100 的百分比矩形存储，最多 8 个。 */
export function parseRoi(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((rect) =>
      rect && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(rect[key]))),
    )
    .slice(0, 8)
    .map((rect) => ({
      x: Math.min(100, Math.max(0, Number(rect.x))),
      y: Math.min(100, Math.max(0, Number(rect.y))),
      w: Math.min(100, Math.max(0, Number(rect.w))),
      h: Math.min(100, Math.max(0, Number(rect.h))),
    }));
}

function serializeRoi(roi) {
  const list = parseRoi(Array.isArray(roi) ? JSON.stringify(roi) : roi);
  return list.length ? JSON.stringify(list) : null;
}

function cameraRowToObject(row, secretBox) {
  if (!row) return null;
  let sourceUrl = row.source_url ?? '';
  if (row.protocol === 'rtsp' && sourceUrl.startsWith('enc:v1:')) {
    sourceUrl = secretBox.decrypt(sourceUrl);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    zone: row.zone,
    protocol: row.protocol,
    sourceUrl,
    sourceKey: row.source_key,
    siteId: row.site_id ?? null,
    detectEnabled: row.detect_enabled === undefined ? true : bool(row.detect_enabled),
    detectSensitivity: row.detect_sensitivity ?? null,
    detectRoi: parseRoi(row.detect_roi),
    enabled: bool(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    siteAdmin: bool(row.is_site_admin),
    salt: row.salt,
    passwordHash: row.password_hash,
    disabled: bool(row.disabled),
    tokenVersion: row.token_version,
    createdAt: row.created_at,
  };
}

function alarmRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    cameraId: row.camera_id,
    cameraName: row.camera_name,
    zone: row.zone,
    siteId: row.site_id ?? null,
    level: row.level,
    confidence: row.confidence,
    hotspot: { x: row.hotspot_x, y: row.hotspot_y },
    snapshot: row.snapshot_file ? `/api/alarms/${row.id}/snapshot` : null,
    snapshotFile: row.snapshot_file,
    clip: row.clip_file ? `/api/alarms/${row.id}/clip` : null,
    clipFile: row.clip_file,
    status: row.status,
    note: row.note,
    steps: jsonSteps(row.steps_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    falseAt: row.false_at,
    archivedAt: row.archived_at,
    closedAt: row.archived_at ?? row.false_at ?? null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

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

  listUsers() {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all()
      .map(userRowToObject);
  }

  getUser(id) {
    return userRowToObject(
      this.db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    );
  }

  getUserByUsername(username) {
    return userRowToObject(
      this.db
        .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
        .get(username),
    );
  }

  countActiveAdmins() {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
        )
        .get().count,
    );
  }

  createUser(user) {
    this.db
      .prepare(`
        INSERT INTO users
        (id, username, display_name, role, is_site_admin, salt, password_hash,
         disabled, token_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        user.id,
        user.username,
        user.displayName,
        user.role,
        user.siteAdmin ? 1 : 0,
        user.salt,
        user.passwordHash,
        user.disabled ? 1 : 0,
        Number(user.tokenVersion) || 0,
        user.createdAt ?? now(),
      );
    return this.getUser(user.id);
  }

  updateUser(id, changes) {
    const user = this.getUser(id);
    if (!user) return null;
    const sets = [];
    const values = [];
    if (changes.displayName !== undefined) {
      sets.push('display_name = ?');
      values.push(changes.displayName);
    }
    if (changes.role !== undefined) {
      sets.push('role = ?');
      values.push(changes.role);
    }
    if (changes.disabled !== undefined) {
      sets.push('disabled = ?');
      values.push(changes.disabled ? 1 : 0);
    }
    if (changes.siteAdmin !== undefined) {
      sets.push('is_site_admin = ?');
      values.push(changes.siteAdmin ? 1 : 0);
    }
    if (changes.passwordHash !== undefined && changes.salt !== undefined) {
      sets.push('password_hash = ?', 'salt = ?', 'token_version = token_version + 1');
      values.push(changes.passwordHash, changes.salt);
    } else if (
      changes.role !== undefined ||
      changes.disabled === true ||
      changes.siteAdmin !== undefined
    ) {
      sets.push('token_version = token_version + 1');
    }
    if (!sets.length) return user;
    values.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getUser(id);
  }

  deleteUser(id) {
    this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(id);
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }

  get defaultSiteId() {
    return this.getMeta('default_site_id', DEFAULT_SITE_ID);
  }

  listSites() {
    return this.db
      .prepare('SELECT * FROM sites ORDER BY created_at ASC')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        createdAt: row.created_at,
      }));
  }

  getSite(id) {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, name: row.name, code: row.code, createdAt: row.created_at };
  }

  createSite({ id, name, code, createdAt }) {
    this.db
      .prepare('INSERT INTO sites (id, name, code, created_at) VALUES (?, ?, ?, ?)')
      .run(id ?? crypto.randomUUID(), name, code, createdAt ?? now());
    return this.getSite(id ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  updateSite(id, { name } = {}) {
    if (name !== undefined) {
      this.db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id);
    }
    return this.getSite(id);
  }

  countCamerasBySite(siteId) {
    return Number(
      this.db.prepare('SELECT COUNT(*) AS count FROM cameras WHERE site_id = ?').get(siteId)
        .count,
    );
  }

  deleteSite(id) {
    if (id === this.defaultSiteId) {
      const error = new Error('默认站点不可删除');
      error.code = 'SITE_DEFAULT';
      throw error;
    }
    if (this.countCamerasBySite(id) > 0) {
      const error = new Error('请先将站点下的点位移动到其他站点或默认站点');
      error.code = 'SITE_HAS_CAMERAS';
      throw error;
    }
    return this.transaction(() => {
      this.db.prepare('DELETE FROM site_members WHERE site_id = ?').run(id);
      return this.db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
    });
  }

  siteMemberSiteIds(userId) {
    return this.db
      .prepare('SELECT site_id FROM site_members WHERE user_id = ?')
      .all(userId)
      .map((row) => row.site_id);
  }

  /** 站点管理员可管理的站点；普通用户返回空数组。 */
  adminSiteIds(userId) {
    const user = this.getUser(userId);
    if (!user?.siteAdmin) return [];
    return this.siteMemberSiteIds(userId);
  }

  setUserSites(userId, siteIds) {
    const unique = [...new Set(siteIds.map(String).filter(Boolean))];
    this.transaction(() => {
      this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(userId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO site_members (user_id, site_id) VALUES (?, ?)',
      );
      for (const siteId of unique) insert.run(userId, siteId);
    });
    return this.siteMemberSiteIds(userId);
  }

  listCameras({ siteId = null, allowedSiteIds = null } = {}) {
    const clauses = [];
    const values = [];
    if (allowedSiteIds !== null) {
      if (allowedSiteIds.length === 0) {
        return [];
      }
      clauses.push(`site_id IN (${allowedSiteIds.map(() => '?').join(',')})`);
      values.push(...allowedSiteIds);
    }
    if (siteId) {
      clauses.push('site_id = ?');
      values.push(siteId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM cameras ${where} ORDER BY created_at ASC`)
      .all(...values)
      .map((row) => cameraRowToObject(row, this.secretBox));
  }

  getCamera(id) {
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id),
      this.secretBox,
    );
  }

  cameraBySourceKey(sourceKey) {
    if (!sourceKey) return null;
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE source_key = ?').get(sourceKey),
      this.secretBox,
    );
  }

  nextCameraCode() {
    const codes = this.db.prepare('SELECT code FROM cameras').all();
    const numeric = codes
      .map((row) => Number(String(row.code).replace(/\D/g, '')))
      .filter((value) => Number.isFinite(value));
    return `CAM-${String((numeric.length ? Math.max(...numeric) : 0) + 1).padStart(2, '0')}`;
  }

  insertCamera(camera) {
    const storedUrl =
      camera.protocol === 'rtsp' && camera.sourceUrl
        ? this.secretBox.encrypt(camera.sourceUrl)
        : camera.sourceUrl;
    const key = sourceFingerprint(camera.protocol, camera.sourceUrl);
    const timestamp = camera.createdAt ?? now();
    const siteId = camera.siteId || this.defaultSiteId;
    this.db
      .prepare(`
        INSERT INTO cameras
        (id, code, name, zone, protocol, source_url, source_key, site_id,
         detect_enabled, detect_sensitivity, detect_roi, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        camera.id,
        camera.code,
        camera.name,
        camera.zone,
        camera.protocol,
        storedUrl,
        key,
        siteId,
        camera.detectEnabled === false ? 0 : 1,
        camera.detectSensitivity ?? null,
        serializeRoi(camera.detectRoi ?? null),
        camera.enabled === false ? 0 : 1,
        timestamp,
        camera.updatedAt ?? timestamp,
      );
    return this.getCamera(camera.id);
  }

  createCamera(camera) {
    const key = sourceFingerprint(camera.protocol, camera.sourceUrl);
    if (key && this.cameraBySourceKey(key)) {
      const error = new Error('相同视频流地址的点位已存在');
      error.code = 'DUPLICATE_SOURCE';
      throw error;
    }
    return this.transaction(() =>
      this.insertCamera({
        ...camera,
        id: camera.id ?? crypto.randomUUID(),
        code: camera.code ?? this.nextCameraCode(),
      }),
    );
  }

  updateCamera(id, changes) {
    const current = this.getCamera(id);
    if (!current) return null;
    const next = {
      ...current,
      ...changes,
      updatedAt: now(),
    };
    const key = sourceFingerprint(next.protocol, next.sourceUrl);
    if (key) {
      const duplicate = this.cameraBySourceKey(key);
      if (duplicate && duplicate.id !== id) {
        const error = new Error('相同视频流地址的点位已存在');
        error.code = 'DUPLICATE_SOURCE';
        throw error;
      }
    }
    const storedUrl =
      next.protocol === 'rtsp' && next.sourceUrl
        ? this.secretBox.encrypt(next.sourceUrl)
        : next.sourceUrl;
    const siteId = next.siteId || this.defaultSiteId;
    this.db
      .prepare(`
        UPDATE cameras SET
          name = ?, zone = ?, protocol = ?, source_url = ?, source_key = ?,
          site_id = ?, detect_enabled = ?, detect_sensitivity = ?, detect_roi = ?,
          enabled = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.zone,
        next.protocol,
        storedUrl,
        key,
        siteId,
        next.detectEnabled === false ? 0 : 1,
        next.detectSensitivity ?? null,
        serializeRoi(next.detectRoi ?? null),
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return this.getCamera(id);
  }

  deleteCamera(id) {
    return this.db.prepare('DELETE FROM cameras WHERE id = ?').run(id).changes > 0;
  }

  importCameras(items) {
    return this.transaction(() => {
      const created = [];
      let skipped = 0;
      for (const item of items) {
        const key = sourceFingerprint(item.protocol, item.sourceUrl);
        if (key && this.cameraBySourceKey(key)) {
          skipped += 1;
          continue;
        }
        const camera = this.insertCamera({
          ...item,
          id: crypto.randomUUID(),
          code: this.nextCameraCode(),
          createdAt: now(),
          updatedAt: now(),
        });
        created.push(camera);
      }
      return { created, skipped };
    });
  }

  listAlarms(limit = 300, { allowedSiteIds = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    if (allowedSiteIds !== null && allowedSiteIds.length === 0) {
      return [];
    }
    // 直接按告警自身的 site_id 过滤：删除点位后历史告警仍可见，也不再依赖 JOIN。
    const where = allowedSiteIds
      ? 'WHERE a.site_id IN (' + allowedSiteIds.map(() => '?').join(',') + ')'
      : '';
    const params = allowedSiteIds ? [...allowedSiteIds, safeLimit] : [safeLimit];
    return this.db
      .prepare(
        `SELECT a.* FROM alarms a ${where} ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...params)
      .map(alarmRowToObject);
  }

  getAlarm(id) {
    return alarmRowToObject(
      this.db.prepare('SELECT * FROM alarms WHERE id = ?').get(id),
    );
  }

  activeAlarmForCamera(cameraId) {
    return alarmRowToObject(
      this.db
        .prepare(
          "SELECT * FROM alarms WHERE camera_id = ? AND status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 1",
        )
        .get(cameraId),
    );
  }

  /** 超过指定时间仍未确认的告警，用于升级提醒。 */
  listPendingAlarmsOlderThan(cutoff, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return this.db
      .prepare(
        "SELECT * FROM alarms WHERE status = 'pending' AND created_at <= ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(cutoff, safeLimit)
      .map(alarmRowToObject);
  }

  hasAlarmEvent(alarmId, action) {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS ok FROM alarm_events WHERE alarm_id = ? AND action = ? LIMIT 1',
        )
        .get(alarmId, action),
    );
  }

  /** 按站点/级别/状态聚合时间段内的告警数量，供每日摘要使用。 */
  alarmStatsBetween(start, end) {
    return this.db
      .prepare(`
        SELECT site_id AS siteId, level, status, COUNT(*) AS count
        FROM alarms
        WHERE created_at >= ? AND created_at < ?
        GROUP BY site_id, level, status
      `)
      .all(start, end);
  }

  /** 按上海时区按天聚合告警（含空缺的日期无行），供趋势看板使用。 */
  alarmStatsByDay({ days = 30, siteIds = null, endAt = now() } = {}) {
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 366);
    const endShanghai = new Date(endAt + 8 * 3600 * 1000);
    const lastDayUtc = Date.UTC(
      endShanghai.getUTCFullYear(),
      endShanghai.getUTCMonth(),
      endShanghai.getUTCDate(),
    );
    const firstDayUtc = lastDayUtc - (safeDays - 1) * 86_400_000;
    const start = firstDayUtc - 8 * 3600 * 1000;
    const end = lastDayUtc + 86_400_000 - 8 * 3600 * 1000;
    const clauses = ['created_at >= ?', 'created_at < ?'];
    const values = [start, end];
    if (siteIds !== null) {
      if (!siteIds.length) return [];
      const placeholders = siteIds.map(() => '?').join(',');
      clauses.push(`COALESCE(site_id, ?) IN (${placeholders})`);
      values.push(this.defaultSiteId, ...siteIds);
    }
    return this.db
      .prepare(`
        SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day,
               COALESCE(site_id, ?) AS siteId, level, status, COUNT(*) AS count
        FROM alarms
        WHERE ${clauses.join(' AND ')}
        GROUP BY day, siteId, level, status
        ORDER BY day ASC
      `)
      .all(this.defaultSiteId, ...values);
  }

  createAlarm(alarm) {
    const timestamp = alarm.createdAt ?? now();
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO alarms
          (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
           snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
           created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?, ?)
        `)
        .run(
          alarm.id,
          alarm.cameraId,
          alarm.cameraName,
          alarm.zone,
          alarm.siteId ?? null,
          alarm.level,
          alarm.confidence,
          alarm.hotspot.x,
          alarm.hotspot.y,
          alarm.snapshotFile ?? null,
          alarm.clipFile ?? null,
          JSON.stringify(alarm.steps ?? [false, false, false, false]),
          timestamp,
          timestamp,
          alarm.actor?.id ?? null,
          alarm.actor?.id ?? null,
        );
      this.addAlarmEvent(
        alarm.id,
        alarm.actor,
        'created',
        alarm.eventDetail ?? '识别引擎生成告警',
      );
    });
    return this.getAlarm(alarm.id);
  }

  updateAlarm(id, changes, actor) {
    const current = this.getAlarm(id);
    if (!current) return null;
    const fields = ['updated_at = ?'];
    const values = [now()];
    if (changes.status !== undefined) {
      fields.push('status = ?');
      values.push(changes.status);
    }
    if (changes.note !== undefined) {
      fields.push('note = ?');
      values.push(changes.note);
    }
    if (changes.steps !== undefined) {
      fields.push('steps_json = ?');
      values.push(JSON.stringify(changes.steps));
    }
    if (changes.confirmedAt !== undefined) {
      fields.push('confirmed_at = ?');
      values.push(changes.confirmedAt);
    }
    if (changes.falseAt !== undefined) {
      fields.push('false_at = ?');
      values.push(changes.falseAt);
    }
    if (changes.archivedAt !== undefined) {
      fields.push('archived_at = ?');
      values.push(changes.archivedAt);
    }
    fields.push('updated_by = ?');
    values.push(actor?.id ?? null);
    values.push(id);
    this.db
      .prepare(`UPDATE alarms SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
    return this.getAlarm(id);
  }

  setAlarmClip(id, clipFile) {
    this.db
      .prepare('UPDATE alarms SET clip_file = ?, updated_at = ? WHERE id = ?')
      .run(clipFile ?? null, now(), id);
    return this.getAlarm(id);
  }

  addAlarmEvent(alarmId, actor, action, detail = '') {
    this.db
      .prepare(`
        INSERT INTO alarm_events (id, alarm_id, user_id, username, action, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        alarmId,
        actor?.id ?? null,
        actor?.username ?? null,
        action,
        String(detail).slice(0, 500),
        now(),
      );
  }

  listAlarmEvents(alarmId) {
    return this.db
      .prepare(
        'SELECT * FROM alarm_events WHERE alarm_id = ? ORDER BY created_at ASC',
      )
      .all(alarmId);
  }

  notifyChannelRowToObject(row) {
    if (!row) return null;
    const decode = (value) => {
      if (!value) return '';
      if (!value.startsWith('enc:v1:')) return value;
      try {
        return this.secretBox.decrypt(value);
      } catch {
        return '';
      }
    };
    return {
      id: row.id,
      siteId: row.site_id ?? null,
      kind: row.kind,
      name: row.name,
      url: decode(row.url),
      secret: row.secret ? decode(row.secret) : '',
      enabled: bool(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listNotifyChannels() {
    return this.db
      .prepare('SELECT * FROM notify_channels ORDER BY created_at ASC')
      .all()
      .map((row) => this.notifyChannelRowToObject(row));
  }

  getNotifyChannel(id) {
    return this.notifyChannelRowToObject(
      this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id),
    );
  }

  createNotifyChannel(channel) {
    const id = channel.id ?? crypto.randomUUID();
    const timestamp = channel.createdAt ?? now();
    this.db
      .prepare(`
        INSERT INTO notify_channels
        (id, site_id, kind, name, url, secret, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        channel.siteId || null,
        channel.kind,
        channel.name,
        this.secretBox.encrypt(channel.url),
        channel.secret ? this.secretBox.encrypt(channel.secret) : null,
        channel.enabled === false ? 0 : 1,
        timestamp,
        timestamp,
      );
    return this.getNotifyChannel(id);
  }

  updateNotifyChannel(id, changes = {}) {
    const current = this.getNotifyChannel(id);
    if (!current) return null;
    const sets = ['updated_at = ?'];
    const values = [now()];
    if (changes.name !== undefined) {
      sets.push('name = ?');
      values.push(changes.name);
    }
    if (changes.kind !== undefined) {
      sets.push('kind = ?');
      values.push(changes.kind);
    }
    if (changes.siteId !== undefined) {
      sets.push('site_id = ?');
      values.push(changes.siteId || null);
    }
    if (changes.url !== undefined) {
      sets.push('url = ?');
      values.push(this.secretBox.encrypt(changes.url));
    }
    if (changes.secret !== undefined) {
      sets.push('secret = ?');
      values.push(changes.secret ? this.secretBox.encrypt(changes.secret) : null);
    }
    if (changes.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(changes.enabled ? 1 : 0);
    }
    values.push(id);
    this.db.prepare(`UPDATE notify_channels SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getNotifyChannel(id);
  }

  deleteNotifyChannel(id) {
    this.db.prepare('DELETE FROM notification_logs WHERE channel_id = ?').run(id);
    return this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes > 0;
  }

  /** 站点渠道 + 全局渠道（site_id IS NULL）。 */
  channelsForSite(siteId) {
    const rows = siteId
      ? this.db
          .prepare(
            'SELECT * FROM notify_channels WHERE enabled = 1 AND (site_id = ? OR site_id IS NULL) ORDER BY created_at ASC',
          )
          .all(siteId)
      : this.db
          .prepare('SELECT * FROM notify_channels WHERE enabled = 1 AND site_id IS NULL ORDER BY created_at ASC')
          .all();
    return rows.map((row) => this.notifyChannelRowToObject(row));
  }

  /** 抢占一次推送（唯一索引去重）：返回 true 表示本次应发送。 */
  claimNotification(alarmId, channelId, event) {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO notification_logs
        (id, alarm_id, channel_id, event, status, error, created_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?)
      `)
      .run(crypto.randomUUID(), alarmId, channelId, event, now());
    return result.changes > 0;
  }

  finishNotification(alarmId, channelId, event, { status, error = null }) {
    this.db
      .prepare(`
        UPDATE notification_logs SET status = ?, error = ?
        WHERE alarm_id = ? AND channel_id = ? AND event = ?
      `)
      .run(status, error ? String(error).slice(0, 500) : null, alarmId, channelId, event);
  }

  /** 某渠道自 sinceTs 以来连续失败的次数（遇到一次成功即停止计数）。 */
  consecutiveFailures(channelId, sinceTs = 0, limit = 32) {
    const rows = this.db
      .prepare(`
        SELECT status FROM notification_logs
        WHERE channel_id = ? AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(channelId, sinceTs, limit);
    let count = 0;
    for (const row of rows) {
      if (row.status !== 'failed') break;
      count += 1;
    }
    return count;
  }

  listNotificationLogs(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return this.db
      .prepare(`
        SELECT l.*, c.name AS channel_name, c.kind AS channel_kind
        FROM notification_logs l
        LEFT JOIN notify_channels c ON c.id = l.channel_id
        ORDER BY l.created_at DESC LIMIT ?
      `)
      .all(safeLimit)
      .map((row) => ({
        id: row.id,
        alarmId: row.alarm_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelKind: row.channel_kind,
        event: row.event,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
      }));
  }

  pruneNotificationLogs(retainDays = 30) {
    const cutoff = now() - retainDays * 24 * 60 * 60 * 1000;
    return Number(
      this.db.prepare('DELETE FROM notification_logs WHERE created_at < ?').run(cutoff)
        .changes,
    );
  }

  /** 清理超期的已关闭告警，返回需要删除的媒体文件名。 */
  pruneAlarms({ retainDays = 180, at = now() } = {}) {
    const cutoff = at - retainDays * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(`
        SELECT id, snapshot_file, clip_file FROM alarms
        WHERE created_at < ? AND status IN ('archived','false')
        LIMIT 5000
      `)
      .all(cutoff);
    if (!rows.length) return { deleted: 0, snapshots: [], clips: [] };
    const remove = this.db.prepare('DELETE FROM alarms WHERE id = ?');
    this.transaction(() => {
      for (const row of rows) remove.run(row.id);
    });
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
    };
  }

  /**
   * 演示数据清理：删除演示点位产生的告警及其事件、推送日志与媒体文件引用。
   * 口径为「camera_id 命中历史演示点位」或「camera_name 等于演示点位名」双取，
   * 避免演示点位删除后（camera_id 变孤儿）漏清；真实告警不受影响。
   * 审计日志保留（操作留痕不因清理而消失）。调用方负责删物理媒体文件。
   */
  purgeDemoAlarms({ cameraIds = [], cameraName = '' } = {}) {
    const ids = [...new Set(cameraIds.filter((id) => typeof id === 'string' && id))];
    const where = [];
    const params = [];
    if (ids.length) {
      where.push(`camera_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (cameraName) {
      where.push('camera_name = ?');
      params.push(cameraName);
    }
    if (!where.length) return { deleted: 0, snapshots: [], clips: [], notifications: 0, events: 0 };
    const rows = this.db
      .prepare(
        `SELECT id, snapshot_file, clip_file FROM alarms WHERE ${where.join(' OR ')}`,
      )
      .all(...params);
    if (!rows.length) {
      return { deleted: 0, snapshots: [], clips: [], notifications: 0, events: 0 };
    }
    const alarmIds = rows.map((row) => row.id);
    const placeholders = alarmIds.map(() => '?').join(',');
    const removeAlarm = this.db.prepare('DELETE FROM alarms WHERE id = ?');
    const removeEvents = this.db.prepare(
      `DELETE FROM alarm_events WHERE alarm_id IN (${placeholders})`,
    );
    const removeNotifications = this.db.prepare(
      `DELETE FROM notification_logs WHERE alarm_id IN (${placeholders})`,
    );
    let events = 0;
    let notifications = 0;
    this.transaction(() => {
      events = removeEvents.run(...alarmIds).changes;
      notifications = removeNotifications.run(...alarmIds).changes;
      for (const id of alarmIds) removeAlarm.run(id);
    });
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
      notifications,
      events,
    };
  }

  /** 统计演示告警数量与媒体文件数，供前端按钮展示「将清除什么」。 */
  countDemoAlarms({ cameraIds = [], cameraName = '' } = {}) {
    const ids = [...new Set(cameraIds.filter((id) => typeof id === 'string' && id))];
    const where = [];
    const params = [];
    if (ids.length) {
      where.push(`camera_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (cameraName) {
      where.push('camera_name = ?');
      params.push(cameraName);
    }
    if (!where.length) return { alarms: 0, snapshots: 0, clips: 0 };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS alarms,
                SUM(CASE WHEN snapshot_file IS NOT NULL THEN 1 ELSE 0 END) AS snapshots,
                SUM(CASE WHEN clip_file IS NOT NULL THEN 1 ELSE 0 END) AS clips
         FROM alarms WHERE ${where.join(' OR ')}`,
      )
      .get(...params);
    return {
      alarms: Number(row?.alarms ?? 0),
      snapshots: Number(row?.snapshots ?? 0),
      clips: Number(row?.clips ?? 0),
    };
  }

  /**
   * 磁盘水位：从最老的已关闭告警开始清掉媒体文件（保留告警记录本身），
   * 返回被清空的文件名，调用方负责删除物理文件。
   */
  clearOldestAlarmMedia(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const rows = this.db
      .prepare(`
        SELECT id, snapshot_file, clip_file FROM alarms
        WHERE status IN ('archived','false')
          AND (snapshot_file IS NOT NULL OR clip_file IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(safeLimit);
    if (!rows.length) return { alarms: 0, files: [] };
    const timestamp = now();
    const clear = this.db.prepare(
      'UPDATE alarms SET snapshot_file = NULL, clip_file = NULL, updated_at = ? WHERE id = ?',
    );
    const files = [];
    this.transaction(() => {
      for (const row of rows) {
        clear.run(timestamp, row.id);
        if (row.snapshot_file) files.push(row.snapshot_file);
        if (row.clip_file) files.push(row.clip_file);
      }
    });
    return { alarms: rows.length, files };
  }

  recordAudit({ user, action, targetType = null, targetId = null, detail = '', ip = '' }) {
    this.db
      .prepare(`
        INSERT INTO audit_logs
        (id, user_id, username, action, target_type, target_id, detail, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        user?.id ?? null,
        user?.username ?? null,
        action,
        targetType,
        targetId,
        String(detail).slice(0, 1000),
        ip,
        now(),
      );
  }

  listAudit(limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit);
  }

  /**
   * 审计日志筛选查询（审计界面用）。
   * action 支持前缀匹配（如 'camera' 命中 camera.create/update/delete/test/import）；
   * q 匹配 username/detail/target_id；from/to 为毫秒时间戳（含头含尾）。
   */
  listAuditFiltered({
    limit = 50,
    offset = 0,
    action = '',
    q = '',
    from = null,
    to = null,
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), 1_000_000);
    const where = [];
    const params = [];
    const actionKey = String(action ?? '').trim();
    if (actionKey) {
      where.push('action LIKE ?');
      params.push(`${actionKey}%`);
    }
    const keyword = String(q ?? '').trim().slice(0, 64);
    if (keyword) {
      where.push('(username LIKE ? OR detail LIKE ? OR target_id LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (Number.isFinite(from)) {
      where.push('created_at >= ?');
      params.push(Number(from));
    }
    if (Number.isFinite(to)) {
      where.push('created_at <= ?');
      params.push(Number(to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, safeOffset);
  }

  countAuditFiltered({ action = '', q = '', from = null, to = null } = {}) {
    const where = [];
    const params = [];
    const actionKey = String(action ?? '').trim();
    if (actionKey) {
      where.push('action LIKE ?');
      params.push(`${actionKey}%`);
    }
    const keyword = String(q ?? '').trim().slice(0, 64);
    if (keyword) {
      where.push('(username LIKE ? OR detail LIKE ? OR target_id LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (Number.isFinite(from)) {
      where.push('created_at >= ?');
      params.push(Number(from));
    }
    if (Number.isFinite(to)) {
      where.push('created_at <= ?');
      params.push(Number(to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_logs ${clause}`)
      .get(...params);
    return Number(row?.total ?? 0);
  }

  pruneAuditLogs(retain = 20_000) {
    const safeRetain = Math.min(Math.max(Number(retain) || 20_000, 1000), 100_000);
    const result = this.db
      .prepare(`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?
        )
      `)
      .run(safeRetain);
    return Number(result.changes);
  }

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

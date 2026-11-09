import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from './secrets.mjs';
import { openStore, backupCorruptFiles, isDatabaseCorruptionError } from './store.mjs';
import { SCHEMA_VERSION, migrateLegacy } from './schema.mjs';

function box() {
  return new SecretBox(crypto.randomBytes(32));
}

test('migrateLegacy 对已存在的 meta 键可重入（初始化中断后可恢复）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT INTO meta(key, value) VALUES('setup_complete', '0')").run();
  assert.doesNotThrow(() => migrateLegacy(db, box(), null));
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    String(SCHEMA_VERSION),
  );
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = 'initialized'").get().value,
    '1',
  );
  db.close();
});

test('legacy data migrates and RTSP credentials are encrypted at rest', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  const secretBox = box();
  const password = 'super-secret-rtsp-password';
  const store = await openStore({
    dataDir,
    secretBox,
    legacyData: {
      users: [
        {
          id: 'u1',
          username: 'admin',
          displayName: 'Admin',
          role: 'admin',
          salt: 'salt',
          passwordHash: 'hash',
          createdAt: 1,
        },
      ],
      cameras: [
        {
          id: 'c1',
          code: 'CAM-01',
          name: '旧点位',
          zone: '旧区域',
          protocol: 'rtsp',
          sourceUrl: `rtsp://admin:${password}@192.168.1.10:554/Streaming/Channels/101`,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const cameras = store.listCameras();
  assert.equal(cameras.length, 1);
  assert.ok(cameras[0].sourceUrl.includes(password));
  assert.equal(store.needsSetup, false);

  const raw = await fs.readFile(path.join(dataDir, 'app.db'));
  assert.equal(raw.includes(Buffer.from(password)), false);

  const migrated = store.getMeta('initialized');
  assert.equal(migrated, '1');
});

test('duplicate source fingerprints are normalized and rejected', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  store.createCamera({
    name: '一号',
    zone: 'A',
    protocol: 'hls',
    sourceUrl: 'HTTP://Example.com:80/live.m3u8?b=2&a=1',
    enabled: true,
  });
  assert.throws(
    () =>
      store.createCamera({
        name: '二号',
        zone: 'A',
        protocol: 'hls',
        sourceUrl: 'http://example.com/live.m3u8?a=1&b=2',
        enabled: true,
      }),
    /已存在/,
  );
});

test('alarm active uniqueness and transitions are persisted', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const camera = store.createCamera({
    name: '测试',
    zone: 'A',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const alarm = store.createAlarm({
    id: crypto.randomUUID(),
    cameraId: camera.id,
    cameraName: camera.name,
    zone: camera.zone,
    level: 'fire',
    confidence: 90,
    hotspot: { x: 50, y: 50 },
    actor: { id: 'u1', username: 'operator' },
  });
  assert.equal(alarm.status, 'pending');
  assert.equal(store.activeAlarmForCamera(camera.id).id, alarm.id);

  const confirmed = store.updateAlarm(
    alarm.id,
    { status: 'confirmed', confirmedAt: Date.now(), steps: [true, false, false, false] },
    { id: 'u1', username: 'operator' },
  );
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.steps, [true, false, false, false]);

  const archived = store.updateAlarm(
    alarm.id,
    { status: 'archived', archivedAt: Date.now() },
    { id: 'u1', username: 'operator' },
  );
  assert.equal(archived.status, 'archived');
  assert.ok(archived.closedAt);
  assert.equal(store.activeAlarmForCamera(camera.id), null);
});

test('schema v2 database without site_id upgrades in place', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-v2-'));
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cameras (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      zone TEXT NOT NULL,
      protocol TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES('initialized', '1')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES('setup_complete', '1')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '2')").run();
  db.prepare(`
    INSERT INTO cameras
    (id, code, name, zone, protocol, source_url, enabled, created_at, updated_at)
    VALUES ('c1', 'CAM-01', '旧点位', '旧区域', 'none', '', 1, 1, 1)
  `).run();
  db.close();

  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.equal(store.schemaVersion, SCHEMA_VERSION);
  const cameras = store.listCameras();
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].siteId, store.defaultSiteId);
  assert.equal(cameras[0].detectEnabled, true);
  assert.deepEqual(cameras[0].detectRoi, []);
  assert.equal(store.listSites().length, 1);
  assert.equal(store.getSite(store.defaultSiteId).name, '默认站点');
  assert.equal(store.listNotifyChannels().length, 0);
});

test('schema v3 alarm table is rebuilt without losing rows', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-v3-'));
  const siteId = '00000000-0000-0000-0000-000000000001';
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cameras (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      zone TEXT NOT NULL,
      protocol TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      site_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE alarms (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      camera_name TEXT NOT NULL,
      zone TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('fire','smoke')),
      confidence REAL NOT NULL,
      hotspot_x REAL NOT NULL,
      hotspot_y REAL NOT NULL,
      snapshot_file TEXT,
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
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES('initialized', '1')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES('setup_complete', '1')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '3')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES('default_site_id', ?)").run(siteId);
  db.prepare("INSERT INTO sites (id, name, code, created_at) VALUES (?, '默认站点', 'DEFAULT', 1)").run(
    siteId,
  );
  db.prepare(`
    INSERT INTO cameras
    (id, code, name, zone, protocol, source_url, site_id, enabled, created_at, updated_at)
    VALUES ('c1', 'CAM-01', '旧点位', '旧区域', 'none', '', ?, 1, 1, 1)
  `).run(siteId);
  db.prepare(`
    INSERT INTO alarms
    (id, camera_id, camera_name, zone, level, confidence, hotspot_x, hotspot_y,
     snapshot_file, status, note, steps_json, created_at, updated_at)
    VALUES ('a1', 'c1', '旧点位', '旧区域', 'fire', 88, 40, 60, NULL, 'archived', '', '[false,false,false,false]', 1, 1)
  `).run();
  db.close();

  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.equal(store.schemaVersion, SCHEMA_VERSION);
  const alarms = store.listAlarms(10);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].level, 'fire');
  assert.equal(alarms[0].siteId, siteId);
  assert.equal(alarms[0].clipFile, null);
  // 新级别 offline 可写入
  const offline = store.createAlarm({
    id: 'a2',
    cameraId: 'c1',
    cameraName: '旧点位',
    zone: '旧区域',
    siteId,
    level: 'offline',
    confidence: 0,
    hotspot: { x: 50, y: 50 },
  });
  assert.equal(offline.level, 'offline');
});

test('notification channels encrypt at rest and deliveries dedupe', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-notify-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const channel = store.createNotifyChannel({
    id: 'ch1',
    kind: 'webhook',
    name: '值班群',
    url: 'https://example.com/hook?key=secret-key',
    secret: 'top-secret',
  });
  assert.equal(channel.url.includes('secret-key'), true);
  assert.equal(channel.secret, 'top-secret');
  assert.equal(store.listNotifyChannels().length, 1);
  assert.equal(store.channelsForSite(null).length, 1);
  // 全局渠道对任意站点生效
  assert.equal(store.channelsForSite('some-site').length, 1);

  const files = await Promise.all(
    ['app.db', 'app.db-wal'].map((name) =>
      fs.readFile(path.join(dataDir, name)).catch(() => Buffer.alloc(0)),
    ),
  );
  const raw = Buffer.concat(files);
  assert.equal(raw.includes(Buffer.from('top-secret')), false);
  assert.equal(raw.includes(Buffer.from('secret-key')), false);

  assert.equal(store.claimNotification('a1', 'ch1', 'created'), true);
  assert.equal(store.claimNotification('a1', 'ch1', 'created'), false);
  store.finishNotification('a1', 'ch1', 'created', { status: 'sent' });
  const logs = store.listNotificationLogs(10);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'sent');
  assert.equal(logs[0].channelName, '值班群');
});

test('alarm retention only removes closed old alarms', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-retain-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const camera = store.createCamera({
    name: '保留测试',
    zone: 'A',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const base = {
    cameraId: camera.id,
    cameraName: camera.name,
    zone: camera.zone,
    siteId: camera.siteId,
    confidence: 80,
    hotspot: { x: 10, y: 20 },
  };
  store.createAlarm({ ...base, id: 'old', level: 'fire', snapshotFile: 'old.jpg' });
  store.updateAlarm(
    'old',
    { status: 'archived', archivedAt: Date.now() },
    { id: 'u1', username: 'op' },
  );
  store.createAlarm({ ...base, id: 'fresh', level: 'smoke' });

  // 为被清理的告警造事件与推送日志：删除告警时必须一并清理，避免孤儿记录。
  store.updateAlarm(
    'old',
    { note: '值班备注' },
    { id: 'u1', username: 'op' },
  );
  store.claimNotification('old', 'ch1', 'created');
  assert.ok(store.listAlarmEvents('old').length > 0);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS c FROM notification_logs WHERE alarm_id = ?').get('old').c,
    1,
  );

  const result = store.pruneAlarms({ retainDays: 0, at: Date.now() + 10_000 });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.snapshots, ['old.jpg']);
  assert.equal(store.getAlarm('old'), null);
  assert.equal(store.getAlarm('fresh').id, 'fresh');
  // 级联清理：事件与推送日志不残留
  assert.equal(store.listAlarmEvents('old').length, 0);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS c FROM notification_logs WHERE alarm_id = ?').get('old').c,
    0,
  );
  assert.ok(result.events > 0, '应报告清理的事件数');
});

test('site admin flag persists and scopes manageable sites', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-siteadmin-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const siteA = store.createSite({ id: 'site-a', name: '园区 A', code: 'A' });
  const siteB = store.createSite({ id: 'site-b', name: '园区 B', code: 'B' });
  const user = store.createUser({
    id: 'u-site',
    username: 'siteop',
    displayName: '站点管理员',
    role: 'operator',
    siteAdmin: true,
    salt: 's',
    passwordHash: 'h',
    createdAt: 1,
  });
  assert.equal(user.siteAdmin, true);
  store.setUserSites(user.id, [siteA.id]);
  assert.deepEqual(store.adminSiteIds(user.id), [siteA.id]);
  assert.deepEqual(store.siteMemberSiteIds(user.id), [siteA.id]);

  const plain = store.createUser({
    id: 'u-plain',
    username: 'op2',
    displayName: '值班员',
    role: 'operator',
    salt: 's',
    passwordHash: 'h',
    createdAt: 2,
  });
  store.setUserSites(plain.id, [siteA.id, siteB.id]);
  assert.deepEqual(store.adminSiteIds(plain.id), []);

  const updated = store.updateUser(user.id, { siteAdmin: false });
  assert.equal(updated.siteAdmin, false);
  assert.deepEqual(store.adminSiteIds(user.id), []);
});

test('clearOldestAlarmMedia clears oldest closed alarms first', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-watermark-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const camera = store.createCamera({
    name: '水位测试',
    zone: 'A',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const make = (id, status, withMedia, createdAt) => {
    store.createAlarm({
      id,
      cameraId: camera.id,
      cameraName: camera.name,
      zone: camera.zone,
      siteId: camera.siteId,
      level: 'fire',
      confidence: 80,
      hotspot: { x: 10, y: 20 },
      snapshotFile: withMedia ? `${id}.jpg` : null,
      clipFile: withMedia ? `${id}.mp4` : null,
      createdAt,
    });
    if (status !== 'pending') {
      store.updateAlarm(
        id,
        { status, archivedAt: createdAt + 1000 },
        { id: 'u1', username: 'op' },
      );
    }
  };
  make('old-1', 'archived', true, 1000);
  make('old-2', 'false', true, 2000);
  make('keep', 'archived', true, 3000);
  make('bare', 'archived', false, 5000);
  // pending 的最后创建：同点位仅允许一条活跃告警
  make('active', 'pending', true, 4000);

  const cleared = store.clearOldestAlarmMedia(2);
  assert.equal(cleared.alarms, 2);
  assert.deepEqual(cleared.files, [
    'old-1.jpg',
    'old-1.mp4',
    'old-2.jpg',
    'old-2.mp4',
  ]);

  assert.equal(store.getAlarm('old-1').snapshotFile, null);
  assert.equal(store.getAlarm('old-1').clipFile, null);
  assert.equal(store.getAlarm('old-2').clipFile, null);
  // 第三老的已关闭告警与未关闭告警的媒体不受影响
  assert.equal(store.getAlarm('keep').snapshotFile, 'keep.jpg');
  assert.equal(store.getAlarm('active').clipFile, 'active.mp4');

  // 清无可清的媒体时返回空
  const again = store.clearOldestAlarmMedia(100);
  assert.equal(again.alarms, 1);
  assert.deepEqual(again.files, ['keep.jpg', 'keep.mp4']);
});

test('alarmStatsByDay buckets alarms by Shanghai calendar day', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-stats-'));
  const store = await openStore({ dataDir, secretBox: box() });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const dayStart = (ts) => {
    const shifted = new Date(ts + 8 * 3600 * 1000);
    return (
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
      ) -
      8 * 3600 * 1000
    );
  };
  const todayStart = dayStart(Date.now());
  const dayKey = (ts) => {
    const shifted = new Date(ts + 8 * 3600 * 1000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  };

  const cameraA = store.createCamera({
    name: '统计A',
    zone: 'A',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const cameraB = store.createCamera({
    name: '统计B',
    zone: 'B',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const make = (id, camera, level, status, createdAt) => {
    store.createAlarm({
      id,
      cameraId: camera.id,
      cameraName: camera.name,
      zone: camera.zone,
      siteId: camera.siteId,
      level,
      confidence: 80,
      hotspot: { x: 1, y: 2 },
      createdAt,
    });
    if (status !== 'pending') {
      store.updateAlarm(id, { status, archivedAt: createdAt + 100 }, { id: 'u', username: 'op' });
    }
  };
  make('st-a', cameraA, 'fire', 'archived', todayStart + 1000);
  make('st-b', cameraA, 'smoke', 'false', todayStart - 86_400_000 + 2000);
  make('st-c', cameraB, 'fire', 'pending', todayStart + 3000);

  const rows = store.alarmStatsByDay({ days: 7 });
  const todayKey = dayKey(Date.now());
  const yesterdayKey = dayKey(Date.now() - 86_400_000);
  const totals = {};
  for (const row of rows) {
    totals[row.day] = (totals[row.day] ?? 0) + row.count;
  }
  assert.equal(totals[todayKey], 2);
  assert.equal(totals[yesterdayKey], 1);

  const scoped = store.alarmStatsByDay({ days: 7, siteIds: ['no-such-site'] });
  assert.equal(scoped.length, 0);
});

test('corrupt database is preserved instead of silently recreated', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.writeFile(path.join(dataDir, 'app.db'), 'not a sqlite database');
  await assert.rejects(
    () => openStore({ dataDir, secretBox: box() }),
    /已保留损坏文件备份/,
  );
  const files = await fs.readdir(dataDir);
  assert.ok(files.some((file) => file.startsWith('app.db.corrupt-')));
});

test('only real file corruption is classified as corruption', () => {
  const sqliteError = (message, errcode) => Object.assign(new Error(message), { errcode });
  assert.equal(isDatabaseCorruptionError(sqliteError('file is not a database', 26)), true);
  assert.equal(isDatabaseCorruptionError(sqliteError('database disk image is malformed', 11)), true);
  assert.equal(isDatabaseCorruptionError(new Error('database disk image is malformed')), true);
  assert.equal(isDatabaseCorruptionError(sqliteError('database is locked', 5)), false);
  assert.equal(isDatabaseCorruptionError(sqliteError('unable to open database file', 14)), false);
  assert.equal(isDatabaseCorruptionError(new Error('no such table: alarms')), false);
  assert.equal(isDatabaseCorruptionError(new Error('database is locked')), false);
});

test('identical corruption does not pile up duplicate backups', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.writeFile(path.join(dataDir, 'app.db'), 'not a sqlite database');
  await fs.writeFile(path.join(dataDir, 'app.db-wal'), Buffer.from('fake-wal'));
  await fs.writeFile(path.join(dataDir, 'app.db-shm'), Buffer.from('fake-shm'));

  assert.equal(backupCorruptFiles(dataDir), true);
  // shm 由 SQLite 运行时重建，内容变化不应被视为新的损坏现场。
  await fs.writeFile(path.join(dataDir, 'app.db-shm'), Buffer.from('rebuilt-shm'));
  assert.equal(backupCorruptFiles(dataDir), false);
  const count = async () =>
    (await fs.readdir(dataDir)).filter((file) => file.startsWith('app.db.corrupt-')).length;
  assert.equal(await count(), 1);

  // 主库内容确实变化时才保留新现场。
  await fs.writeFile(path.join(dataDir, 'app.db'), 'another broken database');
  assert.equal(backupCorruptFiles(dataDir), true);
  assert.equal(await count(), 2);
});

test('non-corruption init failure surfaces the real cause without a bogus backup', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 目录占位使 SQLite 无法打开数据库文件（CANTOPEN），属于运行态故障而非文件损坏。
  await fs.mkdir(path.join(dataDir, 'app.db'));
  await assert.rejects(
    () => openStore({ dataDir, secretBox: box() }),
    (error) =>
      /未生成损坏备份/.test(error.message) && !/已保留损坏文件备份/.test(error.message),
  );
  const files = await fs.readdir(dataDir);
  assert.equal(files.some((file) => file.includes('.corrupt-')), false);
});

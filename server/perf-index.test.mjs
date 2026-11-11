import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

/**
 * PERF-1（V9 索引迁移）与 PERF-2/PERF-3 的回归测试。
 *
 * 这些用例锁住三类「很容易被后续改动悄悄退化」的行为：
 *   1. 新库与存量 V8 升级库最终拥有同一套性能索引；
 *   2. 审计日志按阈值清理必须恰好保留 retain 条（不能少删也不能多删）；
 *   3. 关键词搜索被时间窗收敛时行为可预期，且显式指定时间范围时不收敛。
 */

function box() {
  return new SecretBox(crypto.randomBytes(32));
}

/**
 * 统一的临时库生命周期管理。
 *
 * Node 的 t.after 钩子按注册顺序执行，因此「删目录」必须排在「关库」之后，
 * 否则 Windows 上会因 app.db 仍被占用而报 EBUSY。
 * 这里只注册一个钩子，内部先 close 再 rm，顺序不会错。
 */
function tempStore(t, prefix) {
  const holder = { store: null, dataDir: null };
  t.after(async () => {
    try {
      holder.store?.close();
    } catch {
      // ignore
    }
    if (holder.dataDir) {
      await fs.rm(holder.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  return {
    holder,
    async open(secretBox = box()) {
      if (!holder.dataDir) {
        holder.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      }
      holder.store = await openStore({ dataDir: holder.dataDir, secretBox });
      return holder.store;
    },
  };
}

/** 读取库里的全部索引名。 */
function indexNames(store) {
  return store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
}

const V9_INDEXES = [
  'idx_alarm_created',
  'idx_alarm_media_old',
  'idx_notify_channel',
  'idx_seg_protected',
];

test('V9 索引：全新建库即带齐全部性能索引', async (t) => {
  const temp = tempStore(t, 'fire-v9-new-');
  const store = await temp.open();

  const names = indexNames(store);
  for (const expected of V9_INDEXES) {
    assert.ok(names.includes(expected), `新库应包含索引 ${expected}`);
  }
  assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION));
  // 统计信息必须存在，否则规划器会忽略部分索引。
  assert.ok(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
      .get(),
    '应已采集查询统计信息 sqlite_stat1',
  );
});

test('V9 索引：存量 V8 库升级后补建索引并推进版本号', async (t) => {
  const temp = tempStore(t, 'fire-v9-migrate-');
  const secretBox = box();

  // 先建库，再人为回退成「V8 存量库」：删掉 V9 索引并把版本号改回 8。
  const first = await temp.open(secretBox);
  for (const name of V9_INDEXES) {
    first.db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  first.db
    .prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'")
    .run();
  first.close();

  // 重新打开 → 触发 V9 迁移。
  const store = await temp.open(secretBox);

  const names = indexNames(store);
  for (const expected of V9_INDEXES) {
    assert.ok(names.includes(expected), `升级后应补建索引 ${expected}`);
  }
  assert.equal(store.getMeta('schema_version'), '10');
});

test('V9 索引：重复打开不会报错（迁移可重入）', async (t) => {
  const temp = tempStore(t, 'fire-v9-idem-');
  const secretBox = box();
  for (let i = 0; i < 3; i += 1) {
    const store = await temp.open(secretBox);
    assert.equal(store.getMeta('schema_version'), '10');
    store.close();
  }
});

test('V9 索引：部分索引被规划器采纳（媒体水位清理不再临时排序）', async (t) => {
  const temp = tempStore(t, 'fire-v9-plan-');
  const store = await temp.open();

  // 造一批已关闭且带媒体的告警，让统计信息有实际区分度。
  const base = Date.now() - 10 * 60_000;
  const insert = store.db.prepare(
    `INSERT INTO alarms
     (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
      snapshot_file, clip_file, status, note, steps_json, created_at, updated_at)
     VALUES (?, 'cam', '摄像头', '区域', NULL, 'fire', 0.9, 0.5, 0.5, ?, ?, ?, '', '[]', ?, ?)`,
  );
  store.transaction(() => {
    for (let i = 0; i < 500; i += 1) {
      const status = i % 2 === 0 ? 'archived' : 'false';
      insert.run(`p${i}`, `snap-${i}.jpg`, `clip-${i}.mp4`, status, base + i, base + i);
    }
  });
  store.analyze();

  const plan = store.db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM alarms
       WHERE status IN ('archived','false')
         AND (snapshot_file IS NOT NULL OR clip_file IS NOT NULL)
       ORDER BY created_at ASC LIMIT 100`,
    )
    .all()
    .map((row) => row.detail)
    .join(' | ');
  assert.ok(
    plan.includes('idx_alarm_media_old'),
    `媒体水位清理应走部分索引，实际计划：${plan}`,
  );
  assert.ok(
    !plan.includes('USE TEMP B-TREE FOR ORDER BY'),
    `媒体水位清理不应再有临时排序，实际计划：${plan}`,
  );
});

test('V9 索引：旧版 alarms 表缺 clip_file 列时仍能升级（索引不得在迁移前建）', async (t) => {
  const temp = tempStore(t, 'fire-v9-legacy-');
  const secretBox = box();

  // 先拿到一个数据目录，然后手工造一个「V3 时代」的库：
  // alarms 表没有 clip_file 列，且 schema_version=3。
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-v9-legacy-'));
  temp.holder.dataDir = dataDir;
  const legacy = new DatabaseSync(path.join(dataDir, 'app.db'));
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES('initialized', '1');
    INSERT INTO meta(key, value) VALUES('setup_complete', '1');
    INSERT INTO meta(key, value) VALUES('schema_version', '3');
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
      status TEXT NOT NULL,
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
    INSERT INTO alarms (id, camera_id, camera_name, zone, level, confidence, hotspot_x, hotspot_y,
      status, created_at, updated_at)
    VALUES ('legacy-1', 'cam', '旧点位', 'A 区', 'fire', 0.9, 0.5, 0.5, 'archived', 1000, 1000);
  `);
  legacy.close();

  // 升级：若 V9 索引被建在表结构迁移之前，这里会因缺 clip_file 列而启动失败。
  const store = await temp.open(secretBox);
  assert.equal(store.getMeta('schema_version'), '10');
  const names = indexNames(store);
  for (const expected of V9_INDEXES) {
    assert.ok(names.includes(expected), `升级后应补建索引 ${expected}`);
  }
  // 旧数据必须还在。
  assert.equal(store.getAlarm('legacy-1')?.cameraName, '旧点位');
});

test('审计日志按条数清理：恰好保留 retain 条（阈值删除）', async (t) => {
  const temp = tempStore(t, 'fire-audit-prune-');
  const store = await temp.open();

  // 造 1200 条审计日志（pruneAuditLogs 的下限是 1000 条保留量）。
  const base = Date.now() - 1000 * 60 * 60 * 1000;
  const insert = store.db.prepare(
    `INSERT INTO audit_logs (id, user_id, username, action, target_type, target_id, detail, ip, created_at)
     VALUES (?, NULL, 'u', 'test', NULL, NULL, 'd', '127.0.0.1', ?)`,
  );
  store.transaction(() => {
    for (let i = 0; i < 1200; i += 1) {
      insert.run(`a${i}`, base + i);
    }
  });

  const removed = store.pruneAuditLogs(1000);
  assert.equal(removed, 200, '应删除 200 条');
  const total = Number(
    store.db.prepare('SELECT COUNT(*) AS total FROM audit_logs').get()?.total ?? 0,
  );
  assert.equal(total, 1000, '清理后应恰好保留 1000 条');

  // 再清理一次不应报错也不应重复删除。
  assert.equal(store.pruneAuditLogs(1000), 0);
  assert.equal(
    Number(store.db.prepare('SELECT COUNT(*) AS total FROM audit_logs').get()?.total ?? 0),
    1000,
  );
});

test('审计日志按条数清理：同一毫秒的多条记录按 rowid 精确切分', async (t) => {
  const temp = tempStore(t, 'fire-audit-tie-');
  const store = await temp.open();

  // 1500 条记录共用同一个 created_at。
  const ts = Date.now();
  const insert = store.db.prepare(
    `INSERT INTO audit_logs (id, user_id, username, action, target_type, target_id, detail, ip, created_at)
     VALUES (?, NULL, 'u', 'test', NULL, NULL, 'd', '127.0.0.1', ?)`,
  );
  store.transaction(() => {
    for (let i = 0; i < 1500; i += 1) {
      insert.run(`t${i}`, ts);
    }
  });

  const removed = store.pruneAuditLogs(1000);
  assert.equal(removed, 500);
  assert.equal(
    Number(store.db.prepare('SELECT COUNT(*) AS total FROM audit_logs').get()?.total ?? 0),
    1000,
    '同毫秒记录不得因阈值相等而多删或少删',
  );
});

test('审计日志按条数清理：总条数不足时不删除任何记录', async (t) => {
  const temp = tempStore(t, 'fire-audit-under-');
  const store = await temp.open();

  for (let i = 0; i < 10; i += 1) {
    store.recordAudit({ action: 'test', user: { username: 'u' }, detail: 'd' });
  }
  assert.equal(store.pruneAuditLogs(1000), 0);
  assert.equal(
    Number(store.db.prepare('SELECT COUNT(*) AS total FROM audit_logs').get()?.total ?? 0),
    10,
  );
});

test('审计关键词搜索：未指定时间范围时自动收敛到默认时间窗', async (t) => {
  const temp = tempStore(t, 'fire-audit-window-');
  const store = await temp.open();

  store.recordAudit({ action: 'test', user: { username: 'recent' }, detail: '命中' });
  const old = store.db
    .prepare(
      `INSERT INTO audit_logs (id, user_id, username, action, target_type, target_id, detail, ip, created_at)
       VALUES ('old-1', NULL, 'ancient', 'test', NULL, NULL, '命中', '127.0.0.1', ?)`,
    )
    .run(Date.now() - 365 * 24 * 60 * 60 * 1000);
  assert.equal(old.changes, 1);

  // 默认收敛到 180 天：一年前的记录搜不到。
  assert.equal(store.countAuditFiltered({ q: '命中' }), 1);
  assert.equal(store.auditSearchWindowed({ q: '命中' }), true);
  assert.equal(store.auditSearchWindowed({ q: '' }), false);

  // 显式指定起始时间后不再收敛，可以搜到一年前的记录。
  const from = Date.now() - 400 * 24 * 60 * 60 * 1000;
  assert.equal(store.countAuditFiltered({ q: '命中', from }), 2);
  assert.equal(store.auditSearchWindowed({ q: '命中', from }), false);

  // 指定了结束时间（旧到不覆盖窗口起点）同样命中 0 条，且仍标记为收敛。
  const to = Date.now() - 300 * 24 * 60 * 60 * 1000;
  assert.equal(store.countAuditFiltered({ q: '命中', to }), 0);
});

test('媒体水位清理：一次调用批量清空媒体并保留告警记录', async (t) => {
  const temp = tempStore(t, 'fire-media-batch-');
  const store = await temp.open();

  const base = Date.now() - 10_000;
  const insert = store.db.prepare(
    `INSERT INTO alarms
     (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
      snapshot_file, clip_file, status, note, steps_json, created_at, updated_at)
     VALUES (?, 'cam', '摄像头', '区域', NULL, 'fire', 0.9, 0.5, 0.5, ?, ?, 'archived', '', '[]', ?, ?)`,
  );
  store.transaction(() => {
    for (let i = 0; i < 250; i += 1) {
      insert.run(`m${i}`, `snap-${i}.jpg`, `clip-${i}.mp4`, base + i, base + i);
    }
  });

  const cleared = store.clearOldestAlarmMedia(1000);
  assert.equal(cleared.alarms, 250, '应一次清空全部 250 条');
  assert.equal(cleared.files.length, 500, '应返回 250 张抓拍 + 250 段短视频');

  const remaining = Number(
    store.db
      .prepare(
        `SELECT COUNT(*) AS total FROM alarms
         WHERE snapshot_file IS NOT NULL OR clip_file IS NOT NULL`,
      )
      .get()?.total ?? 0,
  );
  assert.equal(remaining, 0, '媒体字段应全部置空');
  const kept = Number(
    store.db.prepare('SELECT COUNT(*) AS total FROM alarms').get()?.total ?? 0,
  );
  assert.equal(kept, 250, '告警记录本身必须保留');
});

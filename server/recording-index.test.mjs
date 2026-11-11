import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';
import { registerRecordingRoutes } from './routes/recordings.mjs';
import {
  parseUtcDay,
  parseSegmentTime,
  dayRangeFromDate,
  scanRecordingSegments,
  reconcileRecordingSegments,
  buildTimeline,
} from './recording-index.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-recording-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function writeSegment(root, cameraId, day, name, size) {
  const dir = path.join(root, cameraId, day);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), Buffer.alloc(size));
  return path.join(dir, name);
}

test('UTC 日期与段名解析', () => {
  assert.equal(parseUtcDay('20261103'), Date.UTC(2026, 10, 3));
  assert.equal(parseUtcDay('2026-11-03'), null);
  assert.equal(parseUtcDay('20260230'), null); // 非法日期不得被 Date.UTC 归一化
  assert.equal(parseSegmentTime('120000.ts'), 12 * 3600 * 1000);
  assert.equal(parseSegmentTime('235959.ts'), (24 * 3600 - 1) * 1000);
  assert.equal(parseSegmentTime('240000.ts'), null);
  assert.equal(parseSegmentTime('120000.mp4'), null);
  const range = dayRangeFromDate('2026-11-03');
  assert.deepEqual(range, { from: Date.UTC(2026, 10, 3), to: Date.UTC(2026, 10, 4) });
  assert.equal(dayRangeFromDate('20261103')?.from, Date.UTC(2026, 10, 3));
  assert.equal(dayRangeFromDate('nonsense'), null);
});

test('扫描录像目录并按相邻段校准时长', async (t) => {
  const root = await tempDir(t);
  const day = '20261103';
  await writeSegment(root, 'cam-01', day, '120000.ts', 100);
  await writeSegment(root, 'cam-01', day, '120100.ts', 200);
  await writeSegment(root, 'cam-01', day, '120200.ts', 300);
  await writeSegment(root, 'cam-01', day, '120500.ts', 400); // 与上一间隔 180s → 留 gap
  await writeSegment(root, 'cam-01', day, 'bad.ts', 10); // 非段文件，忽略
  await writeSegment(root, 'cam-01', 'not-a-day', '120000.ts', 10); // 非法目录，忽略
  await writeSegment(root, '.hidden', day, '120000.ts', 10); // 隐藏目录，忽略

  const segments = await scanRecordingSegments(root);
  const base = Date.UTC(2026, 10, 3, 12, 0, 0);
  assert.equal(segments.length, 4);
  assert.equal(segments[0].file, 'cam-01/20261103/120000.ts');
  assert.equal(segments[0].startedAt, base);
  assert.equal(segments[0].endedAt, base + 60_000);
  assert.equal(segments[1].endedAt, base + 120_000);
  assert.equal(segments[2].endedAt, base + 180_000); // 名义 60s，不跨越 180s 空档
  assert.equal(segments[3].startedAt, base + 300_000);
  assert.equal(segments[3].endedAt, base + 360_000);
  assert.equal(segments[0].bytes, 100);

  const missing = await tempDir(t);
  assert.deepEqual(await scanRecordingSegments(path.join(missing, 'nope')), []);
});

test('时间线合并连续段并标记缺口', () => {
  const from = Date.UTC(2026, 10, 3, 12, 0, 0);
  const to = from + 10 * 60_000;
  const timeline = buildTimeline(
    [
      { startedAt: from, endedAt: from + 60_000, bytes: 100, protected: false },
      { startedAt: from + 60_000, endedAt: from + 120_000, bytes: 100, protected: true },
      { startedAt: from + 300_000, endedAt: from + 360_000, bytes: 100, protected: false },
      { startedAt: from - 60_000, endedAt: from - 10_000, bytes: 100, protected: false }, // 窗口外
    ],
    from,
    to,
  );
  assert.equal(timeline.segmentCount, 3);
  assert.equal(timeline.blocks.length, 2);
  assert.equal(timeline.blocks[0].endedAt, from + 120_000);
  assert.equal(timeline.blocks[0].protected, true);
  assert.equal(timeline.blocks[0].segmentCount, 2);
  assert.equal(timeline.coverageMs, 3 * 60_000);
  assert.equal(timeline.gaps.length, 2);
  assert.deepEqual(timeline.gaps[0], {
    startedAt: from + 120_000,
    endedAt: from + 300_000,
  });
  assert.deepEqual(timeline.gaps[1], { startedAt: from + 360_000, endedAt: to });
  assert.deepEqual(buildTimeline([], from, from).gaps, []);
});

test('新库为 schema V9 且含录像索引表', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  const version = store.db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get().value;
  // V9：补齐关键性能索引；V10：新增 auth_sessions 会话登记表。
  assert.equal(version, '10');
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'recording_segments'")
      .get().count,
    1,
  );
  store.close();
});

test('对账以文件系统为事实源：补录、校准、清理孤儿', async (t) => {
  const dataDir = await tempDir(t);
  const root = await tempDir(t);
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  const day = '20261103';
  const first = await writeSegment(root, 'cam-01', day, '120000.ts', 100);
  await writeSegment(root, 'cam-01', day, '120100.ts', 200);

  const created = await reconcileRecordingSegments(store, root);
  assert.equal(created.scanned, 2);
  assert.equal(created.inserted, 2);
  const listed = store.listRecordingSegments({ cameraId: 'cam-01' });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].protected, false);

  const unchanged = await reconcileRecordingSegments(store, root);
  assert.deepEqual(
    { inserted: unchanged.inserted, updated: unchanged.updated, removed: unchanged.orphansRemoved },
    { inserted: 0, updated: 0, removed: 0 },
  );

  await fs.writeFile(first, Buffer.alloc(999));
  const resized = await reconcileRecordingSegments(store, root);
  assert.equal(resized.updated, 1);
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-01' })[0].bytes, 999);

  await fs.rm(first);
  const orphaned = await reconcileRecordingSegments(store, root);
  assert.equal(orphaned.orphansRemoved, 1);
  assert.equal(orphaned.inserted, 0);
  const remaining = store.listRecordingSegments({ cameraId: 'cam-01' });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].file, 'cam-01/20261103/120100.ts');
  store.close();
});

test('告警保护段豁免水位淘汰，非保护段按最旧优先', async (t) => {
  const dataDir = await tempDir(t);
  const root = await tempDir(t);
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  await writeSegment(root, 'cam-01', '20261103', '120000.ts', 100);
  await writeSegment(root, 'cam-01', '20261103', '120100.ts', 200);
  await reconcileRecordingSegments(store, root);

  const protectedFile = 'cam-01/20261103/120000.ts';
  assert.equal(store.setRecordingSegmentsProtected([protectedFile], true), 1);
  const pruned = store.pruneRecordingSegments({
    before: Date.UTC(2027, 0, 1),
    limit: 10,
  });
  assert.deepEqual(pruned, ['cam-01/20261103/120100.ts']);
  const left = store.listRecordingSegments({ cameraId: 'cam-01' });
  assert.equal(left.length, 1);
  assert.equal(left[0].protected, true);
  store.close();
});

test('目录暂时为空时保留既有索引，不整表清除', async (t) => {
  const root = await tempDir(t);
  let deleted = 0;
  const store = {
    allRecordingSegmentFiles: () => ['cam-01/20261103/120000.ts'],
    upsertRecordingSegments: () => ({ inserted: 0, updated: 0 }),
    deleteRecordingSegments: (files) => {
      deleted = files.length;
      return files.length;
    },
  };
  const result = await reconcileRecordingSegments(store, root);
  assert.equal(result.scanned, 0);
  assert.equal(result.orphansRemoved, 0);
  assert.equal(deleted, 0);
});

test('时间线接口：参数校验、跨站点隐藏与空日时间线', async (t) => {
  const app = express();
  const camera = { id: 'cam-01', siteId: 'site-a' };
  registerRecordingRoutes(app, {
    store: {
      getCamera: (id) => (id === camera.id ? camera : null),
      listRecordingSegments: () => [],
    },
    continuousDir: await tempDir(t),
    recordingEnabled: false,
    canAccessCameraSite: (_user, item) => item.siteId === 'site-a',
    requireAuth: (req, _res, next) => {
      req.user = { id: 'u1', role: 'viewer' };
      next();
    },
    requireRole: () => (_req, _res, next) => next(),
    normalizeText: (value) => String(value ?? '').trim(),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (query) => {
    const response = await fetch(`${base}/api/recordings/timeline?${query}`);
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await get('')).status, 400);
  assert.equal((await get('cameraId=nope')).status, 404);
  assert.equal((await get('cameraId=cam-01&date=bad')).status, 400);
  assert.equal((await get('cameraId=cam-01&from=1&to=1')).status, 400);

  const ok = await get('cameraId=cam-01&date=2026-11-03');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, false);
  assert.equal(ok.body.timeline.segmentCount, 0);
  assert.equal(ok.body.timeline.gaps.length, 1);
  assert.equal(
    ok.body.timeline.gaps[0].endedAt - ok.body.timeline.gaps[0].startedAt,
    24 * 60 * 60 * 1000,
  );

  camera.siteId = 'site-b';
  assert.equal((await get('cameraId=cam-01&date=2026-11-03')).status, 404);
});

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
import { MAX_PLAYBACK_WINDOW_MS } from './recording-playback.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-recstore-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const segment = (file, startedAt, bytes = 100) => ({
  id: file,
  cameraId: file.split('/')[0],
  file,
  startedAt,
  endedAt: startedAt + 60_000,
  bytes,
  protected: false,
});

test('保护段联动、过期解除与索引用量', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  const base = Date.UTC(2026, 10, 3, 12, 0, 0);
  store.upsertRecordingSegments([
    segment('cam-01/20261103/115900.ts', base - 60_000, 100),
    segment('cam-01/20261103/120000.ts', base, 200),
    segment('cam-01/20261103/120100.ts', base + 60_000, 300),
    segment('cam-01/20261103/130000.ts', base + 3600_000, 400),
    segment('cam-02/20261103/120000.ts', base, 500),
  ]);

  // 窗口 [base-30s, base+90s] 覆盖前 3 段（含边界重叠），且不含其它点位。
  const protectedCount = store.protectSegmentsAround({
    cameraId: 'cam-01',
    from: base - 30_000,
    to: base + 90_000,
  });
  assert.equal(protectedCount, 3);
  assert.equal(store.protectSegmentsAround({ cameraId: 'cam-01', from: base, to: base }), 0);
  assert.equal(store.protectSegmentsAround({ from: base, to: base + 1 }), 0);

  const usage = store.recordingUsage();
  assert.equal(usage.files, 5);
  assert.equal(usage.bytes, 1500);
  assert.equal(usage.protectedFiles, 3);

  // 淘汰跳过保护段；解除保护后方可选出（同起点顺序不保证，故排序后比较）。
  const firstPrune = store.pruneRecordingSegments({ before: base + 7200_000, limit: 10 });
  assert.deepEqual(firstPrune.sort(), [
    'cam-01/20261103/130000.ts',
    'cam-02/20261103/120000.ts',
  ].sort());
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-01' }).length, 3);

  const unprotected = store.unprotectExpiredSegments(base + 7200_000);
  assert.equal(unprotected, 3);
  const secondPrune = store.pruneRecordingSegments({ before: base + 7200_000, limit: 10 });
  assert.equal(secondPrune.length, 3);
  assert.equal(store.recordingUsage().files, 0);
  store.close();
});

function makeApp(t, overrides = {}) {
  const camera = { id: 'cam-01', code: 'CAM-01', siteId: 'site-a' };
  const state = { camera, segments: [], user: { id: 'u1', role: 'viewer' } };
  const deps = {
    store: {
      getCamera: (id) => (id === state.camera.id ? state.camera : null),
      listRecordingSegments: () => state.segments,
    },
    continuousDir: null,
    recordingEnabled: true,
    canAccessCameraSite: (_user, item) => item.siteId === 'site-a',
    requireAuth: (req, _res, next) => {
      req.user = state.user;
      next();
    },
    requireRole: () => (_req, _res, next) => next(),
    normalizeText: (value) => String(value ?? '').trim(),
    playbackManager: {
      status: () => ({ active: 2, total: 2, skipped: 1, ffmpegAvailable: true }),
      create: async (options) => ({
        sessionId: 'sess-01',
        playlist: '/api/recordings/play/sess-01/index.m3u8',
        from: options.from,
        to: options.to,
        segmentCount: options.files.length,
        expiresAt: Date.now() + 90_000,
      }),
      touch: (id) =>
        id === 'sess-01'
          ? { id, userId: 'u1', cameraId: 'cam-01', siteId: 'site-a', dir: null }
          : null,
      filePath: (_session, name) => (name === 'index.m3u8' ? overrides.playlistFile : null),
    },
    captureManager: { status: () => ({ active: 2, total: 2, skipped: 1 }) },
    exportDir: overrides.exportDir ?? null,
    exportRecording: async () => overrides.exportFile ?? null,
    ffmpegAvailable: true,
    retentionDays: 14,
    logger: { warn: () => undefined },
    ...overrides.deps,
  };
  const app = express();
  registerRecordingRoutes(app, deps);
  return { app, state, deps };
}

async function withServer(t, app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await run(`http://127.0.0.1:${server.address().port}`);
}

test('回放接口：参数边界、跨站隐藏、无段与正常会话', async (t) => {
  const { app, state } = makeApp(t);
  await withServer(t, app, async (base) => {
    const get = async (query) => {
      const response = await fetch(`${base}/api/recordings/play?${query}`);
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await get('')).status, 400);
    assert.equal((await get('cameraId=nope&from=1&to=2')).status, 404);
    assert.equal((await get('cameraId=cam-01&from=x&to=2')).status, 400);
    assert.equal((await get('cameraId=cam-01&from=2&to=1')).status, 400);
    assert.equal(
      (await get(`cameraId=cam-01&from=0&to=${MAX_PLAYBACK_WINDOW_MS + 1}`)).status,
      400,
    );
    assert.equal((await get('cameraId=cam-01&from=1000&to=2000')).status, 404);

    state.segments = [segment('cam-01/20261103/120000.ts', 1000)];
    const ok = await get('cameraId=cam-01&from=1000&to=2000');
    assert.equal(ok.status, 200);
    assert.match(ok.body.playlist, /^\/api\/recordings\/play\//);
    assert.equal(ok.body.segmentCount, 1);

    state.camera.siteId = 'site-b';
    assert.equal((await get('cameraId=cam-01&from=1000&to=2000')).status, 404);
  });
});

test('状态接口与未接线时的降级', async (t) => {
  const { app } = makeApp(t);
  await withServer(t, app, async (base) => {
    const response = await fetch(`${base}/api/recordings/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.enabled, true);
    assert.equal(body.active, 2);
    assert.equal(body.ffmpegAvailable, true);
    assert.equal(body.retentionDays, 14);
  });

  // 未注入 playbackManager / exportRecording 的部署：新接口受控降级而非崩溃。
  const { app: bare } = makeApp(t, {
    deps: { playbackManager: null, exportRecording: null, exportDir: null },
  });
  await withServer(t, bare, async (base) => {
    const play = await fetch(`${base}/api/recordings/play?cameraId=cam-01&from=1&to=2`);
    assert.equal(play.status, 503);
    const hls = await fetch(`${base}/api/recordings/play/sess-01/index.m3u8`);
    assert.equal(hls.status, 404);
    const status = await fetch(`${base}/api/recordings/status`);
    assert.equal(status.status, 200);
  });
});

test('HLS 分片：会话归属、实时站点权限与文件白名单', async (t) => {
  const dir = await tempDir(t);
  const playlistFile = path.join(dir, 'index.m3u8');
  await fs.writeFile(playlistFile, '#EXTM3U\n#EXT-X-ENDLIST\n', 'utf8');
  const { app, state } = makeApp(t, { playlistFile });
  await withServer(t, app, async (base) => {
    const get = async (sid, name, user) => {
      // user 通过 makeApp 的 state 修改，这里保持 u1；单独验证其它用户见下。
      state.user = user ?? { id: 'u1', role: 'viewer' };
      return fetch(`${base}/api/recordings/play/${sid}/${name}`);
    };
    const ok = await get('sess-01', 'index.m3u8');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'private, no-store');
    assert.match(await ok.text(), /EXTM3U/);

    assert.equal((await get('unknown', 'index.m3u8')).status, 404);
    assert.equal((await get('sess-01', 'list.txt')).status, 404);
    assert.equal((await get('sess-01', '../app.db')).status, 404);
    assert.equal(
      (await get('sess-01', 'index.m3u8', { id: 'u2', role: 'viewer' })).status,
      404,
    );
    state.camera.siteId = 'site-b';
    assert.equal((await get('sess-01', 'index.m3u8')).status, 404);
  });
});

test('导出接口：无段 404、成功下载并清理临时文件', async (t) => {
  const dir = await tempDir(t);
  const exportFile = path.join(dir, 'out.mp4');
  await fs.writeFile(exportFile, 'fake-mp4', 'utf8');
  const { app, state } = makeApp(t, { exportDir: dir, exportFile });
  await withServer(t, app, async (base) => {
    assert.equal(
      (await fetch(`${base}/api/recordings/export?cameraId=cam-01&from=1&to=2`)).status,
      404,
    );
    state.segments = [segment('cam-01/20261103/120000.ts', 1000)];
    const response = await fetch(
      `${base}/api/recordings/export?cameraId=cam-01&from=1000&to=2000`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename=/);
    assert.equal(await response.text(), 'fake-mp4');
    // res.download 回调会删除临时产物；轮询等待回调执行，避免固定 sleep 抖动。
    const exists = () => fs.stat(exportFile).then(() => true).catch(() => false);
    for (let i = 0; i < 40 && (await exists()); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await exists(), false);
  });
});

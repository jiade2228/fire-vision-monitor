import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';
import { scanRecordingSegments, reconcileRecordingSegments } from './recording-index.mjs';
import { PlaybackSessionManager, buildHlsArgs } from './recording-playback.mjs';
import { SharedSourceHub, buildTeeArgs } from './shared-source.mjs';
import { apiNotFound } from './http/not-found.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-followup-'));
  t.after(async () => {
    // Windows 下 better-sqlite3 关闭后 -wal/-shm 句柄可能短暂锁定，重试并容忍最终失败，
    // 避免 teardown 误判测试失败（临时目录由系统回收）。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error.code === 'EBUSY' && attempt < 11) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
      }
    }
  });
  return dir;
}

async function openTestStore(t) {
  const store = await openStore({
    dataDir: await tempDir(t),
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(() => store.close());
  return store;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
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

test('#1/#11 保护段联动覆盖全部 createAlarm，误报即时解除', async (t) => {
  const store = await openTestStore(t);
  const base = Date.UTC(2026, 10, 3, 12, 0, 0);
  store.upsertRecordingSegments([
    segment('cam-01/20261103/115900.ts', base - 60_000),
    segment('cam-01/20261103/120000.ts', base),
    segment('cam-01/20261103/120100.ts', base + 60_000),
    segment('cam-02/20261103/120000.ts', base),
  ]);
  assert.equal(store.recordingUsage().protectedFiles, 0);

  // 直接走 store.createAlarm（手动/演示/离线/画质告警同路径），不依赖 onAlarm 回调。
  store.createAlarm({
    id: 'alarm-1',
    cameraId: 'cam-01',
    cameraName: '测试点位',
    zone: 'A 区',
    level: 'fire',
    confidence: 0.9,
    hotspot: { x: 10, y: 10 },
    createdAt: base + 30_000,
  });
  const protectedCount = store.recordingUsage().protectedFiles;
  assert.ok(protectedCount >= 2, `应保护至少 2 段，实际 ${protectedCount}`);
  assert.equal(store.recordingUsage().files, 4);
  // cam-02 点位不被 cam-01 告警保护（按 camera_id 隔离）。
  const cam02Protected = store.db
    .prepare("SELECT COUNT(*) AS c FROM recording_segments WHERE camera_id='cam-02' AND protected=1")
    .get().c;
  assert.equal(cam02Protected, 0);

  // #11：告警误报后该窗口无其它未处置告警 → 立即解除保护，释放配额。
  store.updateAlarm('alarm-1', { status: 'false' }, null);
  assert.equal(store.recordingUsage().protectedFiles, 0);
});

test('#4 ffprobe 时长探测可注入，默认不注入时行为不变', async (t) => {
  const root = await tempDir(t);
  const day = '20261103';
  await fs.mkdir(path.join(root, 'cam-01', day), { recursive: true });
  await fs.writeFile(path.join(root, 'cam-01', day, '120000.ts'), Buffer.alloc(50));
  const store = await openTestStore(t);

  const plain = await reconcileRecordingSegments(store, root);
  assert.equal(plain.inserted, 1);
  const nominal = store.listRecordingSegments({ cameraId: 'cam-01' })[0];
  assert.equal(nominal.endedAt - nominal.startedAt, 60_000);

  // 注入假 probe：把该段校准为 30s，索引应被更新。
  const probed = await reconcileRecordingSegments(store, root, {
    probe: async (segments) => new Map(segments.map((item) => [item.file, 30_000])),
  });
  assert.equal(probed.updated, 1);
  const calibrated = store.listRecordingSegments({ cameraId: 'cam-01' })[0];
  assert.equal(calibrated.endedAt - calibrated.startedAt, 30_000);

  // probe 抛错时不得改变扫描结果，也不能让对账失败。
  const tolerated = await reconcileRecordingSegments(store, root, {
    probe: async () => {
      throw new Error('ffprobe missing');
    },
  });
  assert.equal(tolerated.scanned, 1);
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-01' }).length, 1);

  // durations 也可直接作用于扫描结果。
  const withDurations = await scanRecordingSegments(root, {
    durations: new Map([['cam-01/20261103/120000.ts', 15_000]]),
  });
  assert.equal(withDurations[0].endedAt - withDurations[0].startedAt, 15_000);
});

test('#9 buildHlsArgs 支持输入侧 -ss（位于 -i 之前）', () => {
  const plain = buildHlsArgs({
    listFile: 'list.txt',
    playlist: 'index.m3u8',
    segmentPattern: 'seg-%05d.ts',
  });
  assert.ok(!plain.includes('-ss'));
  const seek = buildHlsArgs({
    listFile: 'list.txt',
    playlist: 'index.m3u8',
    segmentPattern: 'seg-%05d.ts',
    seekSeconds: 12.5,
  });
  assert.ok(seek.includes('-ss'));
  assert.ok(seek.includes('12.500'));
  assert.ok(seek.indexOf('-ss') < seek.indexOf('-i'));
});

test('#3 会话状态：pending → ready / failed，并暴露失败原因', async (t) => {
  const root = await tempDir(t);
  const continuous = await tempDir(t);
  const children = [];
  const manager = new PlaybackSessionManager({
    rootDir: root,
    continuousDir: continuous,
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    logger: { warn: () => undefined },
  });
  const make = () =>
    manager.create({
      userId: 'u1',
      cameraId: 'cam-01',
      from: 1000,
      to: 4000,
      files: ['cam-01/20261103/120000.ts'],
      startAt: 2000,
      firstStartedAt: 1000,
    });

  const ok = await make();
  assert.ok(ok);
  assert.deepEqual(manager.sessionStatus(ok.sessionId), { state: 'pending', error: null });
  children[0].emit('exit', 0);
  assert.equal(manager.sessionStatus(ok.sessionId).state, 'ready');

  const bad = await make();
  assert.ok(bad);
  children[1].emit('exit', 1);
  const failed = manager.sessionStatus(bad.sessionId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /退出/);
  assert.equal(manager.sessionStatus('missing'), null);
  await manager.stopAll();
});

test('#10 共享源：一路输入两路输出，帧分发与订阅可离线验证', async (t) => {
  const root = await tempDir(t);
  const args = buildTeeArgs({
    source: 'rtsp://127.0.0.1/live',
    isRtsp: true,
    outputPattern: path.join(root, '%H%M%S.ts'),
    segmentSeconds: 60,
    width: 16,
    height: 9,
    fps: 1,
  });
  assert.ok(args.includes('-rtsp_transport'));
  assert.ok(args.includes('copy'));
  assert.ok(args.includes('segment'));
  assert.ok(args.includes('rawvideo'));
  assert.ok(args.includes('pipe:1'));
  assert.ok(args.some((item) => String(item).includes('%H%M%S.ts')));

  const children = [];
  const hub = new SharedSourceHub({
    rootDir: root,
    width: 16,
    height: 9,
    fps: 1,
    segmentSeconds: 60,
    clock: () => Date.UTC(2026, 10, 3, 12, 0, 0),
    logger: { warn: () => undefined },
    spawnImpl: (_bin, _args, options) => {
      const child = fakeChild();
      child.env = options?.env;
      children.push(child);
      return child;
    },
  });
  const camera = {
    id: 'cam-01',
    code: 'CAM-01',
    name: '测试',
    protocol: 'rtsp',
    sourceUrl: 'rtsp://127.0.0.1/live',
    enabled: true,
  };
  const session = await hub.start(camera);
  assert.ok(session);
  assert.equal(hub.has('cam-01'), true);
  assert.deepEqual(children[0].env?.TZ, 'UTC');
  const received = [];
  const unsubscribe = hub.subscribe('cam-01', (frame) => received.push(frame.length));
  assert.ok(unsubscribe);
  children[0].stdout.emit('data', Buffer.alloc(16 * 9 * 4));
  assert.deepEqual(received, [16 * 9 * 4]);
  unsubscribe();
  children[0].stdout.emit('data', Buffer.alloc(16 * 9 * 4));
  assert.equal(received.length, 1);
  assert.equal(hub.status().active, 1);
  hub.stopAll();
  assert.equal(hub.status().active, 0);
  assert.equal(children[0].killed, true);
});

test('统一 API 404 出口：形态与文案一致', () => {
  const headers = {};
  let status = 0;
  let body = null;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  apiNotFound(res, '点位不存在');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: '点位不存在' });
});

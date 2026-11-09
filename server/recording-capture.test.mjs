import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RecordingCaptureManager,
  utcDayStamp,
  captureDirFor,
  buildCaptureArgs,
} from './recording-capture.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-capture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function waitFor(predicate, timeout = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: 条件未满足');
}

function fakeSpawn() {
  const children = [];
  const spawnImpl = (bin, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    children.push({ bin, args, options, child });
    return child;
  };
  return { spawnImpl, children };
}

const camera = (overrides = {}) => ({
  id: 'cam-01',
  code: 'CAM-01',
  name: '测试点位',
  zone: 'A 区',
  protocol: 'rtsp',
  sourceUrl: 'rtsp://127.0.0.1:554/live',
  enabled: true,
  schedule: null,
  ...overrides,
});

function makeManager(rootDir, options = {}) {
  const fake = fakeSpawn();
  const manager = new RecordingCaptureManager({
    rootDir,
    enabled: true,
    spawnImpl: fake.spawnImpl,
    ffmpegCheck: () => true,
    logger: { warn: () => undefined, info: () => undefined },
    ...options,
  });
  manager.init();
  return { manager, ...fake };
}

test('UTC 日目录、非法 ID 与 FFmpeg 分段参数', () => {
  const at = Date.UTC(2026, 10, 3, 23, 59, 0);
  assert.equal(utcDayStamp(at), '20261103');
  assert.equal(
    captureDirFor(path.join('root', 'continuous'), 'cam-01', at),
    path.join('root', 'continuous', 'cam-01', '20261103'),
  );
  assert.equal(captureDirFor('root', '../evil', at), null);
  assert.equal(captureDirFor('root', 'cam/01', at), null);

  const args = buildCaptureArgs({
    source: 'rtsp://127.0.0.1/live',
    isRtsp: true,
    outputPattern: path.join('root', '%H%M%S.ts'),
    segmentSeconds: 60,
  });
  assert.ok(args.includes('-rtsp_transport'));
  assert.ok(args.includes('-strftime'));
  assert.ok(args.includes('-reset_timestamps'));
  assert.ok(args.includes('copy'));
  assert.ok(args.some((item) => String(item).includes('%H%M%S.ts')));
  assert.equal(args.at(-2), '1');

  const httpArgs = buildCaptureArgs({
    source: 'http://127.0.0.1/live.m3u8',
    outputPattern: 'x.ts',
    segmentSeconds: 30,
  });
  assert.ok(!httpArgs.includes('-rtsp_transport'));
  assert.ok(httpArgs.includes('30'));
});

test('sync 按 UTC 日建目录、注入 TZ=UTC 并启动 copy 采集', async (t) => {
  const root = await tempDir(t);
  const { manager, children } = makeManager(root, {
    clock: () => Date.UTC(2026, 10, 3, 12, 0, 0),
  });
  manager.sync([camera()]);
  await waitFor(() => children.length === 1);
  assert.equal(children[0].options.env.TZ, 'UTC');
  assert.ok(children[0].args.includes('rtsp://127.0.0.1:554/live'));
  const dayDir = path.join(root, 'cam-01', '20261103');
  assert.equal((await fs.stat(dayDir)).isDirectory(), true);
  assert.equal(manager.status().active, 1);
  manager.stopAll();
  assert.equal(children[0].child.killed, true);
});

test('默认关闭 / FFmpeg 缺失时不产生任何进程', async (t) => {
  const root = await tempDir(t);
  const fake = fakeSpawn();
  const manager = new RecordingCaptureManager({
    rootDir: root,
    enabled: false,
    spawnImpl: fake.spawnImpl,
    ffmpegCheck: () => true,
    logger: { warn: () => undefined },
  });
  manager.init();
  manager.sync([camera()]);
  assert.equal(fake.children.length, 0);
  assert.equal(manager.status().active, 0);

  const noFfmpeg = makeManager(root, { ffmpegCheck: () => false });
  noFfmpeg.manager.sync([camera()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(noFfmpeg.children.length, 0);
  assert.equal(noFfmpeg.manager.status().ffmpegAvailable, false);
});

test('进程异常退出按指数退避重启；stopAll 清理定时器与子进程', async (t) => {
  const root = await tempDir(t);
  const { manager, children } = makeManager(root, {
    clock: () => Date.UTC(2026, 10, 3, 12, 0, 0),
  });
  manager.sync([camera()]);
  await waitFor(() => children.length === 1);
  const worker = manager.workers.get('cam-01');
  assert.equal(worker.backoffMs, 1000);
  children[0].child.emit('exit', 1);
  assert.equal(worker.backoffMs, 2000);
  assert.ok(worker.restartTimer);
  assert.match(worker.lastError, /FFmpeg 退出/);
  manager.stopAll();
  assert.equal(worker.restartTimer, null);
  assert.equal(worker.stopping, true);
  assert.equal(manager.status().active, 0);
  // 已退出的进程无需再 kill；关键是退避定时器被清掉，不会再拉起新进程。
  assert.equal(children.length, 1);
});

test('跨 UTC 日重建进程与目录，旧进程被终止', async (t) => {
  const root = await tempDir(t);
  let clock = Date.UTC(2026, 10, 3, 23, 59, 0);
  const { manager, children } = makeManager(root, { clock: () => clock });
  manager.sync([camera()]);
  await waitFor(() => children.length === 1);
  const first = children[0].child;

  clock = Date.UTC(2026, 10, 4, 0, 1, 0);
  await manager.rotate();
  await waitFor(() => children.length === 2);
  assert.equal(first.killed, true);
  assert.equal(manager.workers.get('cam-01').dayStamp, '20261104');
  assert.equal((await fs.stat(path.join(root, 'cam-01', '20261104'))).isDirectory(), true);
  manager.stopAll();
});

test('sync 遵守布防时段、并发上限与点位删除/非法 ID', async (t) => {
  const root = await tempDir(t);
  const { manager, children } = makeManager(root, {
    maxCameras: 1,
    armedCheck: (schedule) => schedule?.armed !== false,
    clock: () => Date.UTC(2026, 10, 3, 12, 0, 0),
  });
  manager.sync([camera({ id: 'cam-a' }), camera({ id: 'cam-b' })]);
  await waitFor(() => children.length === 1);
  assert.equal(manager.status().active, 1);
  assert.equal(manager.status().skipped, 1);

  // 布防时段外与点位删除都要停掉 worker。
  manager.sync([camera({ id: 'cam-a', schedule: { armed: false } })]);
  assert.equal(manager.status().active, 0);
  manager.sync([camera({ id: 'cam-a' })]);
  await waitFor(() => children.length === 2);
  manager.sync([]);
  assert.equal(manager.status().active, 0);

  // 非法 ID 在 supports 阶段就被拒绝，不会占用 worker 名额或创建目录。
  manager.sync([camera({ id: '../evil' })]);
  assert.equal(manager.status().active, 0);
  const before = children.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, before);
  manager.stopAll();
});

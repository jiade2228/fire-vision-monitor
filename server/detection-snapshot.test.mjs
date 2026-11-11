import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DetectionEngine } from './detection-engine.mjs';

const WIDTH = 160;
const HEIGHT = 90;

/** 画一张带静态纹理的背景（避免大面积纯色导致镜头位移估计退化）。 */
function paintBackground(frame) {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = 80 + ((x * 37 + y * 17) % 60);
      const i = (y * WIDTH + x) * 4;
      frame[i] = value;
      frame[i + 1] = value;
      frame[i + 2] = value;
      frame[i + 3] = 255;
    }
  }
}

/** 画一帧闪烁火焰。 */
function fireFrame(brightShade) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
  paintBackground(frame);
  const [r, g, b] = brightShade ? [255, 90, 60] : [255, 60, 40];
  for (let y = 20; y < 60; y += 1) {
    for (let x = 40; x < 100; x += 1) {
      const i = (y * WIDTH + x) * 4;
      frame[i] = r;
      frame[i + 1] = g;
      frame[i + 2] = b;
      frame[i + 3] = 255;
    }
  }
  return frame;
}

const CAMERA = {
  id: 'cam-snap',
  code: 'CAM-S',
  name: '抓拍点位',
  zone: 'A 区',
  protocol: 'http',
  sourceUrl: 'http://example.com/live.mp4',
  enabled: true,
  siteId: 'site-1',
};

/**
 * 造一个最小可用的 store 桩。
 * @param {{onCreate?: (alarm: object) => void}} [options]
 */
function makeStore(options = {}) {
  const created = [];
  const snapshots = [];
  let active = null;
  return {
    created,
    snapshots,
    get active() {
      return active;
    },
    defaultSiteId: 'site-1',
    activeAlarmForCamera: () => active,
    createAlarm: (alarm) => {
      created.push(alarm);
      active = { ...alarm, status: 'pending', snapshotFile: null };
      options.onCreate?.(alarm);
      return active;
    },
    setAlarmSnapshot: (id, file) => {
      snapshots.push({ id, file });
      active = { ...active, snapshotFile: file, snapshot: `/api/alarms/${id}/snapshot` };
      return active;
    },
    addAlarmEvent: () => undefined,
    updateAlarm: () => active,
  };
}

/**
 * 造一个「延迟完成」的假 FFmpeg：延时后写出目标文件再退出。
 * @param {number} delayMs 延迟毫秒数。
 */
function fakeSpawnDelayed(delayMs) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.kill = () => undefined;
    const target = args[args.length - 1];
    setTimeout(() => {
      try {
        fsSync.writeFileSync(target, 'fake-jpg');
      } catch {
        // ignore
      }
      child.emit('exit', 0);
    }, delayMs);
    return child;
  };
}

test('RES-2：告警先落库，抓拍异步补齐后回填', async (t) => {
  const snapshotDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-snap-'));
  t.after(() => fsp.rm(snapshotDir, { recursive: true, force: true }));
  const store = makeStore();
  const snapshotUpdates = [];
  const engine = new DetectionEngine({
    store,
    snapshotDir,
    recordingsDir: null,
    enabled: true,
    cooldownMs: 0,
    // 抓拍故意慢 300ms：用来验证「告警不等待抓拍」。
    spawnImpl: fakeSpawnDelayed(300),
    logger: { warn: () => undefined },
    onSnapshot: (alarm) => snapshotUpdates.push(alarm),
  });

  for (const shade of [false, true, false, true, false]) {
    await engine.handleFrame(CAMERA, fireFrame(shade));
  }

  // 关键断言：告警在抓拍完成之前就已经落库。
  assert.equal(store.created.length, 1, '应立即创建一条告警');
  assert.equal(store.created[0].snapshotFile, null, '落库时抓拍尚未生成');
  assert.equal(store.snapshots.length, 0, '此时不应已回填抓拍');

  // 等待抓拍异步补齐。
  const deadline = Date.now() + 5_000;
  while (!store.snapshots.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(store.snapshots.length, 1, '抓拍完成后应回填一次');
  assert.equal(store.snapshots[0].id, store.created[0].id);
  assert.equal(store.snapshots[0].file, `${store.created[0].id}.jpg`);
  assert.equal(snapshotUpdates.length, 1, '应触发一次抓拍更新回调');
  assert.equal(engine.stats.snapshots, 1);

  // 落盘的抓拍文件确实存在。
  const files = await fsp.readdir(snapshotDir);
  assert.ok(files.includes(`${store.created[0].id}.jpg`), '抓拍文件应已落盘');
});

test('RES-2：抓拍失败不影响告警落库', async (t) => {
  const snapshotDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-snap-fail-'));
  t.after(() => fsp.rm(snapshotDir, { recursive: true, force: true }));
  const store = makeStore();
  const engine = new DetectionEngine({
    store,
    snapshotDir,
    recordingsDir: null,
    enabled: true,
    cooldownMs: 0,
    // 假 FFmpeg 直接抛错：模拟 RTSP 建连失败。
    spawnImpl: () => {
      throw new Error('连接超时');
    },
    logger: { warn: () => undefined },
  });

  for (const shade of [false, true, false, true, false]) {
    await engine.handleFrame(CAMERA, fireFrame(shade));
  }
  assert.equal(store.created.length, 1, '抓拍失败也必须留下告警');
  assert.equal(store.created[0].snapshotFile, null);

  // 给异步分支一点时间，确认不会抛未捕获异常。
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(store.snapshots.length, 0, '失败时不得回填空文件名');
  assert.equal(engine.stats.snapshots, 0);
});

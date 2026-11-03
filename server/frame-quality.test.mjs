import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeFrameQuality } from './frame-quality.mjs';
import { DetectionEngine } from './detection-engine.mjs';
import { openStore } from './store.mjs';
import { SecretBox } from './secrets.mjs';

const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

function makeFrame(fill) {
  const data = Buffer.alloc(FRAME_BYTES);
  for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
    data[p * 4] = fill[0];
    data[p * 4 + 1] = fill[1];
    data[p * 4 + 2] = fill[2];
    data[p * 4 + 3] = 255;
  }
  return data;
}

/** 带纹理的正常画面：灰色底 + 棋盘格噪声，梯度充足。 */
function makeNormalFrame() {
  const data = Buffer.alloc(FRAME_BYTES);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      const noise = (x + y) % 8 < 4 ? 40 : 0;
      data[i] = 110 + noise;
      data[i + 1] = 110 + noise;
      data[i + 2] = 110 + noise;
      data[i + 3] = 255;
    }
  }
  return data;
}

function fakeCamera(id = 'cam-1') {
  return {
    id,
    code: 'CAM-01',
    name: '测试点位',
    zone: '一号区',
    siteId: null,
  };
}

test('analyzeFrameQuality：全黑判 dark、全白判 bright、无纹理判 covered、正常画面 ok', () => {
  const dark = analyzeFrameQuality(makeFrame([2, 2, 3]), WIDTH, HEIGHT);
  assert.equal(dark.ok, false);
  assert.equal(dark.reason, 'dark');

  const bright = analyzeFrameQuality(makeFrame([255, 255, 255]), WIDTH, HEIGHT);
  assert.equal(bright.ok, false);
  assert.equal(bright.reason, 'bright');

  const covered = analyzeFrameQuality(makeFrame([128, 128, 128]), WIDTH, HEIGHT);
  assert.equal(covered.ok, false);
  assert.equal(covered.reason, 'covered');

  const normal = analyzeFrameQuality(makeNormalFrame(), WIDTH, HEIGHT);
  assert.equal(normal.ok, true, `正常画面不应报异常：${JSON.stringify(normal)}`);

  assert.equal(analyzeFrameQuality(Buffer.alloc(10), WIDTH, HEIGHT).ok, true);
});

test('engine 画面质量状态机：持续异常超阈值上报一次，恢复需连续正常', () => {
  const events = [];
  const engine = new DetectionEngine({
    store: { activeAlarmForCamera: () => null },
    onQualityEvent: (camera, event) => events.push({ cameraId: camera.id, ...event }),
    qualityCheck: true,
  });
  const camera = fakeCamera();
  const black = makeFrame([1, 1, 2]);
  const normal = makeNormalFrame();

  // 前几帧异常只是建档，不触发回调。
  engine.trackFrameQuality(camera, black);
  engine.trackFrameQuality(camera, black);
  assert.equal(events.length, 0);

  // 人为把起始时间拨回确认窗口之前，下一帧应触发 abnormal。
  const state = engine.qualityStates.get(camera.id);
  state.firstBadAt = Date.now() - 46_000;
  engine.trackFrameQuality(camera, black);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'abnormal');
  assert.equal(events[0].reason, 'dark');

  // 已上报后继续异常不重复上报。
  engine.trackFrameQuality(camera, black);
  assert.equal(events.length, 1);

  // 正常帧开始恢复计时；未满恢复窗口不触发。
  engine.trackFrameQuality(camera, normal);
  assert.equal(events.length, 1);

  // 拨回恢复窗口之前 → 触发 recovered 并清理状态。
  const recoverState = engine.qualityStates.get(camera.id);
  recoverState.okSince = Date.now() - 11_000;
  engine.trackFrameQuality(camera, normal);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'recovered');
  assert.equal(engine.qualityStates.has(camera.id), false);

  // 类别切换时重新计时：covered 建档后换成 bright 不应沿旧计时上报。
  engine.trackFrameQuality(camera, makeFrame([128, 128, 128]));
  engine.qualityStates.get(camera.id).firstBadAt = Date.now() - 46_000;
  engine.trackFrameQuality(camera, makeFrame([255, 254, 253]));
  assert.equal(events.length, 2, '异常类别变化应重新计时');

  assert.equal(engine.stats.qualityAlarms, 1);
  assert.equal(engine.stats.qualityRecovered, 1);
});

test('V7 迁移：camera_abnormal 告警可落库，cameras.schedule 列就绪', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-quality-'));
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const camera = store.createCamera({
    name: '测试点位',
    zone: '一号区',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
  });
  const alarm = store.createAlarm({
    id: crypto.randomUUID(),
    cameraId: camera.id,
    cameraName: camera.name,
    zone: camera.zone,
    siteId: camera.siteId || store.defaultSiteId,
    level: 'camera_abnormal',
    confidence: 88,
    hotspot: { x: 50, y: 50 },
    actor: { id: null, username: 'server-monitor' },
    eventDetail: '画面过暗或无光，持续 45s',
  });
  assert.equal(alarm.level, 'camera_abnormal');
  assert.equal(store.activeAlarmForCamera(camera.id).id, alarm.id);

  // 归档后 active 清空。
  const archived = store.updateAlarm(
    alarm.id,
    { status: 'archived', archivedAt: Date.now() },
    { id: null, username: 'server-monitor' },
  );
  assert.equal(archived.status, 'archived');
  assert.equal(store.activeAlarmForCamera(camera.id), null);

  // schedule 列存在且可写入（V7 迁移产物）。
  const updated = store.updateCamera(camera.id, { schedule: null });
  assert.ok(updated, 'updateCamera 应正常返回');
  assert.equal(store.schemaVersion, 7);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FlameDetector,
  buildRoiMask,
  countFlicker,
} from './detector.mjs';
import { DetectionEngine, extractFrames } from './detection-engine.mjs';

const WIDTH = 160;
const HEIGHT = 90;

function setPixel(frame, x, y, r, g, b) {
  const i = (y * WIDTH + x) * 4;
  frame[i] = r;
  frame[i + 1] = g;
  frame[i + 2] = b;
  frame[i + 3] = 255;
}

/**
 * 静态纹理背景：避免大面积纯色导致镜头位移估计退化。
 * 纹理非周期，只有 dx=dy=0 能匹配，保证“固定机位”判定成立。
 */
function paintBackground(frame) {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = 80 + ((x * 37 + y * 17) % 60);
      setPixel(frame, x, y, value, value, value);
    }
  }
}

function fireFrame(brightShade) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
  paintBackground(frame);
  const [r, g, b] = brightShade ? [255, 90, 60] : [255, 60, 40];
  for (let y = 20; y < 60; y += 1) {
    for (let x = 40; x < 100; x += 1) {
      setPixel(frame, x, y, r, g, b);
    }
  }
  return frame;
}

function smokeFrame(brightShade) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
  paintBackground(frame);
  const shade = brightShade ? 175 : 150;
  for (let y = 30; y < 60; y += 1) {
    for (let x = 60; x < 100; x += 1) {
      setPixel(frame, x, y, shade, shade, shade);
    }
  }
  return frame;
}

test('flame detector raises fire from a flickering red region', () => {
  const detector = new FlameDetector('standard', 0);
  let result = null;
  for (const shade of [false, true, false, true, false, true]) {
    result = detector.analyze(fireFrame(shade), WIDTH, HEIGHT) ?? result;
  }
  assert.ok(result, '应产出火焰告警');
  assert.equal(result.level, 'fire');
  assert.ok(result.confidence >= 74 && result.confidence <= 98);
  assert.ok(result.hotspot.x > 3 && result.hotspot.x < 97);
  assert.ok(result.hotspot.y > 3 && result.hotspot.y < 97);
});

test('flame detector stays silent on a static scene', () => {
  const detector = new FlameDetector('standard', 0);
  const frame = fireFrame(false);
  let result = null;
  for (let index = 0; index < 8; index += 1) {
    result = detector.analyze(frame, WIDTH, HEIGHT) ?? result;
  }
  assert.equal(result, null);
});

test('flame detector raises smoke for low-saturation moving haze', () => {
  const detector = new FlameDetector('standard', 0);
  let result = null;
  for (const shade of [false, true, false, true, false, true, false, true]) {
    result = detector.analyze(smokeFrame(shade), WIDTH, HEIGHT) ?? result;
  }
  assert.ok(result, '应产出烟雾告警');
  assert.equal(result.level, 'smoke');
  assert.ok(result.confidence >= 63 && result.confidence <= 95);
});

const SMALL_SIZE = 15;

function smallFireFrame(shadeIndex, offsetX = 40) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 4);
  paintBackground(frame);
  const shades = [
    [255, 60, 40],
    [255, 90, 60],
  ];
  const [r, g, b] = shades[shadeIndex % 2];
  for (let y = 40; y < 40 + SMALL_SIZE; y += 1) {
    for (let x = offsetX; x < offsetX + SMALL_SIZE; x += 1) {
      setPixel(frame, x, y, r, g, b);
    }
  }
  return frame;
}

test('buildRoiMask excludes rectangle pixels', () => {
  const mask = buildRoiMask([{ x: 0, y: 0, w: 50, h: 50 }], 10, 10);
  assert.ok(mask);
  assert.equal(mask[0], 0);
  assert.equal(mask[4 * 10 + 4], 0);
  assert.equal(mask[5 * 10 + 5], 1);
  assert.equal(mask[9 * 10 + 9], 1);
  assert.equal(buildRoiMask([], 10, 10), null);
});

test('countFlicker counts brightness direction changes', () => {
  assert.equal(countFlicker([100, 102]), 0);
  assert.equal(countFlicker([100, 110, 100, 110]), 2);
  assert.equal(countFlicker([100, 101, 100, 101]), 0);
});

test('roi mask suppresses fire inside the masked area', () => {
  const detector = new FlameDetector('standard', 0);
  const mask = buildRoiMask([{ x: 20, y: 10, w: 55, h: 60 }], WIDTH, HEIGHT);
  let result = null;
  for (const shade of [false, true, false, true, false, true]) {
    result = detector.analyze(fireFrame(shade), WIDTH, HEIGHT, { mask }) ?? result;
  }
  assert.equal(result, null);
});

test('small flickering fire is detected but steady red object is not', () => {
  const flickering = new FlameDetector('standard', 0);
  let flickerResult = null;
  for (let index = 0; index < 14; index += 1) {
    flickerResult =
      flickering.analyze(smallFireFrame(index), WIDTH, HEIGHT) ?? flickerResult;
  }
  assert.ok(flickerResult, '小面积闪烁火焰应被检出');
  assert.equal(flickerResult.level, 'fire');

  const steady = new FlameDetector('standard', 0);
  let steadyResult = null;
  for (let index = 0; index < 14; index += 1) {
    steadyResult =
      steady.analyze(smallFireFrame(0, index % 2 ? 20 : 70), WIDTH, HEIGHT) ??
      steadyResult;
  }
  assert.equal(steadyResult, null, '无闪烁的小面积红色物体应被抑制');
});

test('flame detector ignores short buffers', () => {
  const detector = new FlameDetector();
  assert.equal(detector.analyze(Buffer.alloc(16), WIDTH, HEIGHT), null);
  assert.equal(detector.analyze(Buffer.alloc(WIDTH * HEIGHT * 4), 0, 0), null);
});

test('extractFrames slices complete frames and keeps the remainder', () => {
  const frameBytes = 8;
  const buffer = Buffer.alloc(frameBytes * 2 + 3, 1);
  const { frames, rest } = extractFrames(buffer, frameBytes);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, frameBytes);
  assert.equal(frames[1].length, frameBytes);
  assert.equal(rest.length, 3);

  const none = extractFrames(Buffer.alloc(3), frameBytes);
  assert.equal(none.frames.length, 0);
  assert.equal(none.rest.length, 3);
});

test('detection engine writes one alarm and suppresses duplicates', async () => {
  const created = [];
  let active = null;
  const store = {
    activeAlarmForCamera: () => active,
    createAlarm: (alarm) => {
      created.push(alarm);
      active = { ...alarm, status: 'pending' };
      return active;
    },
  };
  const engine = new DetectionEngine({
    store,
    snapshotDir: null,
    enabled: true,
    sensitivity: 'standard',
    cooldownMs: 0,
    logger: { warn: () => undefined },
  });
  const camera = {
    id: 'cam-1',
    code: 'CAM-01',
    name: '一号点位',
    zone: 'A 区',
    protocol: 'rtsp',
    sourceUrl: 'rtsp://example/stream',
    enabled: true,
  };

  for (const shade of [false, true, false, true, false]) {
    await engine.handleFrame(camera, fireFrame(shade));
  }
  assert.equal(created.length, 1);
  assert.equal(created[0].level, 'fire');
  assert.equal(created[0].cameraId, 'cam-1');
  assert.equal(created[0].cameraName, '一号点位');
  assert.equal(created[0].snapshotFile, null);

  // 已有未处置告警时不再重复创建。
  for (const shade of [false, true, false, true, false]) {
    await engine.handleFrame(camera, fireFrame(shade));
  }
  assert.equal(created.length, 1);
  assert.equal(engine.stats.alarms, 1);
  assert.ok(engine.stats.duplicates >= 1);
});

test('detection engine records a clip and attaches it to the alarm', async () => {
  const recordingsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-clip-'));
  const created = [];
  let active = null;
  let clipUpdate = null;
  const store = {
    defaultSiteId: 'site-1',
    activeAlarmForCamera: () => active,
    createAlarm: (alarm) => {
      created.push(alarm);
      active = { ...alarm, status: 'pending', clipFile: null };
      return active;
    },
    setAlarmClip: (id, file) => {
      clipUpdate = { id, file };
      return { ...active, clipFile: file, clip: `/api/alarms/${id}/clip` };
    },
    addAlarmEvent: () => undefined,
    updateAlarm: () => active,
  };
  const clips = [];
  const fakeSpawn = (_command, args) => {
    const child = new EventEmitter();
    child.kill = () => undefined;
    const target = args[args.length - 1];
    setTimeout(() => {
      fsSync.writeFileSync(target, 'fake-mp4');
      child.emit('exit', 0);
    }, 0);
    return child;
  };
  const engine = new DetectionEngine({
    store,
    recordingsDir,
    snapshotDir: null,
    enabled: true,
    cooldownMs: 0,
    spawnImpl: fakeSpawn,
    logger: { warn: () => undefined },
    onClip: (alarm) => clips.push(alarm),
  });
  const camera = {
    id: 'cam-clip',
    code: 'CAM-C',
    name: '短视频点位',
    zone: 'A 区',
    protocol: 'http',
    sourceUrl: 'http://example.com/live.mp4',
    enabled: true,
    siteId: 'site-1',
  };

  for (const shade of [false, true, false, true, false]) {
    await engine.handleFrame(camera, fireFrame(shade));
  }
  assert.equal(created.length, 1);

  const deadline = Date.now() + 3000;
  while (!clipUpdate && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(clipUpdate, '应生成并回写短视频');
  assert.equal(clipUpdate.id, created[0].id);
  assert.equal(clipUpdate.file, `${created[0].id}.mp4`);
  assert.equal(clips.length, 1);
  assert.equal(engine.stats.clips, 1);

  await fsp.rm(recordingsDir, { recursive: true, force: true });
});

test('detection engine only supervises enabled cameras with a supported source', () => {
  const engine = new DetectionEngine({
    store: { activeAlarmForCamera: () => null, createAlarm: () => ({}) },
    enabled: true,
    logger: { warn: () => undefined },
  });
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: 'rtsp://x', protocol: 'rtsp' }),
    true,
  );
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: 'http://x/a.m3u8', protocol: 'hls' }),
    true,
  );
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: 'http://x/a.mp4', protocol: 'http' }),
    true,
  );
  assert.equal(
    engine.supports({ enabled: false, sourceUrl: 'rtsp://x', protocol: 'rtsp' }),
    false,
  );
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: '', protocol: 'rtsp' }),
    false,
  );
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: 'rtsp://x', protocol: 'none' }),
    false,
  );
  assert.equal(
    engine.supports({ enabled: true, sourceUrl: 'edge://a/b', protocol: 'edge' }),
    false,
  );
  assert.equal(
    engine.supports({
      enabled: true,
      detectEnabled: false,
      sourceUrl: 'rtsp://x',
      protocol: 'rtsp',
    }),
    false,
  );
});

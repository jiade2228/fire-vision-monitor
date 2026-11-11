import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DetectionEngine } from './detection-engine.mjs';

/** 假的 FFmpeg 子进程：只提供接口，不产生任何输出。 */
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  return child;
}

function makeStore() {
  return {
    defaultSiteId: 'site-a',
    activeAlarmForCamera: () => null,
    createAlarm: () => ({}),
    setAlarmClip: () => ({}),
    addAlarmEvent: () => undefined,
    updateAlarm: () => ({}),
  };
}

function camera(id, siteId) {
  return {
    id,
    code: `CAM-${id}`,
    name: `点位 ${id}`,
    zone: 'A 区',
    protocol: 'rtsp',
    sourceUrl: `rtsp://admin:secret@10.0.0.${id.length}/stream`,
    siteId,
    enabled: true,
  };
}

test('检测状态按站点过滤：站点管理员看不到其它站点的点位', () => {
  const engine = new DetectionEngine({
    store: makeStore(),
    snapshotDir: null,
    enabled: true,
    spawnImpl: fakeSpawn,
    logger: { warn: () => undefined },
  });
  engine.sync([camera('a1', 'site-a'), camera('b1', 'site-b')]);
  try {
    const all = engine.status();
    assert.equal(all.cameras.length, 2, '全局管理员看到全部点位');

    const filtered = engine.status({ allowedSiteIds: ['site-a'] });
    assert.equal(filtered.cameras.length, 1);
    assert.equal(filtered.cameras[0].siteId, 'site-a');
    assert.ok(
      filtered.cameras.every((item) => item.siteId === 'site-a'),
      '过滤后不应残留其它站点的点位',
    );
  } finally {
    engine.stopAll?.();
    engine.stop?.();
  }
});

test('FFmpeg stderr 写入 lastError 前已抹除 URL 里的凭据', () => {
  const engine = new DetectionEngine({
    store: makeStore(),
    snapshotDir: null,
    enabled: true,
    spawnImpl: fakeSpawn,
    logger: { warn: () => undefined },
  });
  engine.sync([camera('c1', 'site-a')]);
  try {
    const worker = engine.workers.get('c1');
    assert.ok(worker, '应创建常驻 worker');
    worker.child.stderr.emit(
      'data',
      Buffer.from(
        "[rtsp @ 0x1] Opening 'rtsp://admin:Sup3rSecret@10.0.0.1:554/stream' failed",
      ),
    );
    assert.doesNotMatch(worker.lastError ?? '', /Sup3rSecret/);
    assert.match(worker.lastError ?? '', /rtsp:\/\/\*\*\*@10\.0\.0\.1:554/);

    // 状态接口回传的也是脱敏后的文本。
    const status = engine.status();
    assert.doesNotMatch(JSON.stringify(status), /Sup3rSecret/);
  } finally {
    engine.stopAll?.();
    engine.stop?.();
  }
});

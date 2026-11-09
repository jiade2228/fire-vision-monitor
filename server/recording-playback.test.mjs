import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PLAYBACK_WINDOW_MS,
  parsePlaybackWindow,
  selectSegments,
  safeSegmentPath,
  concatListContent,
  buildHlsArgs,
  buildExportArgs,
  PlaybackSessionManager,
  exportRecordingToMp4,
} from './recording-playback.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-playback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

const segments = [
  { file: 'cam-01/20261103/120000.ts', startedAt: 1000, endedAt: 2000, bytes: 10 },
  { file: 'cam-01/20261103/120100.ts', startedAt: 2000, endedAt: 3000, bytes: 10 },
  { file: 'cam-01/20261103/120200.ts', startedAt: 3000, endedAt: 4000, bytes: 10 },
];

test('窗口校验：非数字、倒置、零长度与超限', () => {
  assert.deepEqual(parsePlaybackWindow({ from: '1000', to: '2000' }), { from: 1000, to: 2000 });
  assert.equal(parsePlaybackWindow({ from: 'x', to: '2000' }), null);
  assert.equal(parsePlaybackWindow({ from: 2000, to: 1000 }), null);
  assert.equal(parsePlaybackWindow({ from: 1000, to: 1000 }), null);
  assert.equal(parsePlaybackWindow({ from: Infinity, to: 2000 }), null);
  assert.equal(
    parsePlaybackWindow({ from: 0, to: MAX_PLAYBACK_WINDOW_MS + 1 }),
    null,
  );
  assert.deepEqual(
    parsePlaybackWindow({ from: 0, to: 1000 }, { maxWindowMs: 1000 }),
    { from: 0, to: 1000 },
  );
});

test('选段：半开区间重叠、按时间排序、去重与限流', () => {
  assert.deepEqual(
    selectSegments([...segments].reverse(), 1500, 3500),
    [
      'cam-01/20261103/120000.ts',
      'cam-01/20261103/120100.ts',
      'cam-01/20261103/120200.ts',
    ],
  );
  // 边界：endedAt === from 或 startedAt === to 不算重叠。
  assert.deepEqual(selectSegments(segments, 2000, 3000), [
    'cam-01/20261103/120100.ts',
  ]);
  const duplicated = [...segments, segments[0]];
  assert.equal(selectSegments(duplicated, 0, 9999).length, 3);
  assert.equal(selectSegments(segments, 0, 9999, { maxSegments: 2 }).length, 2);
  assert.deepEqual(selectSegments(undefined, 0, 100), []);
});

test('safeSegmentPath：拒绝穿越、绝对路径与非法形态', () => {
  const root = path.join(os.tmpdir(), 'fire-continuous');
  assert.equal(
    safeSegmentPath(root, 'cam-01/20261103/120000.ts'),
    path.join(root, 'cam-01', '20261103', '120000.ts'),
  );
  for (const bad of [
    '../cam-01/20261103/120000.ts',
    'cam-01/../../etc/passwd',
    '/etc/passwd',
    'cam-01/20261103/120000.mp4',
    'cam-01/20261103/120000.ts/../evil',
    'cam-01/2026113/120000.ts',
    null,
  ]) {
    assert.equal(safeSegmentPath(root, bad), null, `应拒绝 ${String(bad)}`);
  }
});

test('concat 列表：单引号转义与 Windows 反斜杠归一', () => {
  const text = concatListContent([
    "C:\\data\\continuous\\cam-01\\20261103\\120000.ts",
    "cam-01/20261103/o'clock.ts",
  ]);
  assert.ok(text.includes("file 'C:/data/continuous/cam-01/20261103/120000.ts'"));
  assert.ok(text.includes("file 'cam-01/20261103/o'\\''clock.ts'"));
  assert.ok(text.endsWith('\n'));
});

test('HLS / 导出参数：copy、VOD 列表与 concat 输入', () => {
  const hls = buildHlsArgs({
    listFile: '/tmp/list.txt',
    playlist: '/tmp/index.m3u8',
    segmentPattern: '/tmp/segment-%05d.ts',
  });
  assert.ok(hls.includes('concat'));
  assert.ok(hls.includes('-hls_list_size'));
  assert.ok(hls.includes('0'));
  assert.ok(hls.includes('independent_segments+temp_file'));
  assert.equal(hls.at(-1), '/tmp/index.m3u8');

  const exp = buildExportArgs({ listFile: '/tmp/list.txt', target: '/tmp/out.mp4' });
  assert.ok(exp.includes('+faststart'));
  assert.ok(exp.includes('make_zero'));
  assert.equal(exp.at(-1), '/tmp/out.mp4');
});

test('会话：创建、续期、过期回收、并发淘汰与文件白名单', async (t) => {
  const root = await tempDir(t);
  const continuous = await tempDir(t);
  let now = 1_000_000;
  const children = [];
  const manager = new PlaybackSessionManager({
    rootDir: root,
    continuousDir: continuous,
    maxSessions: 2,
    idleMs: 1000,
    now: () => now,
    logger: { warn: () => undefined },
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });

  const created = await manager.create({
    userId: 'u1',
    cameraId: 'cam-01',
    siteId: 'site-a',
    from: 1000,
    to: 4000,
    files: segments.map((item) => item.file),
  });
  assert.ok(created);
  assert.match(created.playlist, /^\/api\/recordings\/play\/[a-f0-9]{24}\/index\.m3u8$/);
  assert.equal(created.segmentCount, 3);
  assert.equal(manager.status().active, 1);
  const list = await fs.readFile(path.join(root, created.sessionId, 'list.txt'), 'utf8');
  assert.ok(list.includes('cam-01/20261103/120000.ts'));

  const session = manager.touch(created.sessionId);
  assert.equal(session.userId, 'u1');
  assert.equal(session.siteId, 'site-a');
  assert.equal(manager.filePath(session, 'index.m3u8'), path.join(session.dir, 'index.m3u8'));
  assert.equal(manager.filePath(session, 'segment-00001.ts'), path.join(session.dir, 'segment-00001.ts'));
  assert.equal(manager.filePath(session, '../../app.db'), null);
  assert.equal(manager.filePath(session, 'list.txt'), null);

  // 推进到过期：idleMs 有 10s 下限钳制，需跨过整个空闲窗口。
  now += 20_000;
  assert.equal(manager.touch(created.sessionId), null);
  assert.equal(manager.status().active, 0);
  assert.equal(children[0].killed, true);

  // 并发上限：创建 3 个会话，最旧的被淘汰，只保留 2 个。
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const item = await manager.create({
      userId: 'u2',
      cameraId: 'cam-01',
      from: 1000,
      to: 4000,
      files: segments.map((segment) => segment.file),
    });
    ids.push(item.sessionId);
    now += 1;
  }
  assert.equal(manager.status().active, 2);
  assert.equal(manager.touch(ids[0]), null);
  assert.ok(manager.touch(ids[2]));

  // 无可用段 / 全部非法路径时不创建会话。
  assert.equal(
    await manager.create({ userId: 'u2', cameraId: 'cam-01', from: 0, to: 1, files: [] }),
    null,
  );
  assert.equal(
    await manager.create({
      userId: 'u2',
      cameraId: 'cam-01',
      from: 0,
      to: 1,
      files: ['../../etc/passwd'],
    }),
    null,
  );

  await manager.stopAll();
  assert.equal(manager.status().active, 0);
});

test('导出：成功返回文件、失败清理临时产物', async (t) => {
  const continuous = await tempDir(t);
  const exportDir = await tempDir(t);
  const spawnImpl = (_bin, args) => {
    const child = fakeChild();
    setImmediate(() => {
      // 模拟 FFmpeg 成功写出目标文件（命令行最后一个参数是输出路径）。
      fsSync.writeFileSync(args.at(-1), 'fake-mp4');
      child.emit('exit', 0);
    });
    return child;
  };
  const target = await exportRecordingToMp4({
    files: segments.map((item) => item.file),
    continuousDir: continuous,
    exportDir,
    spawnImpl,
    timeoutMs: 1000,
  });
  assert.ok(target && target.endsWith('.mp4'));
  assert.equal(await fs.readFile(target, 'utf8'), 'fake-mp4');
  assert.equal((await fs.readdir(exportDir)).filter((name) => name.endsWith('.txt')).length, 0);
  await fs.rm(target, { force: true });

  const failing = (_bin, _args) => {
    const child = fakeChild();
    setImmediate(() => child.emit('exit', 1));
    return child;
  };
  assert.equal(
    await exportRecordingToMp4({
      files: segments.map((item) => item.file),
      continuousDir: continuous,
      exportDir,
      spawnImpl: failing,
      timeoutMs: 1000,
    }),
    null,
  );
  assert.deepEqual(await fs.readdir(exportDir), []);
  assert.equal(
    await exportRecordingToMp4({
      files: [],
      continuousDir: continuous,
      exportDir,
      spawnImpl: failing,
    }),
    null,
  );
});

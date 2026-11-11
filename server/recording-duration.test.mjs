import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { probeSegmentDurations } from './recording-duration.mjs';

/**
 * 构造一个假的 ffprobe 子进程：在下一 tick 回吐 stdout 并以指定退出码结束。
 * probeOne 通过 `child.stdout.on('data')` 与 `child.on('exit')` 通信。
 */
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    calls.push({ command, args });
    const behavior = script(args);
    setImmediate(() => {
      if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout));
      child.emit('exit', behavior.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

async function makeRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'segdur-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('probeSegmentDurations：只探测「名义时长附近」的未校准段', async (t) => {
  const rootDir = await makeRoot(t);
  await fs.mkdir(path.join(rootDir, 'cam', '20261111'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'cam', '20261111', '000000.ts'), 'x');

  const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '61.5\n', code: 0 }));
  const durations = await probeSegmentDurations({
    segments: [
      // 名义 60s，接近 → 应被探测
      {
        file: 'cam/20261111/000000.ts',
        startedAt: 1_000,
        endedAt: 61_000,
      },
      // 已明显偏离名义值（可能已校准）→ 跳过
      {
        file: 'cam/20261111/000001.ts',
        startedAt: 1_000,
        endedAt: 90_500,
      },
    ],
    rootDir,
    spawnImpl,
    nominalMs: 60_000,
  });

  assert.equal(calls.length, 1, '只应探测 1 段');
  assert.equal(durations.get('cam/20261111/000000.ts'), 61_500, '秒→毫秒换算正确');
  assert.equal(durations.has('cam/20261111/000001.ts'), false, '已偏离的段不应被探测');
});

test('probeSegmentDurations：maxProbes 限制单轮 IO', async (t) => {
  const rootDir = await makeRoot(t);
  await fs.mkdir(path.join(rootDir, 'cam', '20261111'), { recursive: true });
  const segments = [];
  for (let i = 0; i < 10; i += 1) {
    const name = `00000${i}.ts`;
    await fs.writeFile(path.join(rootDir, 'cam', '20261111', name), 'x');
    segments.push({
      file: `cam/20261111/${name}`,
      startedAt: 1_000,
      endedAt: 61_000,
    });
  }
  const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '60\n', code: 0 }));
  await probeSegmentDurations({ segments, rootDir, spawnImpl, nominalMs: 60_000, maxProbes: 3 });
  assert.equal(calls.length, 3, 'maxProbes 应限制探测次数');
});

test('probeSegmentDurations：ffprobe 失败或输出非法时不计入结果', async (t) => {
  const rootDir = await makeRoot(t);
  await fs.mkdir(path.join(rootDir, 'cam', '20261111'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'cam', '20261111', 'bad.ts'), 'x');
  await fs.writeFile(path.join(rootDir, 'cam', '20261111', 'err.ts'), 'x');

  const { spawnImpl } = fakeSpawn((args) => {
    if (args.includes('bad.ts')) return { stdout: 'not-a-number\n', code: 0 };
    return { stdout: '', code: 1 };
  });
  const durations = await probeSegmentDurations({
    segments: [
      { file: 'cam/20261111/bad.ts', startedAt: 1_000, endedAt: 61_000 },
      { file: 'cam/20261111/err.ts', startedAt: 1_000, endedAt: 61_000 },
    ],
    rootDir,
    spawnImpl,
    nominalMs: 60_000,
  });
  assert.equal(durations.size, 0, '非法输出与失败退出都不应写入结果');
});

test('probeSegmentDurations：路径逃逸的段被跳过（不探测目录外文件）', async (t) => {
  const rootDir = await makeRoot(t);
  const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '60\n', code: 0 }));
  const durations = await probeSegmentDurations({
    segments: [
      { file: '../../etc/passwd', startedAt: 1_000, endedAt: 61_000 },
      { file: '/etc/passwd', startedAt: 1_000, endedAt: 61_000 },
    ],
    rootDir,
    spawnImpl,
    nominalMs: 60_000,
  });
  assert.equal(calls.length, 0, '越界路径不应触发 ffprobe');
  assert.equal(durations.size, 0);
});

test('probeSegmentDurations：空输入与非法参数安全返回', async () => {
  const durations = await probeSegmentDurations({ segments: [], rootDir: os.tmpdir() });
  assert.equal(durations.size, 0);
  // 缺 rootDir 时不应抛错
  const noRoot = await probeSegmentDurations({ segments: [{ file: 'a.ts', startedAt: 0, endedAt: 60_000 }] });
  assert.equal(noRoot.size, 0);
});

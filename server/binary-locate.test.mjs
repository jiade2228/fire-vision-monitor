import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyResolvedBinaries,
  candidateDirs,
  findInPath,
  readFileDescriptorLimit,
  resolveExecutable,
} from './binary-locate.mjs';

/**
 * 可执行文件定位的跨平台行为。
 *
 * 依据：macOS 经 launchd 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * Homebrew 的 /opt/homebrew/bin 不在其中，导致 ffmpeg 找不到。
 * 关键是**不能改变现有行为**：显式配置优先、PATH 能找到就用原名——
 * 只有 PATH 未命中时才回退到常见安装目录。
 */

test('candidateDirs：各平台返回对应目录且 macOS 含 Homebrew 两个位置', () => {
  const mac = candidateDirs('darwin');
  assert.ok(mac.includes('/opt/homebrew/bin'), 'Apple Silicon Homebrew');
  assert.ok(mac.includes('/usr/local/bin'), 'Intel Homebrew');
  assert.ok(candidateDirs('linux').includes('/usr/bin'));
  assert.ok(candidateDirs('win32').some((dir) => dir.includes('Program Files')));
});

test('resolveExecutable：显式配置最高优先，且不改写', () => {
  const result = resolveExecutable('ffmpeg', {
    configured: '/custom/bin/ffmpeg',
    pathEnv: '/usr/bin',
    exists: () => true,
  });
  assert.equal(result.command, '/custom/bin/ffmpeg');
  assert.equal(result.source, 'configured');
});

test('resolveExecutable：PATH 命中时返回裸名（保持原有行为）', () => {
  const result = resolveExecutable('ffmpeg', {
    configured: '',
    pathEnv: '/usr/local/bin:/usr/bin',
    platform: 'linux',
    exists: (p) => p === '/usr/local/bin/ffmpeg',
  });
  assert.equal(result.command, 'ffmpeg', 'PATH 能解析时不应改成绝对路径');
  assert.equal(result.source, 'path');
  assert.equal(result.dir, '/usr/local/bin');
});

test('resolveExecutable：PATH 未命中时回退到常见安装目录', () => {
  const result = resolveExecutable('ffmpeg', {
    configured: '',
    pathEnv: '/usr/bin:/bin',
    platform: 'darwin',
    dirs: ['/opt/homebrew/bin'],
    exists: (p) => p === '/opt/homebrew/bin/ffmpeg',
  });
  assert.equal(result.command, '/opt/homebrew/bin/ffmpeg');
  assert.equal(result.source, 'fallback-dir');
});

test('resolveExecutable：全部未命中时返回原名，不抛错', () => {
  const result = resolveExecutable('ffprobe', {
    configured: '',
    pathEnv: '/nonexistent',
    platform: 'linux',
    dirs: ['/also-missing'],
    exists: () => false,
  });
  assert.equal(result.command, 'ffprobe');
  assert.equal(result.source, 'not-found');
});

test('findInPath：Windows 使用分号分隔并尝试 .exe 后缀', () => {
  const dir = findInPath('ffmpeg', {
    pathEnv: 'C:\\a;C:\\tools',
    platform: 'win32',
    exists: (p) => p === 'C:\\tools\\ffmpeg.exe',
  });
  assert.equal(dir, 'C:\\tools');
});

test('findInPath：空条目与空 PATH 安全处理', () => {
  assert.equal(findInPath('ffmpeg', { pathEnv: '', platform: 'linux', exists: () => true }), null);
  assert.equal(
    findInPath('ffmpeg', { pathEnv: '::', platform: 'linux', exists: () => false }),
    null,
  );
});

test('applyResolvedBinaries：仅在回退命中时写环境变量', () => {
  const env = { PATH: '/usr/bin', FFMPEG_PATH: '', FFPROBE_PATH: '' };
  // 通过真实 PATH 通常找不到 ffmpeg 的沙箱目录，这里依赖 platform 默认值；
  // 只要不抛错、返回结构完整即可（具体命中与否取决于运行环境）。
  const result = applyResolvedBinaries(env);
  assert.equal(typeof result.ffmpeg, 'object');
  assert.equal(typeof result.ffprobe, 'object');
  assert.ok(Array.isArray(result.changed));
  for (const key of result.changed) {
    assert.ok(['FFMPEG_PATH', 'FFPROBE_PATH'].includes(key));
    assert.ok(env[key].length > 0);
  }
});

test('applyResolvedBinaries：显式配置不被覆盖', () => {
  const env = { PATH: '', FFMPEG_PATH: '/opt/custom/ffmpeg', FFPROBE_PATH: '/opt/custom/ffprobe' };
  const result = applyResolvedBinaries(env);
  assert.equal(env.FFMPEG_PATH, '/opt/custom/ffmpeg');
  assert.equal(env.FFPROBE_PATH, '/opt/custom/ffprobe');
  assert.equal(result.changed.length, 0);
});

test('readFileDescriptorLimit：解析 ulimit 输出', async () => {
  const limit = await readFileDescriptorLimit({
    platform: 'darwin',
    execImpl: async () => '4096\n',
  });
  assert.equal(limit, 4096);
});

test('readFileDescriptorLimit：非法输出与执行失败都返回 null', async () => {
  assert.equal(
    await readFileDescriptorLimit({ platform: 'darwin', execImpl: async () => 'unlimited' }),
    null,
  );
  assert.equal(
    await readFileDescriptorLimit({
      platform: 'linux',
      execImpl: async () => { throw new Error('sh missing'); },
    }),
    null,
  );
  // Windows 不适用
  assert.equal(await readFileDescriptorLimit({ platform: 'win32' }), null);
});

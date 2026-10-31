import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { DemoSource, DemoSourceError, demoFilter } from './demo-source.mjs';

/** 用假 FFmpeg 替换真实进程：只负责落地播放列表，保证测试不依赖本机 FFmpeg。 */
function fakeSpawn(source, { fail = false } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.stderr = new EventEmitter();
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('exit', 0);
      }
      return true;
    };
    const timer = setTimeout(() => {
      if (fail) {
        child.exitCode = 1;
        child.stderr.emit('data', Buffer.from('boom'));
        child.emit('exit', 1);
        return;
      }
      void fsp
        .mkdir(source.directory, { recursive: true })
        .then(() =>
          Promise.all([
            fsp.writeFile(
              path.join(source.directory, 'index.m3u8'),
              '#EXTM3U\n#EXTINF:2.000000,\nseg-00000.ts\n',
            ),
            fsp.writeFile(path.join(source.directory, 'seg-00000.ts'), Buffer.alloc(16)),
          ]),
        )
        .catch(() => undefined);
    }, 5);
    timer.unref?.();
    return child;
  };
}

async function withDemo(fn) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-demo-'));
  const source = new DemoSource({ dataDir, logger: { warn: () => {}, info: () => {} } });
  source.child = null;
  source.spawnImpl = fakeSpawn(source);
  source.ffmpegAvailable = true;
  try {
    await fn(source);
  } finally {
    source.stop();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('demoFilter 生成连续递增的合成滤镜链', () => {
  const filter = demoFilter({ width: 640, height: 360, fps: 15 });
  assert.equal(filter.startsWith('testsrc2=s=640x360:r=15,'), true);
  // 两块暖色方块按 1 秒周期交替，形成火焰明暗闪烁
  assert.equal(filter.includes("enable='lt(mod(t,2),1)'"), true);
  assert.equal(filter.includes("enable='gte(mod(t,2),1)'"), true);
  assert.equal((filter.match(/drawbox=/g) ?? []).length, 2);
});

test('FFmpeg 命令包含实时虚拟输入与滚动删除的 HLS 输出', () => {
  const source = new DemoSource({ dataDir: '/tmp/demo-args' });
  const args = source.buildArgs();
  const joined = args.join(' ');
  assert.equal(args.includes('-re'), true, 'lavfi 需要 -re 才按帧率实时产出');
  assert.equal(joined.includes('-f lavfi -i testsrc2'), true);
  assert.equal(joined.includes('-f hls'), true);
  assert.equal(joined.includes('delete_segments+omit_endlist'), true);
  assert.equal(args.at(-1).endsWith('index.m3u8'), true);
  // 数值型参数不能出现 NaN（曾经因 clamp 参数顺序写错导致 -hls_time NaN）
  assert.equal(
    args.some((arg) => String(arg).includes('NaN')),
    false,
    `命令参数包含 NaN：${args.join(' ')}`,
  );
  const hlsTimeIndex = args.indexOf('-hls_time');
  assert.equal(Number.isFinite(Number(args[hlsTimeIndex + 1])), true);
});

test('缺少 FFmpeg 时启动被拒绝且返回 503', async () => {
  const source = new DemoSource({
    dataDir: '/tmp/demo-nope',
    logger: { warn: () => {}, info: () => {} },
  });
  source.ffmpegAvailable = false;
  await assert.rejects(
    () => source.start({ timeoutMs: 1000 }),
    (error) => error instanceof DemoSourceError && error.status === 503,
  );
});

test('启动后播放列表可读取，令牌一次一变且停止后失效', async () => {
  await withDemo(async (source) => {
    const state = await source.start();
    assert.equal(state.running, true);
    assert.equal(state.playlistUrl.startsWith('/demo/'), true);
    const token = state.playlistUrl.split('/')[2];
    assert.equal(source.verifyToken(token), true);
    assert.equal(source.verifyToken('deadbeef'), false);

    const playlist = await source.playlist();
    assert.equal(playlist.includes('#EXTINF'), true);
    assert.equal(source.segmentPath('seg-00000.ts').endsWith('seg-00000.ts'), true);
    // 目录穿越必须被拒绝
    assert.equal(source.segmentPath('../index.m3u8'), null);
    assert.equal(source.segmentPath('evil.txt'), null);

    source.stop();
    assert.equal(source.running, false);
    assert.equal(source.status().playlistUrl, null);
    assert.equal(source.verifyToken(token), false);
  });
});

test('二次启动复用同一进程，停止后目录被清理', async () => {
  await withDemo(async (source) => {
    const first = await source.start();
    const process = source.child;
    const second = await source.start();
    assert.equal(source.child, process, '重复调用不应重启 FFmpeg');
    assert.equal(first.playlistUrl, second.playlistUrl);

    source.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(() => fsp.stat(source.directory));
  });
});

test('FFmpeg 中途退出时演示源进入错误态', async () => {
  await withDemo(async (source) => {
    source.spawnImpl = fakeSpawn(source, { fail: true });
    await assert.rejects(() => source.start({ timeoutMs: 1500 }));
    assert.equal(source.running, false);
    assert.match(source.lastError ?? '', /演示流中断|等待演示视频源超时/);
    assert.equal(source.status().running, false);
  });
});

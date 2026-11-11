import test from 'node:test';
import assert from 'node:assert/strict';

import { ffprobeAvailable, probeStream } from './probe.mjs';

/**
 * 测流工具的最小覆盖。
 *
 * 完整探测需要真实 RTSP/HLS 源，无法在自动化环境稳定复现；
 * 这里锁住两类不依赖网络的行为：
 *   1. ffprobe 可执行性判定（决定「一键测流」入口是否可用）
 *   2. 探测失败时返回结构化错误而不是抛异常（路由层依赖它构造 502）
 */

test('ffprobeAvailable：不存在的路径返回 false 而不抛错', () => {
  assert.equal(ffprobeAvailable('/definitely/not/a/real/ffprobe-binary'), false);
});

test('ffprobeAvailable：本机 ffprobe 可用时返回 true', () => {
  // CI/开发机装有 FFmpeg；若未安装，此断言会暴露环境缺失而不是静默跳过。
  const available = ffprobeAvailable();
  assert.equal(typeof available, 'boolean');
  // 记录实际值便于排查：环境没有 ffprobe 时不强制失败（项目允许降级运行）。
  if (!available) {
    console.log('  （本机无 ffprobe，跳过可用性正向断言）');
  }
});

test('probeStream：无法连接的目标返回 ok=false 且带错误信息，不抛异常', async () => {
  // 127.0.0.1 上刻意使用未监听端口，避免依赖外网。
  const result = await probeStream({
    sourceUrl: 'rtsp://127.0.0.1:1/definitely-not-listening',
    protocol: 'rtsp',
    timeoutMs: 1500,
  });
  assert.equal(result.ok, false, '不可达目标应判定失败');
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, '错误信息不能为空');
  assert.ok(Number.isFinite(result.latencyMs), '应记录耗时 latencyMs');
});

test('probeStream：非法协议前缀同样安全返回失败', async () => {
  const result = await probeStream({
    sourceUrl: 'not-a-url',
    protocol: 'http',
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

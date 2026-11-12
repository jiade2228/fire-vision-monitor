import test from 'node:test';
import assert from 'node:assert/strict';
import { inputTimeoutArgs } from './ffmpeg-input.mjs';

test('RTSP 输入使用 -timeout，不使用 FFmpeg 拒绝的 -rw_timeout', () => {
  const args = inputTimeoutArgs({ isRtsp: true });
  assert.deepEqual(args, ['-timeout', '15000000']);
  assert.ok(!args.includes('-rw_timeout'));
});

test('非 RTSP 输入继续使用 -rw_timeout', () => {
  assert.deepEqual(inputTimeoutArgs({ isRtsp: false }), ['-rw_timeout', '15000000']);
});

test('可覆盖超时值，单位为微秒', () => {
  assert.deepEqual(inputTimeoutArgs({ isRtsp: true, timeoutUs: 11_000_000 }), ['-timeout', '11000000']);
});

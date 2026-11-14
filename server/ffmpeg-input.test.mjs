import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inputTimeoutArgs,
  parseFfmpegMajorVersion,
  rtspTimeoutOptionForMajor,
} from './ffmpeg-input.mjs';

test('FFmpeg 4.x 的 RTSP 输入使用 -stimeout（微秒），且不带 -rw_timeout 与裸 -timeout', () => {
  const args = inputTimeoutArgs({ isRtsp: true, majorVersion: 4 });
  assert.deepEqual(args, ['-stimeout', '15000000']);
  assert.ok(!args.includes('-rw_timeout'), 'RTSP 不能出现 -rw_timeout');
  assert.ok(
    !args.includes('-timeout'),
    '4.x 的 -timeout 是 listen_timeout 别名，会把客户端切成监听模式',
  );
});

test('FFmpeg 5.x 及以上的 RTSP 输入使用 -timeout（微秒）', () => {
  const args = inputTimeoutArgs({ isRtsp: true, majorVersion: 9 });
  assert.deepEqual(args, ['-timeout', '15000000']);
  assert.ok(!args.includes('-rw_timeout'), 'RTSP 不能出现 -rw_timeout');
  assert.ok(!args.includes('-stimeout'), '5.x 起已更名为 timeout');
});

test('非 RTSP（HLS/HTTP/edge）继续使用 -rw_timeout，与版本无关', () => {
  for (const majorVersion of [4, 5, 9]) {
    assert.deepEqual(inputTimeoutArgs({ isRtsp: false, majorVersion }), [
      '-rw_timeout',
      '15000000',
    ]);
  }
  assert.deepEqual(inputTimeoutArgs({ isRtsp: false }), ['-rw_timeout', '15000000']);
});

test('可覆盖超时值，单位为微秒，分支不变', () => {
  assert.deepEqual(inputTimeoutArgs({ isRtsp: true, timeoutUs: 11_000_000, majorVersion: 4 }), [
    '-stimeout',
    '11000000',
  ]);
  assert.deepEqual(inputTimeoutArgs({ isRtsp: true, timeoutUs: 11_000_000, majorVersion: 6 }), [
    '-timeout',
    '11000000',
  ]);
});

test('版本解析兼容发行版后缀与 n 前缀', () => {
  assert.equal(parseFfmpegMajorVersion('ffmpeg version 4.4.2-0ubuntu0.22.04.1'), 4);
  assert.equal(parseFfmpegMajorVersion('ffmpeg version n4.4.2 Copyright (c)'), 4);
  assert.equal(parseFfmpegMajorVersion('ffmpeg version 6.1.1-full_build'), 6);
  assert.equal(parseFfmpegMajorVersion('ffmpeg version 9.0.2-full_build-www.gyan.dev'), 9);
  assert.equal(parseFfmpegMajorVersion('ffmpeg version N-109642-g1234567'), null);
  assert.equal(parseFfmpegMajorVersion(''), null);
});

test('版本分支边界：4 及以下 stimeout，5 及以上 timeout', () => {
  assert.equal(rtspTimeoutOptionForMajor(3), 'stimeout');
  assert.equal(rtspTimeoutOptionForMajor(4), 'stimeout');
  assert.equal(rtspTimeoutOptionForMajor(5), 'timeout');
  assert.equal(rtspTimeoutOptionForMajor(9), 'timeout');
  assert.equal(rtspTimeoutOptionForMajor(null), null);
  assert.equal(rtspTimeoutOptionForMajor(undefined), null);
});

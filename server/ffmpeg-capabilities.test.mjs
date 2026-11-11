import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEC_FALLBACK_CHAIN,
  chooseVideoCodec,
  detectFfmpegCapabilities,
  parseEncoderNames,
} from './ffmpeg-capabilities.mjs';

/**
 * FFmpeg 能力探测与编码器回退。
 *
 * 依据：现场 FFmpeg 可能是裁剪版（不含 libx264）。原实现硬编码 libx264，
 * 缺失时表现为「点位一直转圈」，日志里只有 ffmpeg stderr。这里锁定探测与
 * 回退逻辑，确保至少能选到可用的替代编码器并把降级原因暴露出来。
 */

const SAMPLE = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
 V....D mpeg4                MPEG-4 part 2
 A....D aac                  AAC (Advanced Audio Coding)
`;

test('parseEncoderNames：只取名字，跳过表头与分隔线', () => {
  const names = parseEncoderNames(SAMPLE);
  assert.ok(names.has('libx264'));
  assert.ok(names.has('mpeg4'));
  assert.ok(names.has('aac'));
  assert.equal(names.has('Encoders:'), false);
  assert.equal(names.has('------'), false);
  assert.equal(names.size, 3);
});

test('parseEncoderNames：兼容 5 位 flags 与 CRLF', () => {
  const names = parseEncoderNames(' V.... libx264 x\r\n V.... mpeg4 y\r\n');
  assert.ok(names.has('libx264'));
  assert.ok(names.has('mpeg4'));
});

test('parseEncoderNames：空输入安全返回空集合', () => {
  assert.equal(parseEncoderNames('').size, 0);
  assert.equal(parseEncoderNames(null).size, 0);
});

test('chooseVideoCodec：首选可用时不降级', () => {
  const result = chooseVideoCodec({ encoders: new Set(['libx264', 'mpeg4']), preferred: '' });
  assert.equal(result.codec, 'libx264');
  assert.equal(result.degraded, false);
});

test('chooseVideoCodec：首选缺失时沿回退链选择并标记降级', () => {
  const result = chooseVideoCodec({ encoders: new Set(['mpeg4']), preferred: '' });
  assert.equal(result.codec, 'mpeg4');
  assert.equal(result.degraded, true);
  assert.match(result.reason, /回退/);
});

test('chooseVideoCodec：环境变量指定的编码器不可用时回退并说明', () => {
  const result = chooseVideoCodec({
    encoders: new Set(['libx264']),
    preferred: 'h264_nvenc',
  });
  assert.equal(result.codec, 'libx264');
  assert.equal(result.degraded, true);
  assert.match(result.reason, /h264_nvenc/);
});

test('chooseVideoCodec：环境变量指定的编码器可用时优先使用', () => {
  const result = chooseVideoCodec({ encoders: new Set(['libx264', 'mpeg4']), preferred: 'mpeg4' });
  assert.equal(result.codec, 'mpeg4');
  assert.equal(result.degraded, false);
});

test('chooseVideoCodec：完全没有已知编码器时用兜底并明确提示', () => {
  const result = chooseVideoCodec({ encoders: new Set(['weird_codec']), preferred: '' });
  assert.equal(result.codec, CODEC_FALLBACK_CHAIN[CODEC_FALLBACK_CHAIN.length - 1]);
  assert.equal(result.degraded, true);
  assert.match(result.reason, /兜底/);
});

test('detectFfmpegCapabilities：正常探测返回编码器与选择结果', async () => {
  const caps = await detectFfmpegCapabilities({
    execImpl: async () => SAMPLE,
  });
  assert.equal(caps.ok, true);
  assert.equal(caps.codec, 'libx264');
  assert.equal(caps.degraded, false);
  assert.ok(caps.encoders.has('libx264'));
});

test('detectFfmpegCapabilities：裁剪版 ffmpeg 触发降级而非抛错', async () => {
  const caps = await detectFfmpegCapabilities({
    execImpl: async () => ' V....D mpeg4  MPEG-4\n',
  });
  assert.equal(caps.ok, true);
  assert.equal(caps.codec, 'mpeg4');
  assert.equal(caps.degraded, true);
});

test('detectFfmpegCapabilities：探测失败不阻断启动，返回失败标记', async () => {
  const caps = await detectFfmpegCapabilities({
    execImpl: async () => {
      throw new Error('spawn ffmpeg ENOENT');
    },
  });
  assert.equal(caps.ok, false);
  assert.equal(caps.degraded, true);
  assert.match(caps.error, /ENOENT/);
  // 仍应给出一个可用的默认编码器名，避免上层拿到 undefined
  assert.equal(typeof caps.codec, 'string');
  assert.ok(caps.codec.length > 0);
});

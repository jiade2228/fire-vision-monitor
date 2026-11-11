import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeErrorText, stripUserinfo } from './sanitize.mjs';

test('FFmpeg stderr 中的 RTSP 凭据被抹除', () => {
  const raw =
    "[rtsp @ 0x55f1] Opening 'rtsp://admin:Sup3rSecret@192.168.1.64:554/stream1' failed";
  const out = sanitizeErrorText(raw, 400);
  assert.doesNotMatch(out, /Sup3rSecret/);
  assert.doesNotMatch(out, /admin:/);
  assert.match(out, /rtsp:\/\/\*\*\*@192\.168\.1\.64:554/);
});

test('密码本身含 @ 时整体抹除（按 @ 匹配的写法会漏残余密码）', () => {
  const raw = "Opening 'rtsp://us@er:pa@ss@10.0.0.9:554/s1' failed";
  const out = sanitizeErrorText(raw, 400);
  assert.doesNotMatch(out, /pa@ss/);
  assert.doesNotMatch(out, /us@er/);
  assert.match(out, /rtsp:\/\/\*\*\*@10\.0\.0\.9:554/);
});

test('http/https 的 userinfo 同样被抹除', () => {
  const out = sanitizeErrorText('GET https://user:token@example.com/api failed');
  assert.doesNotMatch(out, /token/);
  assert.match(out, /https:\/\/\*\*\*@example\.com/);
});

test('无凭据的普通文本原样保留（不误伤）', () => {
  const out = sanitizeErrorText('Connection timed out after 5000ms');
  assert.equal(out, 'Connection timed out after 5000ms');
});

test('文本中的多个 URL 都会被处理', () => {
  const out = stripUserinfo('a=rtsp://u1:p1@h1/x b=http://u2:p2@h2/y');
  assert.doesNotMatch(out, /p1|p2/);
  assert.match(out, /rtsp:\/\/\*\*\*@h1/);
  assert.match(out, /http:\/\/\*\*\*@h2/);
});

test('超长文本按 limit 截断', () => {
  const out = sanitizeErrorText('x'.repeat(1000), 400);
  assert.equal(out.length, 400);
});

test('非字符串输入不抛异常', () => {
  assert.equal(sanitizeErrorText(null), '');
  assert.equal(sanitizeErrorText(undefined), '');
  assert.equal(sanitizeErrorText(123), '123');
});

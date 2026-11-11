import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getFreePort } from './test-port.mjs';

import { Notifier } from './notify.mjs';

/**
 * 构造一个仅用于测试推送路径的 Notifier：
 * store 传空对象即可（post 不触碰存储），fetchImpl 返回预置响应。
 */
function makeNotifier(fetchImpl, logger = { warn() {} }) {
  return new Notifier({ store: {}, logger, fetchImpl });
}

test('推送失败不回显上游响应体：错误只带状态码，响应体仅写日志', async () => {
  const warnings = [];
  const notifier = makeNotifier(
    async () => ({
      ok: false,
      status: 502,
      text: async () => '{"upstream":"http://10.0.0.5/hook?token=secret-value"}',
    }),
    { warn: (line) => warnings.push(String(line)) },
  );

  await assert.rejects(
    () => notifier.post('https://example.com/hook', '{}'),
    (error) => {
      assert.equal(error.message, 'HTTP 502');
      assert.doesNotMatch(error.message, /secret-value/);
      assert.doesNotMatch(error.message, /10\.0\.0\.5/);
      return true;
    },
  );

  assert.ok(
    warnings.some((line) => line.includes('HTTP 502')),
    '状态码应写入服务端日志',
  );
  assert.ok(
    warnings.some((line) => line.includes('secret-value')),
    '上游响应体只写日志，不外泄到错误消息',
  );
});

test('业务错误码保留，errmsg 压平空白并截断', async () => {
  const notifier = makeNotifier(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ errcode: 40001, errmsg: 'x'.repeat(500) }),
  }));

  await assert.rejects(
    () => notifier.post('https://example.com/hook', '{}'),
    (error) => {
      assert.match(error.message, /^errcode 40001：/);
      assert.ok(error.message.length <= 140, `错误消息过长：${error.message.length}`);
      return true;
    },
  );
});

test('推送成功时返回上游响应文本', async () => {
  const notifier = makeNotifier(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"errcode":0,"ok":true}',
  }));
  const text = await notifier.post('https://example.com/hook', '{}');
  assert.equal(text, '{"errcode":0,"ok":true}');
});


test('默认 fetch 实现逐跳校验重定向：302 跳向云元数据被拦截', async (t) => {
  // 生产装配不传 fetchImpl，必须使用 guardedFetch。
  // 这里用本地上游返回 302 → 169.254.169.254，验证二跳被拦而不是被 fetch 跟随。
  const port = await getFreePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const notifier = new Notifier({ store: {}, logger: { warn() {} } });
  await assert.rejects(
    () => notifier.post(`http://127.0.0.1:${port}/hook`, '{}'),
    (error) => {
      assert.equal(error.name, 'OutboundBlockedError');
      assert.match(error.message, /元数据/);
      return true;
    },
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOutboundUrl,
  blockedOutboundHost,
  guardedFetch,
  OutboundBlockedError,
  parseIpv4,
} from './net-guard.mjs';

test('出网校验：云元数据与未指定地址恒定拦截', () => {
  assert.match(
    blockedOutboundHost('169.254.169.254'),
    /元数据/,
    'AWS/阿里云元数据地址必须恒定拦截',
  );
  assert.match(blockedOutboundHost('169.254.170.2'), /元数据/);
  assert.match(blockedOutboundHost('fd00:ec2::254'), /元数据/);
  assert.match(blockedOutboundHost('0.0.0.0'), /未指定/);
  assert.match(blockedOutboundHost('::'), /未指定/);
  assert.match(blockedOutboundHost('0.1.2.3'), /未指定/);
});

test('出网校验：IPv4-mapped IPv6 不能绕过元数据拦截', () => {
  assert.match(
    blockedOutboundHost('::ffff:169.254.169.254'),
    /元数据/,
    'IPv4-mapped IPv6 形式必须同样被拦截',
  );
  // 相机源策略允许链路本地（自组网摄像头），但绝不能因此放过元数据地址。
  assert.match(
    blockedOutboundHost('::ffff:169.254.169.254', { allowLinkLocal: true }),
    /元数据/,
    'allowLinkLocal=true 也不能放行元数据地址',
  );
});

test('出网校验：WHATWG URL 规范化后的十六进制 mapped 形式仍须拦截（SSRF 回归）', () => {
  // 关键：new URL('http://[::ffff:169.254.169.254]/') 的 hostname 会被规范化成
  // '[::ffff:a9fe:a9fe]'（十六进制），而不是点分十进制。此前 mappedIpv4 只认
  // 点分形式，导致真实请求链路（assertOutboundUrl / blockedOutboundHost）直接
  // 放行云元数据地址 —— 上一轮修复的残留变体。
  const forms = [
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::ffff:169.254.170.2]/latest/meta-data/',
    'http://[::ffff:a9fe:aa02]/latest/meta-data/',
  ];
  for (const url of forms) {
    const hostname = new URL(url).hostname;
    assert.match(
      blockedOutboundHost(hostname) ?? '',
      /元数据/,
      `规范化主机名 ${hostname} 必须被拦截`,
    );
    assert.match(
      assertOutboundUrl(url).error ?? '',
      /元数据/,
      `完整 URL ${url} 必须被拦截`,
    );
  }
  // 相机源策略（允许链路本地）同样不得放行。
  assert.match(
    blockedOutboundHost('::ffff:a9fe:a9fe', { allowLinkLocal: true }) ?? '',
    /元数据/,
  );
});

test('出网校验：十六进制 mapped 形式同时继承环回/私网/链路本地判定', () => {
  // 解析出的 IPv4 应参与完整判定，而不只是元数据黑名单。
  assert.match(
    blockedOutboundHost('::ffff:7f00:1', { allowLoopback: false }) ?? '',
    /环回/,
    '::ffff:127.0.0.1 的十六进制形式应按环回处理',
  );
  assert.match(
    blockedOutboundHost('::ffff:c0a8:101', { allowPrivate: false }) ?? '',
    /私网/,
    '::ffff:192.168.1.1 的十六进制形式应按私网处理',
  );
  assert.match(
    blockedOutboundHost('::ffff:0a00:1', { allowPrivate: false }) ?? '',
    /私网/,
    '::ffff:10.0.0.1 的十六进制形式应按私网处理',
  );
  // 允许私网/环回时，非元数据的 mapped 地址仍应正常放行。
  assert.equal(blockedOutboundHost('::ffff:c0a8:101'), null);
});

test('出网校验：整数/十六进制/八进制编码的元数据地址同样拦截', () => {
  // WHATWG URL 会把这些编码规范化为真实 IPv4；若只对原始字符串做黑名单比较，
  // 就能绕过「云元数据恒定拦截」。这是与 IPv4-mapped IPv6 同族的 check-use 分离。
  const encoded = [
    '2852039166',      // 169.254.169.254
    '0xa9fea9fe',      // 169.254.169.254
    '0xa9feaa02',      // 169.254.170.2
    '2852039170',      // 169.254.170.2
    '0251.0376.0251.0376', // 169.254.169.254 八进制点分（169 = 0251, 254 = 0376）
  ];
  for (const host of encoded) {
    assert.match(
      blockedOutboundHost(host, { allowLinkLocal: true }) ?? '',
      /元数据/,
      `${host} 必须被识别为云元数据地址`,
    );
    const url = new URL('http://placeholder.invalid/');
    url.hostname = host;
    assert.match(
      assertOutboundUrl(url, { allowLinkLocal: true }).error ?? '',
      /元数据/,
      `规范化后 ${url.hostname} 必须被拦截`,
    );
  }
  // 非元数据编码仍按原有策略判定（允许私网/环回时不拦截）。
  assert.equal(parseIpv4('2130706433').join('.'), '127.0.0.1');
  assert.equal(parseIpv4('0177.0.0.1').join('.'), '127.0.0.1');
  assert.equal(parseIpv4('127.1').join('.'), '127.0.0.1');
});

test('出网校验：环回与私网按 allowPrivate/allowLoopback 开关', () => {
  // 默认（摄像头/内网 Webhook 的常态）：放行。
  assert.equal(blockedOutboundHost('127.0.0.1'), null);
  assert.equal(blockedOutboundHost('10.1.2.3'), null);
  assert.equal(blockedOutboundHost('192.168.1.10'), null);
  assert.equal(blockedOutboundHost('172.16.5.5'), null);
  assert.equal(blockedOutboundHost('100.64.0.1'), null);
  assert.equal(blockedOutboundHost('localhost'), null);

  // 收紧模式：环回与私网一律拦截。
  const strict = { allowPrivate: false, allowLoopback: false };
  assert.match(blockedOutboundHost('127.0.0.1', strict), /环回/);
  assert.match(blockedOutboundHost('::1', strict), /环回/);
  assert.match(blockedOutboundHost('10.1.2.3', strict), /私网/);
  assert.match(blockedOutboundHost('192.168.1.10', strict), /私网/);
  assert.match(blockedOutboundHost('localhost', strict), /本机/);
  assert.match(blockedOutboundHost('box.local', strict), /\.local/);
});

test('出网校验：链路本地按 allowLinkLocal 开关（摄像头自组网需要）', () => {
  assert.match(blockedOutboundHost('169.254.10.20'), /链路本地/);
  assert.equal(
    blockedOutboundHost('169.254.10.20', { allowLinkLocal: true }),
    null,
    '自组网摄像头使用 169.254.x.x 自分配地址，应允许',
  );
});

test('出网校验：普通公网地址一律放行', () => {
  assert.equal(blockedOutboundHost('camera.example.com'), null);
  assert.equal(blockedOutboundHost('203.0.113.7'), null);
});

test('出网 URL 校验：协议白名单与地址校验同时生效', () => {
  assert.match(assertOutboundUrl('ftp://example.com').error, /协议/);
  assert.match(
    assertOutboundUrl('http://169.254.169.254/latest/meta-data/').error,
    /元数据/,
  );
  assert.match(assertOutboundUrl('not a url').error, /格式/);
  const ok = assertOutboundUrl('https://example.com/a.m3u8');
  assert.equal(ok.error, undefined);
  assert.equal(ok.url.hostname, 'example.com');
});

test('出网 URL 校验：允许 rtsp/rtsps（相机源协议）', () => {
  const ok = assertOutboundUrl('rtsp://10.0.0.9:554/stream', {
    protocols: ['rtsp:', 'rtsps:'],
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.url.hostname, '10.0.0.9');
});

test('guardedFetch：逐跳校验重定向目标，302 跳向内网被拒绝', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://ok.example')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }
    throw new Error(`不应该请求 ${url}`);
  };
  try {
    await assert.rejects(
      () => guardedFetch('https://ok.example/a.m3u8'),
      (error) => error instanceof OutboundBlockedError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('guardedFetch：同源正常响应原样返回', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
  try {
    const response = await guardedFetch('https://ok.example/a.txt');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('guardedFetch：重定向链超过上限时报错而不是无限跟随', async () => {
  const originalFetch = globalThis.fetch;
  let hops = 0;
  globalThis.fetch = async () => {
    hops += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://ok.example/${hops}` },
    });
  };
  try {
    await assert.rejects(
      () => guardedFetch('https://ok.example/0', {}, { maxRedirects: 2 }),
      (error) => error instanceof OutboundBlockedError,
    );
    assert.ok(hops <= 4, `重定向次数应受限，实际 ${hops} 次`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

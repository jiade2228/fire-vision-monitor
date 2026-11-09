import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { EdgeHub, parseEdgeSource } from './edge-hub.mjs';

test('edge source parsing', () => {
  assert.deepEqual(parseEdgeSource('edge://site-a/ch01'), {
    gatewayId: 'site-a',
    key: 'ch01',
  });
  assert.equal(parseEdgeSource('rtsp://example/a'), null);
});

test('gateway reconnect clears pending requests of the replaced connection', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hubPort = server.address().port;
  const token = '0123456789abcdef0123456789abcdef';
  const hub = new EdgeHub({
    token,
    logger: { info: () => undefined, warn: () => undefined },
    requestTimeoutMs: 10_000,
  });
  hub.attach(server);
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `ws://127.0.0.1:${hubPort}/gateway?gatewayId=site-b&token=${token}`;
  const hello = JSON.stringify({
    type: 'hello',
    name: '一号网关',
    cameras: [{ key: 'ch01', label: '一号仓库' }],
  });

  const first = new WebSocket(url);
  await new Promise((resolve, reject) => {
    first.once('open', resolve);
    first.once('error', reject);
  });
  first.send(hello);
  await new Promise((resolve) => first.once('message', resolve));

  // 故意不响应，让请求停留在 pending。
  const pending = hub.request('edge://site-b/ch01', 'index.m3u8');
  const rejection = assert.rejects(() => pending, /连接已替换|连接已断开/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.pending.size, 1);

  const second = new WebSocket(url);
  await new Promise((resolve, reject) => {
    second.once('open', resolve);
    second.once('error', reject);
  });
  second.send(hello);
  await new Promise((resolve) => second.once('message', resolve));

  await rejection;
  assert.equal(hub.pending.size, 0);
  first.close();
  second.close();
});

test('gateway connects, registers and relays HLS requests', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hubPort = server.address().port;
  const hub = new EdgeHub({
    token: '0123456789abcdef0123456789abcdef',
    logger: { info: () => undefined, warn: () => undefined },
    requestTimeoutMs: 3000,
  });
  hub.attach(server);
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const socket = new WebSocket(
    `ws://127.0.0.1:${hubPort}/gateway?gatewayId=site-a&token=0123456789abcdef0123456789abcdef`,
  );
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  t.after(() => socket.close());
  socket.send(
    JSON.stringify({
      type: 'hello',
      name: '测试网关',
      cameras: [{ key: 'ch01', label: '一号仓库' }],
    }),
  );
  await new Promise((resolve) => socket.once('message', resolve));

  assert.deepEqual(hub.status(), [
    {
      gatewayId: 'site-a',
      name: '测试网关',
      connectedAt: hub.status()[0].connectedAt,
      cameras: [{ key: 'ch01', label: '一号仓库' }],
    },
  ]);

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'hls') return;
    socket.send(
      JSON.stringify({
        type: 'response',
        id: message.id,
        ok: true,
        body: Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment-00001.ts\n').toString('base64'),
      }),
    );
  });
  const body = await hub.request('edge://site-a/ch01', 'index.m3u8');
  assert.match(body.toString('utf8'), /#EXTM3U/);

  await assert.rejects(
    () => hub.request('edge://site-a/missing', 'index.m3u8'),
    /未声明/,
  );
});

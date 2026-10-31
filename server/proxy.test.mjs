import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort } from './test-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const mockPort = 4599;
const mockBase = `http://127.0.0.1:${mockPort}`;
const csrf = { 'X-Requested-With': 'flame-vision', Origin: base };

function startMockHls() {
  const segment = Buffer.from('MOCKSEGMENTBINARYDATA');
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/master.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nvariant.m3u8\n');
    } else if (url.startsWith('/variant.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
    } else if (url.startsWith('/seg0.ts') || url.startsWith('/seg1.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Accept-Ranges', 'bytes');
      let body = segment;
      if (req.headers.range) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : segment.length - 1;
          body = segment.slice(start, end + 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${segment.length}`);
        }
      }
      res.end(body);
    } else if (url.startsWith('/clip.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      let body = segment;
      if (req.headers.range) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : segment.length - 1;
          body = segment.slice(start, end + 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${segment.length}`);
        }
      }
      res.end(body);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(mockPort, '127.0.0.1', () => resolve(server)));
}

function tokenOf(text, cameraId) {
  const match = text.match(new RegExp(`/proxy/${cameraId}/([A-Za-z0-9_-]+)`));
  return match ? match[1] : null;
}

test('HLS/HTTP 跨域代理重写、转发与同源防护', async (t) => {
  const mock = await startMockHls();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-proxy-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, MAX_CONCURRENT_STREAMS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c.toString()));
  child.stderr.on('data', (c) => (output += c.toString()));
  t.after(async () => {
    mock.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const timer = setTimeout(r, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          r();
        });
      });
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // 等待启动
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`);
    try {
      const r = await fetch(`${base}/api/auth/status`);
      if (r.ok) break;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const cookieFrom = (r) =>
    (r.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ');
  const call = async (method, pathName, body, cookie = '', headers = {}) => {
    const r = await fetch(`${base}${pathName}`, {
      method,
      headers: { ...csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* no json */
    }
    return { status: r.status, data, cookie: cookieFrom(r), text };
  };

  // 初始化管理员
  const setup = await call('POST', '/api/setup', {
    username: 'admin',
    displayName: '管理员',
    password: 'Admin123!',
  });
  const cookie = setup.cookie;
  assert.equal(setup.status, 201, 'setup');

  // 创建 hls 点位
  const cam = await call('POST', '/api/cameras', {
    code: 'HLS1',
    name: '代理测试HLS',
    zone: '测试',
    protocol: 'hls',
    sourceUrl: `${mockBase}/master.m3u8`,
    enabled: true,
  }, cookie);
  assert.equal(cam.status, 201, `create hls camera: ${JSON.stringify(cam.data)}`);
  const cameraId = cam.data.camera.id;

  // 1) 拉 master playlist，应被重写
  // 1) 拉 master playlist，应被重写
  const master = await call('GET', `/proxy/${cameraId}`, undefined, cookie);
  assert.equal(master.status, 200, 'proxy master');
  assert.ok(master.text.includes('#EXTM3U'), 'master has EXT');
  const variantToken = tokenOf(master.text, cameraId);
  assert.ok(variantToken, 'variant url rewritten to proxy token');
  assert.ok(!master.text.includes('variant.m3u8') || master.text.includes(`/proxy/${cameraId}/`), 'variant rewritten');

  // 2) 拉 variant playlist，应被重写且含 segment token
  const variantUrl = `/proxy/${cameraId}/${variantToken}`;
  const variant = await call('GET', variantUrl, undefined, cookie);
  assert.equal(variant.status, 200, 'proxy variant');
  const segToken = tokenOf(variant.text, cameraId);
  assert.ok(segToken, 'segment url rewritten to proxy token');

  // 3) 拉 segment 二进制，应原样转发
  const seg = await call('GET', `/proxy/${cameraId}/${segToken}`, undefined, cookie);
  assert.equal(seg.status, 200, 'proxy segment');
  assert.equal(seg.text, 'MOCKSEGMENTBINARYDATA', 'segment forwarded verbatim');

  // 4) Range 请求（视频 seek）应被转发
  const segRange = await call('GET', `/proxy/${cameraId}/${segToken}`, undefined, cookie, { Range: 'bytes=0-3' });
  assert.ok(segRange.status === 200 || segRange.status === 206, 'range supported');

  // 5) 跨域同源防护：手搓指向其他 origin 的 token 应 403
  const evilToken = Buffer.from('http://127.0.0.1:1/evil.m3u8').toString('base64url');
  const evil = await call('GET', `/proxy/${cameraId}/${evilToken}`, undefined, cookie);
  assert.equal(evil.status, 403, 'non-same-origin blocked');

  // 6) 非 http/hls 协议点位不应走代理
  const rtspCam = await call('POST', '/api/cameras', {
    code: 'RTSP1',
    name: '代理测试RTSP',
    zone: '测试',
    protocol: 'rtsp',
    sourceUrl: 'rtsp://user:pass@127.0.0.1:554/stream',
    enabled: true,
  }, cookie);
  const rtspId = rtspCam.data.camera.id;
  const rtspProxy = await call('GET', `/proxy/${rtspId}`, undefined, cookie);
  assert.equal(rtspProxy.status, 404, 'rtsp not proxied');

  // 7) 未认证访问代理应 401
  const noAuth = await call('GET', `/proxy/${cameraId}`, undefined, '');
  assert.equal(noAuth.status, 401, 'proxy requires auth');

  // 8) http 单文件视频代理（mp4）
  const httpCam = await call('POST', '/api/cameras', {
    code: 'HTTP1',
    name: '代理测试HTTP',
    zone: '测试',
    protocol: 'http',
    sourceUrl: `${mockBase}/clip.mp4`,
    enabled: true,
  }, cookie);
  const httpId = httpCam.data.camera.id;
  const clip = await call('GET', `/proxy/${httpId}`, undefined, cookie, { Range: 'bytes=0-3' });
  assert.ok(clip.status === 200 || clip.status === 206, 'http mp4 proxied with range');
  assert.equal(clip.text, 'MOCK', 'http mp4 body forwarded');
});

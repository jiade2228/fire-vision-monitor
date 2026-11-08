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

function startMockOnvif(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/soap+xml');
      if (body.includes('GetDeviceInformation')) {
        res.end(
          '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
            '<tds:GetDeviceInformationResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
            '<tds:Manufacturer>Hikvision</tds:Manufacturer>' +
            '<tds:Model>DS-2CD2T47G2-L</tds:Model>' +
            '<tds:FirmwareVersion>4.0.0</tds:FirmwareVersion>' +
            '</tds:GetDeviceInformationResponse></soap:Body></soap:Envelope>',
        );
      } else if (body.includes('GetProfiles')) {
        res.end(
          '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
            '<tds:GetProfilesResponse xmlns:tds="http://www.onvif.org/ver10/media/wsdl">' +
            '<tds:Profiles token="Profile_1"><tt:Name xmlns:tt="http://www.onvif.org/ver10/schema">Channel1</tt:Name></tds:Profiles>' +
            '<tds:Profiles token="Profile_2"><tt:Name xmlns:tt="http://www.onvif.org/ver10/schema">Channel2</tt:Name></tds:Profiles>' +
            '</tds:GetProfilesResponse></soap:Body></soap:Envelope>',
        );
      } else if (body.includes('GetStreamUri')) {
        const uri =
          body.includes('Profile_2')
            ? 'rtsp://admin:pass@127.0.0.1:554/stream2'
            : 'rtsp://admin:pass@127.0.0.1:554/stream1';
        res.end(
          '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
            '<tds:GetStreamUriResponse xmlns:tds="http://www.onvif.org/ver10/media/wsdl">' +
            `<tds:MediaUri><tt:Uri xmlns:tt="http://www.onvif.org/ver10/schema">${uri}</tt:Uri></tds:MediaUri>` +
            '</tds:GetStreamUriResponse></soap:Body></soap:Envelope>',
        );
      } else if (body.includes('GetSnapshotUri')) {
        res.end(
          '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>' +
            '<tds:GetSnapshotUriResponse xmlns:tds="http://www.onvif.org/ver10/media/wsdl">' +
            '<tds:MediaUri><tt:Uri xmlns:tt="http://www.onvif.org/ver10/schema">' +
            `http://127.0.0.1:${port}/snapshot</tt:Uri></tds:MediaUri>` +
            '</tds:GetSnapshotUriResponse></soap:Body></soap:Envelope>',
        );
      } else {
        res.statusCode = 500;
        res.end('unknown action');
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

test('ONVIF 设备信息/通道/取流解析', async (t) => {
  const mockPort = await getFreePort();
  const mock = await startMockOnvif(mockPort);
  t.after(() => mock.close());
  const { discoverDevice } = await import('./onvif.mjs');
  const device = await discoverDevice({
    host: '127.0.0.1',
    port: mockPort,
    username: 'admin',
    password: 'pass',
  });
  assert.equal(device.manufacturer, 'Hikvision');
  assert.equal(device.model, 'DS-2CD2T47G2-L');
  assert.equal(device.firmware, '4.0.0');
  assert.equal(device.profiles.length, 2, '应解析出 2 个通道');
  assert.equal(device.profiles[0].token, 'Profile_1');
  assert.equal(device.profiles[1].name, 'Channel2');
  assert.ok(device.profiles[0].rtspUri.startsWith('rtsp://'), '应取到 RTSP 流地址');
  assert.ok(device.profiles[0].snapshotUri.startsWith('http://'), '应取到快照地址');
});

test('ONVIF discover + import API 端到端', async (t) => {
  const mockPort = await getFreePort();
  const mock = await startMockOnvif(mockPort);
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-onvif-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, MAX_CONCURRENT_STREAMS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited');
    try {
      const r = await fetch(`${base}/api/auth/status`);
      if (r.ok) break;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const csrf = { 'X-Requested-With': 'flame-vision', Origin: base };
  const cookieFrom = (r) =>
    (r.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ');
  const call = async (method, pathName, body, cookie = '') => {
    const r = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        ...csrf,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null, cookie: cookieFrom(r) };
  };

  const setup = await call('POST', '/api/setup', {
    username: 'admin',
    displayName: '管理员',
    password: 'Admin123!',
  });
  const cookie = setup.cookie;
  assert.equal(setup.status, 201);

  const discover = await call(
    'POST',
    '/api/onvif/discover',
    { hosts: ['127.0.0.1'], port: mockPort, username: 'admin', password: 'pass' },
    cookie,
  );
  assert.equal(discover.status, 200, 'discover');
  const first = discover.data.results[0];
  assert.ok(first.ok, 'device discovered');
  assert.equal(first.device.profiles.length, 2, '2 profiles via API');

  const profiles = first.device.profiles.map((p) => ({
    name: p.name,
    token: p.token,
    rtspUri: p.rtspUri,
    snapshotUri: p.snapshotUri,
  }));
  const importRes = await call(
    'POST',
    '/api/onvif/import',
    { devices: [{ label: '测试设备', host: '127.0.0.1', zone: '测试区', profiles }] },
    cookie,
  );
  assert.equal(importRes.status, 201, 'import');
  assert.equal(importRes.data.created.length, 2, '导入 2 个通道');
  assert.equal(importRes.data.skipped, 0);
  const firstCreated = importRes.data.created[0];
  assert.equal(firstCreated.protocol, 'rtsp');
  assert.ok(
    firstCreated.sourceUrl.startsWith('rtsp://'),
    '管理员可见完整 RTSP 地址',
  );
});

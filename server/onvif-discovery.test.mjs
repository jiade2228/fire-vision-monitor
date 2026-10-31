import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOnvifDevices, parseProbeMatches } from './onvif-discovery.mjs';
import { getFreePort } from './test-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function responseXml(host = '192.168.1.64', name = '库房枪机') {
  return `<?xml version="1.0"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wsdp="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">
  <SOAP-ENV:Body><wsdp:ProbeMatches><wsdp:ProbeMatch>
    <wsa:EndpointReference><wsa:Address>urn:uuid:device-${host}</wsa:Address></wsa:EndpointReference>
    <wsdp:Types>dn:NetworkVideoTransmitter</wsdp:Types>
    <wsdp:Scopes Item="onvif://www.onvif.org/name/${name} onvif://www.onvif.org/manufacturer/Hikvision onvif://www.onvif.org/Profile/Streaming" />
    <wsdp:XAddrs>http://${host}:8899/onvif/device_service</wsdp:XAddrs>
  </wsdp:ProbeMatch></wsdp:ProbeMatches></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function startUdpResponder(port, xml) {
  const socket = dgram.createSocket('udp4');
  const probes = [];
  socket.on('message', (message, remote) => {
    probes.push(message.toString());
    const response = Buffer.from(xml);
    socket.send(response, 0, response.length, remote.port, remote.address);
  });
  return new Promise((resolve) => {
    socket.bind(port, '127.0.0.1', () => resolve({ socket, probes }));
  });
}

test('WS-Discovery 响应可解析设备地址、名称与厂商', () => {
  const devices = parseProbeMatches(responseXml());
  assert.equal(devices.length, 1);
  assert.equal(devices[0].host, '192.168.1.64');
  assert.equal(devices[0].port, 8899);
  assert.equal(devices[0].name, '库房枪机');
  assert.equal(devices[0].manufacturer, 'Hikvision');
  assert.equal(devices[0].xaddrs.length, 1);
  assert.ok(devices[0].endpoint.includes('device-192.168.1.64'));
  assert.deepEqual(parseProbeMatches('<not-xml'), []);
});

test('UDP 扫描收到响应并按主机去重', async (t) => {
  const responder = await startUdpResponder(4411, responseXml());
  t.after(() => responder.socket.close());
  const devices = await discoverOnvifDevices({
    address: '127.0.0.1',
    port: 4411,
    listenAddress: '127.0.0.1',
    timeoutMs: 900,
    repeat: 2,
  });
  assert.equal(devices.length, 1, '重复响应应合并为一台设备');
  assert.equal(devices[0].host, '192.168.1.64');
  assert.equal(devices[0].name, '库房枪机');
  assert.ok(responder.probes.length >= 1);
  assert.ok(responder.probes[0].includes('NetworkVideoTransmitter'));
});

test('ONVIF 全网段扫描 API 鉴权并返回设备列表', async (t) => {
  const port = await getFreePort();
  const responder = await startUdpResponder(port, responseXml('192.168.1.88', '周界云台'));
  const base = `http://127.0.0.1:${port}`;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-wsdiscovery-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      ONVIF_DISCOVERY_ADDRESS: '127.0.0.1',
      ONVIF_DISCOVERY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    responder.socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/auth/status`);
      ready = response.ok;
    } catch {
      // waiting
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'server ready');

  const call = async (pathName, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        'X-Requested-With': 'flame-vision',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookie: (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };

  const setup = await call('/api/setup', {
    method: 'POST',
    body: { username: 'admin', displayName: '扫描管理员', password: 'Admin12345!' },
  });
  assert.equal(setup.status, 201);

  const unauthenticated = await call('/api/onvif/scan', {
    method: 'POST',
    body: { timeoutMs: 1000 },
  });
  assert.equal(unauthenticated.status, 401);

  const scanned = await call('/api/onvif/scan', {
    method: 'POST',
    body: { timeoutMs: 1000 },
    cookie: setup.cookie,
  });
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.devices.length, 1);
  assert.equal(scanned.body.devices[0].host, '192.168.1.88');
  assert.equal(scanned.body.devices[0].port, 8899);
  assert.equal(scanned.body.devices[0].name, '周界云台');
  assert.ok(scanned.body.durationMs >= 0);
});

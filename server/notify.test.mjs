import { E2E_ADMIN_PASSWORD } from './test-password.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort } from './test-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await getFreePort();
const receiverPort = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const csrf = { 'X-Requested-With': 'flame-vision' };

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/auth/status`);
      if (response.ok) return;
    } catch {
      // waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server startup timeout');
}

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('alarm notifications reach webhook and wecom channels with signature', async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(receiverPort, '127.0.0.1', resolve));

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-notify-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();

  t.after(async () => {
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
    await new Promise((resolve) => receiver.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitForServer(child);

  const request = async (pathName, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        ...csrf,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    return { status: response.status, body: payload, cookie: cookieFrom(response) };
  };

  const setup = await request('/api/setup', {
    method: 'POST',
    body: { username: 'admin', displayName: '通知管理员', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const secret = 'sign-me';
  const webhookChannel = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '自建值班系统',
      url: `http://127.0.0.1:${receiverPort}/hook?key=secret-key`,
      secret,
    },
  });
  assert.equal(webhookChannel.status, 201);
  // 出参不能回传完整地址与密钥
  assert.equal(JSON.stringify(webhookChannel.body).includes('secret-key'), false);

  const wecomChannel = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'wecom',
      name: '企业微信值班群',
      url: `http://127.0.0.1:${receiverPort}/wecom?key=wecom-key`,
    },
  });
  assert.equal(wecomChannel.status, 201);

  const listed = await request('/api/notify/channels', { cookie: adminCookie });
  assert.equal(listed.body.channels.length, 2);
  assert.ok(listed.body.channels.every((channel) => channel.urlHint.startsWith('http')));

  const invalid = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: { kind: 'webhook', name: '错误地址', url: 'ftp://example.com/hook' },
  });
  assert.equal(invalid.status, 400);

  // SSRF 缓解：链路本地（云元数据）与未指定地址永久拦截
  const blockedHosts = [
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/hook',
  ];
  for (const url of blockedHosts) {
    const blocked = await request('/api/notify/channels', {
      method: 'POST',
      cookie: adminCookie,
      body: { kind: 'webhook', name: '被拦截地址', url },
    });
    assert.equal(blocked.status, 400, `${url} 应被拒绝`);
  }
  // 环回默认放行（本机往往就是 Webhook 接收端）——本次测试本身依赖 127.0.0.1 接收推送
  const loopbackAllowed = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '本机接收端',
      url: 'http://127.0.0.1:9/hook',
      enabled: false,
    },
  });
  assert.equal(loopbackAllowed.status, 201, '默认应放行环回地址');
  // 内网地址默认放行（内网部署的 Webhook 常在内网）；建为停用，避免后续推送真的去连它
  const privateAllowed = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '内网地址',
      url: 'http://192.168.1.10:9000/hook',
      enabled: false,
    },
  });
  assert.equal(privateAllowed.status, 201);

  const camera = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '通知测试点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
    },
  });
  assert.equal(camera.status, 201);

  const alarm = await request('/api/alarms', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      cameraId: camera.body.camera.id,
      level: 'fire',
      confidence: 91,
      hotspot: { x: 42, y: 58 },
    },
  });
  assert.equal(alarm.status, 201);

  const gotCreated = await waitFor(() =>
    received.some((item) => item.url.startsWith('/hook') && item.body.includes('alarm.created')),
  );
  assert.ok(gotCreated, 'Webhook 应收到 alarm.created');
  const gotWecom = await waitFor(() =>
    received.some((item) => item.url.startsWith('/wecom') && item.body.includes('msgtype')),
  );
  assert.ok(gotWecom, '企业微信渠道应收到 markdown 消息');

  const hook = received.find((item) => item.url.startsWith('/hook'));
  const payload = JSON.parse(hook.body);
  assert.equal(payload.event, 'alarm.created');
  assert.equal(payload.alarm.id, alarm.body.alarm.id);
  assert.ok(payload.message.includes('通知测试点位'));
  const expected = crypto.createHmac('sha256', secret).update(hook.body).digest('hex');
  assert.equal(hook.headers['x-fire-signature'], `sha256=${expected}`);

  const wecom = JSON.parse(received.find((item) => item.url.startsWith('/wecom')).body);
  assert.equal(wecom.msgtype, 'markdown');
  assert.ok(wecom.markdown.content.includes('火情告警'));

  const confirmed = await request(`/api/alarms/${alarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(confirmed.status, 200);
  const gotConfirmed = await waitFor(() =>
    received.some((item) => item.body.includes('alarm.confirmed')),
  );
  assert.ok(gotConfirmed, '确认处置后应推送 alarm.confirmed');

  const logs = await request('/api/notify/logs', { cookie: adminCookie });
  assert.equal(logs.status, 200);
  const sent = logs.body.logs.filter((log) => log.status === 'sent');
  assert.ok(sent.length >= 3, `推送日志应包含成功记录，实际 ${sent.length}`);

  // 只读 / 值班员无权管理通知渠道
  const operator = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'operator1',
      displayName: '值班员',
      password: E2E_ADMIN_PASSWORD,
      role: 'operator',
    },
  });
  assert.equal(operator.status, 201);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'operator1', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(login.status, 200);
  const forbidden = await request('/api/notify/channels', {
    method: 'POST',
    cookie: login.cookie,
    body: { kind: 'wecom', name: '越权', url: 'http://example.com/hook' },
  });
  assert.equal(forbidden.status, 403);
});

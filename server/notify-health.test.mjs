import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4413;
const receiverPort = 4414;
const base = `http://127.0.0.1:${port}`;
const csrf = { 'X-Requested-With': 'flame-vision' };

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('notification channel disables itself after consecutive failures', async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(receiverPort, '127.0.0.1', resolve));

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-health-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      NOTIFY_MAX_FAILURES: '2',
      ESCALATION_MINUTES: '0.01',
      ESCALATION_CHECK_INTERVAL_MS: '400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
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
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookie: (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };

  const setup = await request('/api/setup', {
    method: 'POST',
    body: { username: 'admin', displayName: '自愈管理员', password: 'Admin12345!' },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  // 指向未监听端口的坏渠道：快速连接失败，避免测试依赖超时。
  const badChannel = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '坏渠道',
      url: 'http://127.0.0.1:59994/unreachable',
    },
  });
  assert.equal(badChannel.status, 201);
  const badId = badChannel.body.channel.id;

  await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '好渠道',
      url: `http://127.0.0.1:${receiverPort}/hook`,
    },
  });

  const camera = (await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '自愈测试点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
    },
  })).body.camera;

  // 第一次失败：告警产生；第二次失败：约 0.6s 后的升级推送。阈值 2 次触发停用。
  const alarm = await request('/api/alarms', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      cameraId: camera.id,
      level: 'fire',
      confidence: 90,
      hotspot: { x: 40, y: 60 },
    },
  });
  assert.equal(alarm.status, 201);

  const gotDisabledNotice = await waitFor(() =>
    received.some(
      (body) => body.includes('channel.disabled') && body.includes('通知渠道已自动停用'),
    ),
  );
  assert.ok(gotDisabledNotice, '其余渠道应收到渠道停用提醒');

  const channels = await request('/api/notify/channels', { cookie: adminCookie });
  const bad = channels.body.channels.find((item) => item.id === badId);
  assert.equal(bad.enabled, false, '坏渠道应被自动停用');
  assert.ok(
    channels.body.channels.every((item) => item.id === badId || item.enabled),
    '其余渠道保持启用',
  );

  const logs = await request('/api/notify/logs', { cookie: adminCookie });
  const badFailed = logs.body.logs.filter(
    (log) => log.channelId === badId && log.status === 'failed',
  );
  assert.ok(badFailed.length >= 2, '坏渠道至少两次失败记录');
  assert.ok(
    logs.body.logs.some(
      (log) => log.event === 'channel.disabled' && log.status === 'sent',
    ),
  );
});

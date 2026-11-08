import { E2E_ADMIN_PASSWORD } from './test-password.mjs';
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

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('pending alarm escalates once and stops after confirmation', async (t) => {
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

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-escalate-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      ESCALATION_MINUTES: '0.01',
      ESCALATION_CHECK_INTERVAL_MS: '400',
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
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookie: cookieFrom(response),
    };
  };

  const setup = await request('/api/setup', {
    method: 'POST',
    body: { username: 'admin', displayName: '升级管理员', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const channel = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '值班群',
      url: `http://127.0.0.1:${receiverPort}/hook`,
    },
  });
  assert.equal(channel.status, 201);

  const camera = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '升级测试点位',
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
      confidence: 90,
      hotspot: { x: 30, y: 70 },
    },
  });
  assert.equal(alarm.status, 201);
  const alarmId = alarm.body.alarm.id;

  const gotEscalated = await waitFor(() =>
    received.some((body) => body.includes('alarm.escalated')),
  );
  assert.ok(gotEscalated, '超过阈值后应推送 alarm.escalated');
  const escalatedBody = received.find((body) => body.includes('alarm.escalated'));
  assert.ok(escalatedBody.includes('告警升级'));
  assert.ok(escalatedBody.includes('未确认处置'));

  // 再等两个巡检周期，同一条告警只升级一次。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const escalatedCount = received.filter((body) => body.includes('alarm.escalated')).length;
  assert.equal(escalatedCount, 1);

  const events = await request(`/api/alarms/${alarmId}/events`, { cookie: adminCookie });
  assert.equal(events.status, 200);
  assert.ok(events.body.events.some((event) => event.action === 'escalated'));

  // 确认后不再升级。
  const confirmed = await request(`/api/alarms/${alarmId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(confirmed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    received.filter((body) => body.includes('alarm.escalated')).length,
    1,
  );
});

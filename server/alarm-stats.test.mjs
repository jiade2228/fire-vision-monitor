import { E2E_ADMIN_PASSWORD } from './test-password.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort } from './test-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await getFreePort();
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

test('alarm stats endpoint returns trend data with site isolation', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-stats-api-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, MAX_CONCURRENT_STREAMS: '1' },
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
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
    body: { username: 'admin', displayName: '统计管理员', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const camera = (await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '趋势点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
    },
  })).body.camera;
  const fire = await request('/api/alarms', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      cameraId: camera.id,
      level: 'fire',
      confidence: 90,
      hotspot: { x: 40, y: 60 },
    },
  });
  assert.equal(fire.status, 201);
  await request(`/api/alarms/${fire.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'false' },
  });

  const stats = await request('/api/alarms/stats?days=7', { cookie: adminCookie });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.days.length, 7);
  assert.equal(stats.body.totals.total, 1);
  assert.equal(stats.body.totals.fire, 1);
  assert.equal(stats.body.totals.false, 1);
  assert.equal(stats.body.falseRate, 100);
  assert.ok(stats.body.days[stats.body.days.length - 1].total >= 1);

  // 未授权访问被拒绝；无站点权限的账号只能看到自己站点（应为空）。
  assert.equal((await request('/api/alarms/stats?days=7')).status, 401);
  const outsider = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'outsider',
      displayName: '站外账号',
      password: E2E_ADMIN_PASSWORD,
      role: 'viewer',
    },
  });
  assert.equal(outsider.status, 201);
  const outsiderLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'outsider', password: E2E_ADMIN_PASSWORD },
  });
  const outsiderStats = await request('/api/alarms/stats?days=7', {
    cookie: outsiderLogin.cookie,
  });
  assert.equal(outsiderStats.status, 200);
  assert.equal(outsiderStats.body.totals.total, 0);
  assert.ok(outsiderStats.body.bySite.length === 0);
});

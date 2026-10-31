import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4391;
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

test('API auth, roles, alarms, audit and backup', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-api-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

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
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitForServer(child);

  const request = async (
    pathName,
    { method = 'GET', body, cookie = '', headers = {} } = {},
  ) => {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        ...csrf,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
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

  const missingCsrf = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin12345!' }),
  });
  assert.equal(missingCsrf.status, 403);

  const setup = await request('/api/setup', {
    method: 'POST',
    body: {
      username: 'admin',
      displayName: '测试管理员',
      password: 'Admin12345!',
    },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;
  assert.ok(adminCookie);

  const statusAfterSetup = await request('/api/auth/status');
  assert.equal(statusAfterSetup.body.needsSetup, false);

  const capabilities = await request('/api/capabilities', { cookie: adminCookie });
  assert.equal(capabilities.status, 200);
  assert.equal(typeof capabilities.body.serverDetection, 'boolean');
  assert.equal((await request('/api/capabilities')).status, 401);

  const cameras = await request('/api/cameras', { cookie: adminCookie });
  assert.equal(cameras.status, 200);
  assert.equal(cameras.body.cameras.length, 6);

  const operator = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'operator1',
      displayName: '值班员',
      password: 'Operator123',
      role: 'operator',
    },
  });
  assert.equal(operator.status, 201);
  const viewer = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'viewer1',
      displayName: '只读',
      password: 'Viewer12345',
      role: 'viewer',
    },
  });
  assert.equal(viewer.status, 201);

  const operatorLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'operator1', password: 'Operator123' },
  });
  assert.equal(operatorLogin.status, 200);
  const operatorCookie = operatorLogin.cookie;

  const viewerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'viewer1', password: 'Viewer12345' },
  });
  assert.equal(viewerLogin.status, 200);
  const viewerCookie = viewerLogin.cookie;

  // 多站点模型下，非管理员需被授权到站点才能看到摄像头/告警；将测试账号归入默认站点。
  const siteList = await request('/api/sites', { cookie: adminCookie });
  const defaultSiteId = siteList.body.defaultSiteId;
  await request(`/api/users/${operator.body.user.id}/sites`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { siteIds: [defaultSiteId] },
  });
  await request(`/api/users/${viewer.body.user.id}/sites`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { siteIds: [defaultSiteId] },
  });

  const viewerWrite = await request('/api/cameras', {
    method: 'POST',
    cookie: viewerCookie,
    body: {
      name: '越权点位',
      zone: '测试',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
    },
  });
  assert.equal(viewerWrite.status, 403);

  const camera = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '测试 HLS',
      zone: '测试区',
      protocol: 'hls',
      sourceUrl: 'https://example.com/live.m3u8',
      enabled: true,
    },
  });
  assert.equal(camera.status, 201);

  const duplicateCamera = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '重复点位',
      zone: '测试区',
      protocol: 'hls',
      sourceUrl: 'https://example.com/live.m3u8',
      enabled: true,
    },
  });
  assert.equal(duplicateCamera.status, 409);

  const alarmPayload = {
    cameraId: camera.body.camera.id,
    level: 'fire',
    confidence: 91,
    hotspot: { x: 50, y: 51 },
    snapshot: 'data:image/jpeg;base64,/9j/2Q==',
  };
  const createdAlarm = await request('/api/alarms', {
    method: 'POST',
    cookie: operatorCookie,
    body: alarmPayload,
  });
  assert.equal(createdAlarm.status, 201);
  assert.equal(createdAlarm.body.alarm.status, 'pending');
  assert.ok(createdAlarm.body.alarm.snapshot);

  const duplicateAlarm = await request('/api/alarms', {
    method: 'POST',
    cookie: operatorCookie,
    body: alarmPayload,
  });
  assert.equal(duplicateAlarm.status, 200);
  assert.equal(duplicateAlarm.body.duplicate, true);
  assert.equal(duplicateAlarm.body.alarm.id, createdAlarm.body.alarm.id);

  const viewerAlarms = await request('/api/alarms', { cookie: viewerCookie });
  assert.equal(viewerAlarms.status, 200);
  assert.equal(viewerAlarms.body.alarms.length, 1);

  const viewerUpdate = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: viewerCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(viewerUpdate.status, 403);

  const confirm = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'confirmed', steps: [true, false, false, false] },
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.alarm.status, 'confirmed');
  assert.ok(confirm.body.alarm.confirmedAt);

  const archive = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'archived' },
  });
  assert.equal(archive.status, 200);
  assert.equal(archive.body.alarm.status, 'archived');

  const invalidTransition = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(invalidTransition.status, 409);

  const events = await request(`/api/alarms/${createdAlarm.body.alarm.id}/events`, {
    cookie: viewerCookie,
  });
  assert.equal(events.status, 200);
  assert.ok(events.body.events.length >= 3);

  const audit = await request('/api/audit', { cookie: adminCookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.logs.length > 0);

  const backup = await request('/api/admin/backup', {
    method: 'POST',
    cookie: adminCookie,
  });
  assert.equal(backup.status, 200);
  assert.match(backup.body.file, /^app-.*\.db$/);

  const viewerSystem = await request('/api/system', { cookie: viewerCookie });
  assert.equal(viewerSystem.status, 403);

  const malformed = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...csrf, 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);

  assert.equal(
    (await request('/api/auth/me', { cookie: operatorCookie })).status,
    200,
  );
  const reset = await request(`/api/users/${operator.body.user.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { password: 'NewOperator123' },
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await request('/api/auth/me', { cookie: operatorCookie })).status,
    401,
  );
});

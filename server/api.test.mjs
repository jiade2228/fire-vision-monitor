import { E2E_ADMIN_PASSWORD } from './test-password.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
    body: JSON.stringify({ username: 'admin', password: E2E_ADMIN_PASSWORD }),
  });
  assert.equal(missingCsrf.status, 403);

  const setup = await request('/api/setup', {
    method: 'POST',
    body: {
      username: 'admin',
      displayName: '测试管理员',
      password: E2E_ADMIN_PASSWORD,
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

  // 四步清单未完成时，服务端拒绝关闭（仅前端禁用按钮不足以阻止直接 PATCH）。
  const blockedArchive = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'closed' },
  });
  assert.equal(blockedArchive.status, 409);
  assert.deepEqual(blockedArchive.body.missing, [
    'start_smoke_exhaust',
    'broadcast_evacuation',
    'call_119',
  ]);

  const finishSteps = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { steps: [true, true, true, true] },
  });
  assert.equal(finishSteps.status, 200);
  assert.deepEqual(finishSteps.body.alarm.steps, [true, true, true, true]);

  const archive = await request(`/api/alarms/${createdAlarm.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'closed' },
  });
  assert.equal(archive.status, 200);
  // 对外统一 closed（落库 archived），见 server/alarm-status.mjs。
  assert.equal(archive.body.alarm.status, 'closed');

  // 历史别名 archived 同样受四步清单约束。
  const secondAlarm = await request('/api/alarms', {
    method: 'POST',
    cookie: operatorCookie,
    body: alarmPayload,
  });
  assert.equal(secondAlarm.status, 201);
  const secondId = secondAlarm.body.alarm.id;
  const secondConfirm = await request(`/api/alarms/${secondId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(secondConfirm.status, 200);
  assert.equal(secondConfirm.body.alarm.status, 'confirmed');

  const blockedAlias = await request(`/api/alarms/${secondId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'archived' },
  });
  assert.equal(blockedAlias.status, 409);
  assert.deepEqual(blockedAlias.body.missing, [
    'notify_fire_control',
    'start_smoke_exhaust',
    'broadcast_evacuation',
    'call_119',
  ]);

  const aliasSteps = await request(`/api/alarms/${secondId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { steps: [true, true, true, true] },
  });
  assert.equal(aliasSteps.status, 200);

  const aliasArchive = await request(`/api/alarms/${secondId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'archived' },
  });
  assert.equal(aliasArchive.status, 200);
  assert.equal(aliasArchive.body.alarm.status, 'closed');

  // 误报 false → archived 的清理路径同样要求单项确认。
  const thirdAlarm = await request('/api/alarms', {
    method: 'POST',
    cookie: operatorCookie,
    body: alarmPayload,
  });
  assert.equal(thirdAlarm.status, 201);
  const thirdId = thirdAlarm.body.alarm.id;
  const markedFalse = await request(`/api/alarms/${thirdId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'false' },
  });
  assert.equal(markedFalse.status, 200);
  assert.equal(markedFalse.body.alarm.status, 'false');

  const blockedFalseArchive = await request(`/api/alarms/${thirdId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'archived' },
  });
  assert.equal(blockedFalseArchive.status, 409);
  assert.deepEqual(blockedFalseArchive.body.missing, ['close_confirmed']);

  const falseConfirm = await request(`/api/alarms/${thirdId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { steps: [false, false, false, false, true] },
  });
  assert.equal(falseConfirm.status, 200);
  assert.equal(falseConfirm.body.alarm.steps[4], true);

  const falseArchive = await request(`/api/alarms/${thirdId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'archived' },
  });
  assert.equal(falseArchive.status, 200);
  assert.equal(falseArchive.body.alarm.status, 'closed');

  // 设备健康告警（接口不开放创建，直接落一条 confirmed 的 offline 告警）。
  const rawDb = new DatabaseSync(path.join(dataDir, 'app.db'));
  rawDb.exec('PRAGMA busy_timeout = 5000');
  const seededAt = Date.now();
  rawDb
    .prepare(
      `INSERT INTO alarms
       (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
        snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
        confirmed_at, false_at, archived_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 'offline', 0, 50, 50, NULL, NULL, 'confirmed', '',
               '[false,false,false,false]', ?, ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .run(
      'device-health-alarm',
      camera.body.camera.id,
      camera.body.camera.name,
      camera.body.camera.zone,
      defaultSiteId,
      seededAt,
      seededAt,
      seededAt,
    );
  rawDb.close();

  const deviceBlocked = await request('/api/alarms/device-health-alarm', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'closed' },
  });
  assert.equal(deviceBlocked.status, 409);
  assert.deepEqual(deviceBlocked.body.missing, ['close_confirmed']);

  const deviceConfirm = await request('/api/alarms/device-health-alarm', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { steps: [false, false, false, false, true] },
  });
  assert.equal(deviceConfirm.status, 200);

  const deviceArchive = await request('/api/alarms/device-health-alarm', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'closed' },
  });
  assert.equal(deviceArchive.status, 200);
  assert.equal(deviceArchive.body.alarm.status, 'closed');

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
  assert.ok(audit.body.total >= audit.body.logs.length);

  // 未登录与普通账号均不得查看审计日志
  const auditAnon = await request('/api/audit');
  assert.equal(auditAnon.status, 401);
  const auditViewer = await request('/api/audit', { cookie: viewerCookie });
  assert.equal(auditViewer.status, 403);

  // 按动作前缀筛选：登录相关记录应全部命中
  const auditAuth = await request('/api/audit?action=auth', { cookie: adminCookie });
  assert.equal(auditAuth.status, 200);
  assert.ok(auditAuth.body.logs.length > 0);
  assert.ok(
    auditAuth.body.logs.every((log) => log.action.startsWith('auth')),
    'action=auth 前缀筛选应只返回 auth.* 记录',
  );

  // 关键词与时间范围筛选
  const auditKeyword = await request('/api/audit?q=admin', { cookie: adminCookie });
  assert.equal(auditKeyword.status, 200);
  assert.ok(
    auditKeyword.body.logs.every(
      (log) =>
        (log.username ?? '').includes('admin') ||
        (log.detail ?? '').includes('admin') ||
        (log.targetId ?? '').includes('admin'),
    ),
  );
  const auditFuture = await request(
    `/api/audit?from=${Date.now() + 60_000}`,
    { cookie: adminCookie },
  );
  assert.equal(auditFuture.status, 200);
  assert.equal(auditFuture.body.logs.length, 0);

  // 分页：limit=1 时第二页不带回第一页的记录
  const auditPage1 = await request('/api/audit?limit=1&offset=0', { cookie: adminCookie });
  const auditPage2 = await request('/api/audit?limit=1&offset=1', { cookie: adminCookie });
  assert.equal(auditPage1.body.logs.length, 1);
  assert.equal(auditPage2.body.logs.length, 1);
  assert.notEqual(auditPage1.body.logs[0].id, auditPage2.body.logs[0].id);

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

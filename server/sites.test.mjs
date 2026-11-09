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

test('multi-site isolation, scoping and site lifecycle', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-sites-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 持续消费子进程输出，避免管道缓冲写满后阻塞服务端。
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
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitForServer(child);

  const request = async (
    pathName,
    { method = 'GET', body, cookie = '' } = {},
  ) => {
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
        // 部分路由返回纯文本（如视频点位不存在），保留原文便于断言。
        payload = text;
      }
    }
    return {
      status: response.status,
      body: payload,
      cookie: cookieFrom(response),
    };
  };

  const setup = await request('/api/setup', {
    method: 'POST',
    body: {
      username: 'admin',
      displayName: '站点管理员',
      password: E2E_ADMIN_PASSWORD,
    },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  // 初始只有迁移生成的默认站点。
  const initial = await request('/api/sites', { cookie: adminCookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.sites.length, 1);
  const defaultSiteId = initial.body.defaultSiteId;
  assert.equal(initial.body.sites[0].id, defaultSiteId);
  assert.deepEqual(initial.body.mySiteIds, [defaultSiteId]);

  const createdA = await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '园区 A 区', code: 'A1' },
  });
  assert.equal(createdA.status, 201);
  const siteA = createdA.body.site;

  const createdB = await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '园区 B 区' },
  });
  assert.equal(createdB.status, 201);
  const siteB = createdB.body.site;
  assert.equal(siteB.code, '园区 B 区');

  const duplicate = await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '重复编码', code: 'A1' },
  });
  assert.equal(duplicate.status, 409);

  const emptyName = await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '   ' },
  });
  assert.equal(emptyName.status, 400);

  const cameraA = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'A 区点位',
      zone: 'A',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      siteId: siteA.id,
    },
  });
  assert.equal(cameraA.status, 201);
  assert.equal(cameraA.body.camera.siteId, siteA.id);

  const cameraB = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'B 区点位',
      zone: 'B',
      protocol: 'rtsp',
      sourceUrl: 'rtsp://admin:pass@127.0.0.1:554/Streaming/Channels/101',
      enabled: true,
      siteId: siteB.id,
    },
  });
  assert.equal(cameraB.status, 201);
  assert.equal(cameraB.body.camera.siteId, siteB.id);
  assert.equal(cameraB.body.camera.hasSource, true);

  const badSite = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '非法站点点位',
      zone: 'X',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      siteId: 'does-not-exist',
    },
  });
  assert.equal(badSite.status, 400);

  // 管理员可按站点过滤。
  const onlyA = await request(`/api/cameras?siteId=${encodeURIComponent(siteA.id)}`, {
    cookie: adminCookie,
  });
  assert.equal(onlyA.status, 200);
  assert.equal(onlyA.body.cameras.length, 1);
  assert.equal(onlyA.body.cameras[0].name, 'A 区点位');

  // 新建值班员，仅授权 A 区。
  const operator = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'operator1',
      displayName: '值班员一',
      password: E2E_ADMIN_PASSWORD,
      role: 'operator',
    },
  });
  assert.equal(operator.status, 201);
  const operatorId = operator.body.user.id;

  const granted = await request(`/api/users/${operatorId}/sites`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { siteIds: [siteA.id, 'does-not-exist'] },
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body.siteIds, [siteA.id]);

  const operatorLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'operator1', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(operatorLogin.status, 200);
  const operatorCookie = operatorLogin.cookie;

  const operatorCameras = await request('/api/cameras', { cookie: operatorCookie });
  assert.equal(operatorCameras.status, 200);
  assert.deepEqual(
    operatorCameras.body.cameras.map((camera) => camera.name),
    ['A 区点位'],
  );

  const operatorSites = await request('/api/sites', { cookie: operatorCookie });
  assert.equal(operatorSites.status, 200);
  assert.deepEqual(operatorSites.body.mySiteIds, [siteA.id]);

  // 非管理员不能管理站点。
  const operatorCreateSite = await request('/api/sites', {
    method: 'POST',
    cookie: operatorCookie,
    body: { name: '越权站点' },
  });
  assert.equal(operatorCreateSite.status, 403);

  // 跨站点越权：告警读写与取流都必须被拦截。
  // 1×1 JPEG，用于验证抓拍文件的站点鉴权。
  const tinyJpeg =
    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

  const alarmB = await request('/api/alarms', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      cameraId: cameraB.body.camera.id,
      level: 'fire',
      confidence: 88,
      hotspot: { x: 40, y: 60 },
      snapshot: tinyJpeg,
    },
  });
  assert.equal(alarmB.status, 201);
  assert.ok(alarmB.body.alarm.snapshot);

  const operatorPatch = await request(`/api/alarms/${alarmB.body.alarm.id}`, {
    method: 'PATCH',
    cookie: operatorCookie,
    body: { status: 'confirmed' },
  });
  assert.equal(operatorPatch.status, 404);

  const operatorEvents = await request(`/api/alarms/${alarmB.body.alarm.id}/events`, {
    cookie: operatorCookie,
  });
  assert.equal(operatorEvents.status, 404);

  const operatorSnapshot = await request(
    `/api/alarms/${alarmB.body.alarm.id}/snapshot`,
    { cookie: operatorCookie },
  );
  assert.equal(operatorSnapshot.status, 404);

  const adminSnapshot = await request(
    `/api/alarms/${alarmB.body.alarm.id}/snapshot`,
    { cookie: adminCookie },
  );
  assert.equal(adminSnapshot.status, 200);

  const operatorCreateAlarm = await request('/api/alarms', {
    method: 'POST',
    cookie: operatorCookie,
    body: {
      cameraId: cameraB.body.camera.id,
      level: 'fire',
      confidence: 80,
      hotspot: { x: 10, y: 10 },
    },
  });
  assert.equal(operatorCreateAlarm.status, 403);

  const operatorStream = await request(
    `/streams/${cameraB.body.camera.id}/index.m3u8`,
    { cookie: operatorCookie },
  );
  assert.equal(operatorStream.status, 404);

  const operatorAlarms = await request('/api/alarms', { cookie: operatorCookie });
  assert.equal(operatorAlarms.status, 200);
  assert.equal(operatorAlarms.body.alarms.length, 0);

  // 管理员账号无需站点授权。
  const adminUserList = await request('/api/users', { cookie: adminCookie });
  const adminUser = adminUserList.body.users.find((user) => user.role === 'admin');
  const adminGrant = await request(`/api/users/${adminUser.id}/sites`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { siteIds: [siteA.id] },
  });
  assert.equal(adminGrant.status, 400);

  // 默认站点与有点位的站点不可删除。
  const deleteDefault = await request(`/api/sites/${defaultSiteId}`, {
    method: 'DELETE',
    cookie: adminCookie,
  });
  assert.equal(deleteDefault.status, 400);

  const deleteOccupied = await request(`/api/sites/${siteA.id}`, {
    method: 'DELETE',
    cookie: adminCookie,
  });
  assert.equal(deleteOccupied.status, 409);

  // 空站点可删除。
  const tempSite = await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '临时站点', code: 'TMP' },
  });
  const deleteTemp = await request(`/api/sites/${tempSite.body.site.id}`, {
    method: 'DELETE',
    cookie: adminCookie,
  });
  assert.equal(deleteTemp.status, 200);
  assert.equal(deleteTemp.body.ok, true);

  // 改名生效。
  const renamed = await request(`/api/sites/${siteB.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { name: '园区 B 区（东）' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.site.name, '园区 B 区（东）');

  // PATCH 点位可迁移站点。
  const moved = await request(`/api/cameras/${cameraA.body.camera.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { siteId: siteB.id },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.camera.siteId, siteB.id);

  const afterMoveA = await request(
    `/api/cameras?siteId=${encodeURIComponent(siteA.id)}`,
    { cookie: adminCookie },
  );
  assert.equal(afterMoveA.body.cameras.length, 0);

  const afterMoveB = await request(
    `/api/cameras?siteId=${encodeURIComponent(siteB.id)}`,
    { cookie: adminCookie },
  );
  assert.equal(afterMoveB.body.cameras.length, 2);

  // 迁移后原值班员（仅 A 区）不再看到该点位。
  const operatorAfterMove = await request('/api/cameras', { cookie: operatorCookie });
  assert.equal(operatorAfterMove.body.cameras.length, 0);
});

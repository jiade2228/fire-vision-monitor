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

test('site admin manages only assigned sites and cannot touch global settings', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-siteadmin-'));
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
    body: { username: 'admin', displayName: '平台管理员', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const siteA = (await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '园区 A', code: 'A' },
  })).body.site;
  const siteB = (await request('/api/sites', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '园区 B', code: 'B' },
  })).body.site;

  const cameraA = (await request('/api/cameras', {
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
  })).body.camera;
  const cameraB = (await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'B 区点位',
      zone: 'B',
      protocol: 'http',
      sourceUrl: 'http://127.0.0.1:59998/none.m3u8',
      enabled: true,
      siteId: siteB.id,
    },
  })).body.camera;

  const siteUser = await request('/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'siteop',
      displayName: 'A 区管理员',
      password: E2E_ADMIN_PASSWORD,
      role: 'operator',
      siteAdmin: true,
    },
  });
  assert.equal(siteUser.status, 201);
  assert.equal(siteUser.body.user.siteAdmin, true);
  const siteUserId = siteUser.body.user.id;
  const granted = await request(`/api/users/${siteUserId}/sites`, {
    method: 'PUT',
    cookie: adminCookie,
    body: { siteIds: [siteA.id] },
  });
  assert.equal(granted.status, 200);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'siteop', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.siteAdmin, true);
  const siteCookie = login.cookie;

  const sites = await request('/api/sites', { cookie: siteCookie });
  assert.equal(sites.status, 200);
  assert.equal(sites.body.sites.length, 1);
  assert.equal(sites.body.sites[0].id, siteA.id);
  assert.deepEqual(sites.body.mySiteIds, [siteA.id]);

  // 只能在自己的站点建点位
  const createdA = await request('/api/cameras', {
    method: 'POST',
    cookie: siteCookie,
    body: {
      name: 'A 区新增点位',
      zone: 'A',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      siteId: siteA.id,
    },
  });
  assert.equal(createdA.status, 201);
  const createdB = await request('/api/cameras', {
    method: 'POST',
    cookie: siteCookie,
    body: {
      name: '越权点位',
      zone: 'B',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      siteId: siteB.id,
    },
  });
  assert.equal(createdB.status, 403);

  // 只能改/删自己站点的点位
  const patchedA = await request(`/api/cameras/${cameraA.id}`, {
    method: 'PATCH',
    cookie: siteCookie,
    body: { name: 'A 区点位（改名）' },
  });
  assert.equal(patchedA.status, 200);
  assert.equal(
    (await request(`/api/cameras/${cameraB.id}`, {
      method: 'PATCH',
      cookie: siteCookie,
      body: { name: '越权改名' },
    })).status,
    403,
  );
  assert.equal(
    (await request(`/api/cameras/${cameraB.id}`, {
      method: 'DELETE',
      cookie: siteCookie,
    })).status,
    403,
  );

  // 预览只能看自己站点
  assert.equal(
    (await request(`/api/cameras/${cameraB.id}/preview`, { cookie: siteCookie })).status,
    403,
  );

  // 只能改自己站点的名称，不能建/删站点
  assert.equal(
    (await request(`/api/sites/${siteA.id}`, {
      method: 'PATCH',
      cookie: siteCookie,
      body: { name: '园区 A（改名）' },
    })).status,
    200,
  );
  assert.equal(
    (await request(`/api/sites/${siteB.id}`, {
      method: 'PATCH',
      cookie: siteCookie,
      body: { name: '越权改名' },
    })).status,
    403,
  );
  assert.equal(
    (await request('/api/sites', {
      method: 'POST',
      cookie: siteCookie,
      body: { name: '越权站点' },
    })).status,
    403,
  );

  // 通知渠道必须指定站点，且只能管理自己站点
  const channelA = await request('/api/notify/channels', {
    method: 'POST',
    cookie: siteCookie,
    body: {
      kind: 'webhook',
      name: 'A 区值班群',
      url: 'http://127.0.0.1:59997/hook',
      siteId: siteA.id,
    },
  });
  assert.equal(channelA.status, 201);
  assert.equal(
    (await request('/api/notify/channels', {
      method: 'POST',
      cookie: siteCookie,
      body: {
        kind: 'webhook',
        name: '越权渠道',
        url: 'http://127.0.0.1:59997/hook',
        siteId: siteB.id,
      },
    })).status,
    403,
  );
  assert.equal(
    (await request('/api/notify/channels', {
      method: 'POST',
      cookie: siteCookie,
      body: { kind: 'webhook', name: '全局渠道', url: 'http://127.0.0.1:59997/hook' },
    })).status,
    400,
  );
  const channels = await request('/api/notify/channels', { cookie: siteCookie });
  assert.equal(channels.body.channels.length, 1);
  assert.equal(channels.body.channels[0].siteId, siteA.id);

  // 可见范围：只看到 A 区点位
  const cameras = await request('/api/cameras', { cookie: siteCookie });
  assert.equal(cameras.status, 200);
  assert.ok(cameras.body.cameras.every((camera) => camera.siteId === siteA.id));
  assert.ok(cameras.body.cameras.some((camera) => camera.id === cameraA.id));

  // 全局功能一律拒绝
  assert.equal((await request('/api/users', { cookie: siteCookie })).status, 403);
  assert.equal(
    (await request('/api/users', {
      method: 'POST',
      cookie: siteCookie,
      body: {
        username: 'hacker',
        displayName: '越权',
        password: E2E_ADMIN_PASSWORD,
        role: 'admin',
      },
    })).status,
    403,
  );
  assert.equal((await request('/api/system', { cookie: siteCookie })).status, 403);
  assert.equal(
    (await request('/api/detection/status', { cookie: siteCookie })).status,
    403,
  );
  assert.equal((await request('/api/metrics', { cookie: siteCookie })).status, 403);
});

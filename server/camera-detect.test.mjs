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

test('camera detection settings persist and survive ordinary edits', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-detect-'));
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
    body: { username: 'admin', displayName: '检测管理员', password: 'Admin12345!' },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const nineRects = Array.from({ length: 9 }, (_, index) => ({
    x: index * 5,
    y: index * 4,
    w: 10,
    h: 8,
  }));

  const created = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '检测配置点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      detectEnabled: false,
      detectSensitivity: 'high',
      detectRoi: [
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 200, y: -10, w: 5, h: 5 },
        ...nineRects,
      ],
    },
  });
  assert.equal(created.status, 201);
  const camera = created.body.camera;
  assert.equal(camera.detectEnabled, false);
  assert.equal(camera.detectSensitivity, 'high');
  // 最多保留 8 个，且坐标被裁到 0-100
  assert.equal(camera.detectRoi.length, 8);
  assert.ok(camera.detectRoi.every((rect) => rect.x >= 0 && rect.x <= 100));
  assert.ok(
    camera.detectRoi.some((rect) => rect.x === 100 && rect.y === 0),
    '越界坐标应被裁到边界',
  );

  // 普通改名不能重置检测配置
  const renamed = await request(`/api/cameras/${camera.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { name: '检测配置点位（改名）' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.camera.name, '检测配置点位（改名）');
  assert.equal(renamed.body.camera.detectEnabled, false);
  assert.equal(renamed.body.camera.detectSensitivity, 'high');
  assert.equal(renamed.body.camera.detectRoi.length, 8);

  // 显式清空 ROI 与非法灵敏度
  const cleared = await request(`/api/cameras/${camera.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { detectRoi: [], detectSensitivity: 'ultra' },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.camera.detectRoi, []);
  assert.equal(cleared.body.camera.detectSensitivity, null);

  // 列表接口也要带检测配置
  const list = await request('/api/cameras', { cookie: adminCookie });
  const listed = list.body.cameras.find((item) => item.id === camera.id);
  assert.ok(listed);
  assert.equal(listed.detectEnabled, false);

  // 预览接口：未鉴权 401；无视频源 404
  assert.equal((await request(`/api/cameras/${camera.id}/preview`)).status, 401);
  const preview = await request(`/api/cameras/${camera.id}/preview`, {
    cookie: adminCookie,
  });
  assert.equal(preview.status, 404);
});

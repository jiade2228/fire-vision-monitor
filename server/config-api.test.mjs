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

test('布防时间表与误报热点接口：HTTP 往返、站点隔离与前端形态', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-config-api-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      SERVER_DETECTION: '0',
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
    body: { username: 'admin', displayName: '配置管理员', password: E2E_ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const cookie = setup.cookie;

  // 新建点位默认全天候布防（schedule=null）。
  const created = await request('/api/cameras', {
    method: 'POST',
    cookie,
    body: { name: '布防点位', zone: '测试区', protocol: 'none', sourceUrl: '', enabled: true },
  });
  assert.equal(created.status, 201);
  const cameraId = created.body.camera.id;
  assert.equal(created.body.camera.schedule, null);

  // 新建时直接带布防配置（POST 路径也必须落库，而非只支持事后 PATCH）。
  const overnight = {
    windows: [{ days: [0], start: '22:00', end: '06:00' }],
  };
  const createdWithSchedule = await request('/api/cameras', {
    method: 'POST',
    cookie,
    body: {
      name: '跨零点布防点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
      schedule: overnight,
    },
  });
  assert.equal(createdWithSchedule.status, 201);
  assert.equal(createdWithSchedule.body.camera.schedule.windows[0].start, '22:00');
  assert.equal(createdWithSchedule.body.camera.schedule.windows[0].end, '06:00');

  // PATCH 保存自定义时段。
  const schedule = {
    windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' }],
  };
  const patched = await request(`/api/cameras/${cameraId}`, {
    method: 'PATCH',
    cookie,
    body: { schedule },
  });
  assert.equal(patched.status, 200);

  // GET 回读必须是前端可编辑的 HH:mm 字符串形态（回归：此前下发分钟数导致输入框失效）。
  const listed = await request('/api/cameras', { cookie });
  const stored = listed.body.cameras.find((camera) => camera.id === cameraId);
  assert.ok(stored?.schedule, '布防配置应回读成功');
  assert.equal(stored.schedule.windows.length, 1);
  assert.equal(stored.schedule.windows[0].start, '08:00');
  assert.equal(stored.schedule.windows[0].end, '20:00');
  assert.equal(typeof stored.schedule.windows[0].start, 'string');
  assert.deepEqual(stored.schedule.windows[0].days, [1, 2, 3, 4, 5]);

  // 改回全天候：清空窗口等同于撤掉时间表。
  const cleared = await request(`/api/cameras/${cameraId}`, {
    method: 'PATCH',
    cookie,
    body: { schedule: { windows: [] } },
  });
  assert.equal(cleared.status, 200);
  const afterClear = (await request('/api/cameras', { cookie })).body.cameras.find(
    (camera) => camera.id === cameraId,
  );
  assert.equal(afterClear.schedule, null, '空窗口应回退全天候布防');

  // 误报热点：两条误报告警按点位聚合，days 与站点隔离生效。
  for (let i = 0; i < 2; i += 1) {
    const fire = await request('/api/alarms', {
      method: 'POST',
      cookie,
      body: { cameraId, level: 'fire', confidence: 90, hotspot: { x: 40, y: 60 } },
    });
    assert.equal(fire.status, 201);
    const marked = await request(`/api/alarms/${fire.body.alarm.id}`, {
      method: 'PATCH',
      cookie,
      body: { status: 'false' },
    });
    assert.equal(marked.status, 200);
  }
  const hotspots = await request('/api/alarms/false-hotspots?days=7', { cookie });
  assert.equal(hotspots.status, 200);
  assert.equal(hotspots.body.days, 7);
  const row = hotspots.body.hotspots.find((item) => item.cameraId === cameraId);
  assert.ok(row, '误报热点应包含该点位');
  assert.equal(Number(row.count), 2);
  assert.equal(row.cameraName, '布防点位');
});

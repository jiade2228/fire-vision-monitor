import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4398;
const base = `http://127.0.0.1:${port}`;
const csrf = { 'X-Requested-With': 'flame-vision' };

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

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

test('unreachable camera raises and keeps a single offline alarm', async (t) => {
  if (!ffmpegOk) {
    t.skip('未安装 FFmpeg，跳过服务端离线巡检测试');
    return;
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-offline-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      OFFLINE_TIMEOUT_MS: '800',
      OFFLINE_CHECK_INTERVAL_MS: '500',
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
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: cookieFrom(response) };
  };

  const setup = await request('/api/setup', {
    method: 'POST',
    body: { username: 'admin', displayName: '离线管理员', password: 'Admin12345!' },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const camera = await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '离线测试点位',
      zone: '测试区',
      protocol: 'http',
      // 端口必然拒绝连接，FFmpeg 拿不到任何帧。
      sourceUrl: 'http://127.0.0.1:59999/not-there.m3u8',
      enabled: true,
    },
  });
  assert.equal(camera.status, 201);
  assert.equal(camera.body.camera.detectEnabled, true);

  const deadline = Date.now() + 12_000;
  let offline = null;
  while (Date.now() < deadline) {
    const alarms = await request('/api/alarms', { cookie: adminCookie });
    offline = (alarms.body.alarms ?? []).find((alarm) => alarm.level === 'offline');
    if (offline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(offline, '应在超时后生成离线告警');
  assert.equal(offline.status, 'pending');
  assert.equal(offline.confidence, 0);
  assert.equal(offline.cameraName, '离线测试点位');
  assert.ok(offline.siteId, '离线告警应带站点归属');

  // 再等两个巡检周期，不应重复创建。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const again = await request('/api/alarms', { cookie: adminCookie });
  const offlineCount = (again.body.alarms ?? []).filter(
    (alarm) => alarm.level === 'offline',
  ).length;
  assert.equal(offlineCount, 1);
});

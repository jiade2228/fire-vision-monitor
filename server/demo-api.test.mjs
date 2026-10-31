import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4396;
const base = `http://127.0.0.1:${port}`;
const csrf = { 'X-Requested-With': 'flame-vision' };

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/auth/status`);
      if (response.ok) return;
    } catch {
      // 等待服务就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server startup timeout');
}

async function boot(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-demo-api-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir },
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
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitForServer(child);
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { ...csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'demo_admin',
      displayName: '演示管理员',
      password: 'demo-pass-1234',
    }),
  });
  assert.equal(setup.status, 201);
  const cookie = cookieFrom(setup);
  const request = async (pathName, options = {}) =>
    fetch(`${base}${pathName}`, {
      ...options,
      headers: {
        ...csrf,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: options.cookie ?? cookie,
      },
    });
  return { request, output, cookie };
}

test('演示视频源：启停链路、令牌鉴权与点位注册', { skip: !ffmpegOk }, async (t) => {
  const { request } = await boot(t);

  const initial = await (await request('/api/demo/status')).json();
  assert.equal(initial.running, false);
  assert.equal(initial.camera, null);
  assert.equal(initial.ffmpegAvailable, true);

  const started = await request('/api/demo/start', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(started.status, 200);
  const startedBody = await started.json();
  assert.equal(startedBody.running, true);
  assert.equal(startedBody.camera.code, 'DEMO-01');
  const playlistUrl = startedBody.camera.streamUrl;
  assert.match(playlistUrl, /^\/demo\/[a-f0-9]{32}\/index\.m3u8$/);

  // 链表 + 分片都只认当次令牌
  const playlist = await fetch(`${base}${playlistUrl}`);
  assert.equal(playlist.status, 200);
  assert.match(playlist.headers.get('content-type') ?? '', /mpegurl/i);
  const playlistText = await playlist.text();
  assert.equal(playlistText.includes('#EXTINF'), true);

  const firstSegment = playlistText.split('\n').find((line) => line.endsWith('.ts'));
  assert.ok(firstSegment, '播放列表应至少包含一个分片');
  const segmentResponse = await fetch(`${base}${playlistUrl.replace('index.m3u8', firstSegment.trim())}`);
  assert.equal(segmentResponse.status, 200);
  assert.match(segmentResponse.headers.get('content-type') ?? '', /video\/mp2t/i);

  const bogus = await fetch(`${base}/demo/${'f'.repeat(32)}/index.m3u8`);
  assert.equal(bogus.status, 404);

  // 服务端检测引擎应立即接管该点位
  const detection = await (await request('/api/detection/status')).json();
  assert.equal(
    detection.cameras.some((camera) => camera.code === 'DEMO-01'),
    true,
  );

  // 普通账号不能开关演示模式
  const viewer = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'demo_viewer',
      displayName: '演示访客',
      password: 'viewer-pass-1234',
      role: 'viewer',
    }),
  });
  assert.equal(viewer.status, 201);
  const viewerLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo_viewer', password: 'viewer-pass-1234' }),
  });
  const viewerCookie = cookieFrom(viewerLogin);
  const forbidden = await request('/api/demo/start', {
    method: 'POST',
    body: JSON.stringify({}),
    cookie: viewerCookie,
  });
  assert.equal(forbidden.status, 403);

  const stopped = await request('/api/demo/stop', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(stopped.status, 200);
  const stoppedBody = await stopped.json();
  assert.equal(stoppedBody.running, false);
  assert.equal(stoppedBody.removed, true);

  const cameras = (await (await request('/api/cameras')).json()).cameras;
  assert.equal(cameras.some((camera) => camera.code === 'DEMO-01'), false);
  const gone = await fetch(`${base}${playlistUrl}`);
  assert.equal(gone.status, 404);
});

test(
  '演示视频源：服务端识别在几十秒内产出火焰告警与抓拍',
  { skip: !ffmpegOk, timeout: 120_000 },
  async (t) => {
    const { request } = await boot(t);
    const started = await (
      await request('/api/demo/start', { method: 'POST', body: JSON.stringify({}) })
    ).json();
    assert.equal(started.running, true);

    let alarm = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { alarms } = await (await request('/api/alarms?limit=20')).json();
      alarm = alarms.find((item) => item.cameraName?.includes('演示点位')) ?? null;
      if (alarm) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    t.after(() =>
      request('/api/demo/stop', { method: 'POST', body: JSON.stringify({}) }).catch(
        () => undefined,
      ),
    );

    assert.ok(alarm, '演示流应在 90 秒内被服务端识别为火焰告警');
    assert.equal(alarm.level, 'fire');
    assert.ok(alarm.confidence > 0);
    assert.ok(alarm.snapshotFile, '告警应带抓拍');
  },
);

test(
  '演示数据一键清除：演示告警连媒体与推送日志被清，真实告警保留',
  { skip: !ffmpegOk, timeout: 120_000 },
  async (t) => {
    const { request } = await boot(t);
    const started = await (
      await request('/api/demo/start', { method: 'POST', body: JSON.stringify({}) })
    ).json();
    assert.equal(started.running, true);

    // 等演示告警产生（含抓拍与短视频）。
    let alarm = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { alarms } = await (await request('/api/alarms?limit=20')).json();
      alarm = alarms.find((item) => item.cameraName?.includes('演示点位')) ?? null;
      if (alarm) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(alarm, '演示流应被识别为火焰告警');

    // 造一条真实告警作为对照（应保留）。
    const realCamera = await request('/api/cameras', {
      method: 'POST',
      body: JSON.stringify({
        name: '真实点位',
        zone: 'A 区',
        protocol: 'none',
        enabled: true,
      }),
    });
    assert.equal(realCamera.status, 201);
    const realCameraId = (await realCamera.json()).camera.id;
    const realAlarm = await request('/api/alarms', {
      method: 'POST',
      body: JSON.stringify({
        cameraId: realCameraId,
        level: 'fire',
        confidence: 88,
        hotspot: { x: 10, y: 10 },
      }),
    });
    assert.equal(realAlarm.status, 201);

    const status = await (await request('/api/demo/status')).json();
    assert.ok(status.purgeable.alarms >= 1, '状态接口应报告可清除的演示告警');

    const purged = await (
      await request('/api/demo/purge', { method: 'POST', body: JSON.stringify({}) })
    ).json();
    assert.equal(purged.removed >= 1, true);
    assert.equal(purged.purgeable.alarms, 0, '清除后不应再有演示告警');

    // 演示告警与媒体都不见了，真实告警完好。
    const { alarms: remaining } = await (await request('/api/alarms?limit=50')).json();
    assert.equal(
      remaining.some((item) => item.cameraName?.includes('演示点位')),
      false,
    );
    const kept = remaining.find((item) => item.cameraName === '真实点位');
    assert.ok(kept, '真实告警必须保留');
    assert.equal(kept.level, 'fire');
    assert.equal(kept.confidence, 88);

    // 演示点位仍在（清除的是数据，不是点位）。
    const { cameras } = await (await request('/api/cameras')).json();
    assert.equal(
      cameras.some((camera) => camera.code === 'DEMO-01'),
      true,
    );

    t.after(() =>
      request('/api/demo/stop', { method: 'POST', body: JSON.stringify({}) }).catch(
        () => undefined,
      ),
    );
  },
);

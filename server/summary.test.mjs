import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4407;
const receiverPort = 4408;
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

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('daily summary pushes last-24h stats once per day', async (t) => {
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

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-summary-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      DAILY_SUMMARY_AT: '08:00',
      DAILY_SUMMARY_FORCE: '1',
      OFFLINE_TIMEOUT_MS: '120000',
      OFFLINE_CHECK_INTERVAL_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
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
    await new Promise((resolve) => receiver.close(resolve));
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
    body: { username: 'admin', displayName: '摘要管理员', password: 'Admin12345!' },
  });
  assert.equal(setup.status, 201);
  const adminCookie = setup.cookie;

  const channel = await request('/api/notify/channels', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      kind: 'webhook',
      name: '日报接收',
      url: `http://127.0.0.1:${receiverPort}/hook`,
    },
  });
  assert.equal(channel.status, 201);

  const camera = (await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '摘要测试点位',
      zone: '测试区',
      protocol: 'none',
      sourceUrl: '',
      enabled: true,
    },
  })).body.camera;

  const camera2 = (await request('/api/cameras', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: '摘要测试点位二',
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
  const smoke = await request('/api/alarms', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      cameraId: camera2.id,
      level: 'smoke',
      confidence: 70,
      hotspot: { x: 20, y: 30 },
    },
  });
  assert.equal(smoke.status, 201);
  const markedFalse = await request(`/api/alarms/${smoke.body.alarm.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'false' },
  });
  assert.equal(markedFalse.status, 200);

  const gotSummary = await waitFor(() =>
    received.some((body) => body.includes('值守摘要')),
  );
  assert.ok(
    gotSummary,
    `应在启动后推送值守摘要\n${serverLog
      .split('\n')
      .filter((line) => line.includes('daily_summary') || line.includes('notify'))
      .join('\n')}`,
  );

  const summaryBody = JSON.parse(
    received.find((body) => body.includes('值守摘要')),
  );
  assert.ok(summaryBody.message.includes('值守摘要（近 24 小时）'));
  assert.ok(summaryBody.message.includes('统计区间：'));
  assert.ok(summaryBody.message.includes('告警总数：2'));
  assert.ok(summaryBody.message.includes('判定误报 1'));
  assert.ok(summaryBody.message.includes('仍待处置 1'));
  assert.ok(summaryBody.message.includes('摘要测试点位') === false);
  assert.equal(summaryBody.total, 2, `payload=${JSON.stringify(summaryBody)}`);
  assert.equal(summaryBody.byLevel.fire, 1);
  assert.equal(summaryBody.byLevel.smoke, 1);
  assert.equal(summaryBody.byStatus.false, 1);

  // 同一天只推送一次。
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const summaryCount = received.filter((body) => body.includes('值守摘要')).length;
  assert.equal(summaryCount, 1);

  const logs = await request('/api/notify/logs', { cookie: adminCookie });
  assert.ok(logs.body.logs.some((log) => log.event === 'summary' && log.status === 'sent'));
});

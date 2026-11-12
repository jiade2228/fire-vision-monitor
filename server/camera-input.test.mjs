import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getFreePort } from './test-port.mjs';
import { E2E_ADMIN_PASSWORD } from './test-password.mjs';

/**
 * 点位输入校验与告警分页的接口级回归测试。
 *
 * 覆盖云端验收报告中的三条：
 * - D-05：名称超长曾被静默截断为 24 字并返回 201
 * - D-06：非法协议曾被静默降级为 none 并返回 201
 * - D-03：列表无 offset/时间范围，超过 1000 条的历史告警不可达
 * 另外校验 D-07 的文件日志确实落盘。
 */

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
      // 继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server startup timeout');
}

test('点位校验、告警分页与文件日志', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-camera-'));
  const child = spawn(process.execPath, ['server/boot.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
      SERVER_DETECTION: '0',
      NODE_ENV: 'test',
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
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
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
    return { status: response.status, body: payload, headers: response.headers };
  };

  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { ...csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      displayName: '管理员',
      password: E2E_ADMIN_PASSWORD,
    }),
  });
  assert.equal(setup.status, 201);
  const cookie = (setup.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');

  const sites = await request('/api/sites', { cookie });
  const siteId = sites.body.defaultSiteId;

  const createCamera = (overrides = {}) =>
    request('/api/cameras', {
      method: 'POST',
      cookie,
      body: {
        name: '一号点位',
        zone: 'A 区',
        protocol: 'none',
        sourceUrl: '',
        enabled: true,
        siteId,
        ...overrides,
      },
    });

  await t.test('名称超长返回 400 并说明上限', async () => {
    const response = await createCamera({ name: '点'.repeat(80) });
    assert.equal(response.status, 400, '超长名称不应再静默截断并返回 201');
    assert.match(String(response.body?.error ?? ''), /60/);
    assert.match(String(response.body?.error ?? ''), /80/);
  });

  await t.test('名称在上限内可正常创建并完整保留', async () => {
    const name = 'A 区 3 号楼 B1 消防通道东侧卷帘门'.repeat(2).slice(0, 40);
    const response = await createCamera({ name });
    assert.equal(response.status, 201);
    assert.equal(response.body.camera.name, name, '不应再被截断');
  });

  await t.test('非法协议返回 400 而非降级为 none', async () => {
    const response = await createCamera({ name: '非法协议点位', protocol: 'ftp-like' });
    assert.equal(response.status, 400);
    assert.match(String(response.body?.error ?? ''), /协议/);
  });

  await t.test('未传协议仍视为 none（兼容既有客户端）', async () => {
    const response = await createCamera({ name: '缺省协议点位', protocol: undefined });
    assert.equal(response.status, 201);
    assert.equal(response.body.camera.protocol, 'none');
  });

  // 同一路短时间内重复上报会被服务端去重（返回 200），
  // 因此用三个点位各造一条，确保分页确实有 3 条不同告警。
  for (let index = 0; index < 3; index += 1) {
    const camera = await createCamera({ name: `分页测试点位 ${index + 1}` });
    assert.equal(camera.status, 201);
    const created = await request('/api/alarms', {
      method: 'POST',
      cookie,
      body: {
        cameraId: camera.body.camera.id,
        level: index % 2 === 0 ? 'fire' : 'smoke',
        confidence: 80 + index,
        hotspot: { x: 20 + index, y: 20 },
      },
    });
    assert.ok([200, 201].includes(created.status), `创建告警返回 ${created.status}`);
  }

  await t.test('列表返回 total 与 hasMore，并支持 offset', async () => {
    const first = await request('/api/alarms?limit=2&offset=0', { cookie });
    assert.equal(first.status, 200);
    assert.equal(first.body.alarms.length, 2);
    assert.ok(first.body.total >= 3, `total 应不少于 3，实际 ${first.body.total}`);
    assert.equal(first.body.hasMore, true);

    const second = await request('/api/alarms?limit=2&offset=2', { cookie });
    assert.equal(second.status, 200);
    assert.ok(second.body.alarms.length >= 1);
    assert.equal(second.body.hasMore, false, '第二页之后不应还有更多');

    const ids = new Set([...first.body.alarms, ...second.body.alarms].map((item) => item.id));
    assert.equal(ids.size, first.body.alarms.length + second.body.alarms.length, '两页不应重复');
  });

  await t.test('时间范围按上海时区整日解释', async () => {
    const outside = await request('/api/alarms?from=2000-01-01&to=2000-01-02', { cookie });
    assert.equal(outside.status, 200);
    assert.equal(outside.body.total, 0, '历史区间不应命中今天的告警');

    const today = new Date();
    const stamp = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    const inside = await request(`/api/alarms?from=${stamp}&to=${stamp}`, { cookie });
    assert.equal(inside.status, 200);
    assert.ok(inside.body.total >= 3, '当天区间应命中刚创建的告警');
  });

  await t.test('非法 offset 不会 500', async () => {
    for (const value of ['-5', 'abc', '1e9']) {
      const response = await request(`/api/alarms?offset=${encodeURIComponent(value)}`, { cookie });
      assert.equal(response.status, 200, `offset=${value} 应被安全处理`);
    }
  });

  await t.test('文件日志写入 <数据目录>/logs/server.log', async () => {
    const logFile = path.join(dataDir, 'logs', 'server.log');
    const content = await fs.readFile(logFile, 'utf8');
    assert.match(content, /server_started/, '应记录启动日志');
    assert.match(content, /"level":"info"/, '日志应为 JSON 行格式');
  });
});

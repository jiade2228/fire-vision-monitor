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
 * SSE（/api/events）回归测试。
 *
 * 背景：该路由曾在建立连接时直接调用 `readSessionToken(...)`，但该函数只存在于
 * session.mjs 的闭包里、本模块并未导入。由于 `req.user.sid` 从未被赋值，
 * 右侧必然求值，导致每次连接都抛 ReferenceError：HTTP 头已发出 200，
 * 紧接着写入 500 日志并断流，前端表现为常驻「实时推送中断 · 重连中」，
 * 并退化为秒级轮询。
 *
 * 这个缺陷在单元测试与 E2E 中都没被发现，原因是没有任何测试真正建立过长连接。
 * 本文件专门覆盖：鉴权、ready 事件、以及登出后按 sid 精确关闭连接。
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

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

/**
 * 持续读取流，直到断言函数满足、流结束或超时。
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader 流读取器。
 * @param {(text: string) => boolean} predicate 满足即返回。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {Promise<{text: string, done: boolean, timedOut: boolean}>}
 */
async function readUntil(reader, predicate, timeoutMs) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
    ]);
    if (result.timedOut) return { text, done: false, timedOut: true };
    if (result.done) return { text, done: true, timedOut: false };
    text += decoder.decode(result.value, { stream: true });
    if (predicate(text)) return { text, done: false, timedOut: false };
  }
  return { text, done: false, timedOut: true };
}

test('SSE：鉴权、ready 事件与登出关闭连接', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-vision-sse-'));
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
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  await waitForServer(child);

  await t.test('未登录访问 SSE 返回 401', async () => {
    const response = await fetch(`${base}/api/events`, { headers: { ...csrf } });
    assert.equal(response.status, 401);
  });

  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { ...csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      displayName: '管理员',
      password: E2E_ADMIN_PASSWORD,
    }),
  });
  assert.equal(setup.status, 201, '初始化应成功');
  const cookie = cookieFrom(setup);
  assert.ok(cookie, '初始化应下发会话 Cookie');

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, {
    headers: { ...csrf, Cookie: cookie, Accept: 'text/event-stream' },
    signal: controller.signal,
  });

  await t.test('已登录应建立事件流并收到 ready', async () => {
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = stream.body.getReader();
    const { text, timedOut } = await readUntil(reader, (acc) => acc.includes('event: ready'), 5000);
    assert.ok(text.includes('event: ready'), `应收到 ready 事件，实际收到：${JSON.stringify(text.slice(0, 200))}`);
    assert.equal(timedOut, false, '不应在收到 ready 前超时');
    // 保留 reader 供下一个用例继续读取
    t.diagnostic(`ready 载荷：${text.trim().slice(0, 120)}`);
    globalThis.__sseReader = reader;
  });

  await t.test('建立连接不应产生未捕获异常', async () => {
    // 给服务端 300ms 写出错误日志的机会
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      !output.includes('readSessionToken is not defined'),
      '不应出现 readSessionToken 未定义的 ReferenceError',
    );
    assert.ok(
      !/unhandled_error[^\n]*\/api\/events/.test(output),
      `SSE 连接不应记录 unhandled_error，实际日志：${output.slice(-400)}`,
    );
  });

  await t.test('登出后应关闭对应事件流', async () => {
    const reader = globalThis.__sseReader;
    assert.ok(reader, '前置用例应已建立事件流');
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { ...csrf, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    const { done, timedOut } = await readUntil(reader, () => false, 3000);
    assert.equal(done, true, `登出后连接应被服务端关闭（timedOut=${timedOut}）`);
    controller.abort();
  });
});

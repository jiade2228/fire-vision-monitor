import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort } from './test-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;

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

test('legacy JSON login and camera migration survive SQLite upgrade', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-migrate-api-'));
  const salt = crypto.randomBytes(16).toString('hex');
  const password = 'LegacyPass123';
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const rtspUrl =
    'rtsp://legacy:rtsp-secret@192.168.1.20:554/Streaming/Channels/102';
  await fs.writeFile(
    path.join(dataDir, 'app.json'),
    JSON.stringify({
      version: 1,
      sessionSecret: crypto.randomBytes(48).toString('base64url'),
      users: [
        {
          id: 'legacy-admin',
          username: 'admin',
          displayName: '旧管理员',
          role: 'admin',
          salt,
          passwordHash,
          disabled: false,
          createdAt: Date.now(),
        },
      ],
      cameras: [
        {
          id: 'legacy-camera',
          code: 'CAM-01',
          name: '旧点位',
          zone: '旧区域',
          protocol: 'rtsp',
          sourceUrl: rtspUrl,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
  );

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
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitForServer(child);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'flame-vision',
    },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
  const cameras = await fetch(`${base}/api/cameras`, {
    headers: { Cookie: cookie, 'X-Requested-With': 'flame-vision' },
  });
  assert.equal(cameras.status, 200);
  const body = await cameras.json();
  assert.equal(body.cameras.length, 1);
  assert.equal(body.cameras[0].sourceUrl, rtspUrl);

  const rawDb = await fs.readFile(path.join(dataDir, 'app.db'));
  assert.equal(rawDb.includes(Buffer.from('rtsp-secret')), false);
  const files = await fs.readdir(dataDir);
  assert.ok(files.includes('app.json.migrated.enc'));
  assert.ok(!files.includes('app.json'));
});

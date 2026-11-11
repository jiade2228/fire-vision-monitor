import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';

function box() {
  return new SecretBox(crypto.randomBytes(32));
}

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-backup-'));
  const store = await openStore({ dataDir, secretBox: box() });
  // 关闭与清理都挂在 after 上：断言失败时也能正确释放数据库连接。
  t.after(async () => {
    try {
      store.close();
    } catch {
      // 已关闭则忽略
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return store;
}

test('备份落盘后可打开、完整性校验通过且行数与主库一致', async (t) => {
  const store = await makeStore(t);
  store.createAlarm({
    id: 'a1',
    cameraId: 'cam-1',
    cameraName: '点位',
    zone: 'A',
    level: 'fire',
    confidence: 90,
    hotspot: { x: 50, y: 50 },
    status: 'pending',
    createdAt: Date.now(),
  });

  const file = await store.backup();
  assert.match(path.basename(file), /^app-.*\.db$/);
  const stat = await fs.stat(file);
  assert.ok(stat.size > 0, '备份文件不应为空');
  assert.equal(store.getMeta('last_backup_status'), 'ok');
});

test('备份失败时不留下 .partial 半成品', async (t) => {
  const store = await makeStore(t);
  const dir = path.join(os.tmpdir(), `fire-backup-partial-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // 用「路径已存在但不是目录」制造确定性失败：mkdir 会抛 ENOTDIR。
  const notADir = path.join(dir, 'occupied');
  await fs.writeFile(notADir, 'x');

  await assert.rejects(() => store.backup(path.join(notADir, 'sub'), 3, 0));
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.partial'));
  assert.deepEqual(leftovers, [], '失败时不应留下 .partial 半成品');
});

test('备份轮转：份数上限生效', async (t) => {
  const store = await makeStore(t);
  const dir = path.join(os.tmpdir(), `fire-backup-retain-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (let i = 0; i < 5; i += 1) {
    await store.backup(dir, 2, 0);
    // 时间戳精度为毫秒，串行调用可能撞名，这里强制错开。
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const files = (await fs.readdir(dir)).filter((name) => /^app-.*\.db$/.test(name));
  assert.equal(files.length, 2, '应只保留 2 份备份');
});

test('备份轮转：总量上限生效', async (t) => {
  const store = await makeStore(t);
  const dir = path.join(os.tmpdir(), `fire-backup-bytes-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const first = await store.backup(dir, 10, 0);
  const size = (await fs.stat(first)).size;
  // 上限设为「一份多一点」：第二份加入后超限，应淘汰最旧的一份，但至少保留 1 份。
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.backup(dir, 10, size + 1024);
  const files = (await fs.readdir(dir)).filter((name) => /^app-.*\.db$/.test(name));
  assert.ok(files.length >= 1, '至少应保留一份备份');
  assert.ok(files.length <= 2, `备份份数应受总量上限约束，实际 ${files.length}`);
});

test('备份文件校验：非数据库文件被拒绝且给出可读原因', async (t) => {
  const store = await makeStore(t);
  const dir = path.join(os.tmpdir(), `fire-backup-bad-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const bogus = path.join(dir, 'not-a-db.db');
  await fs.writeFile(bogus, '这不是一个 SQLite 数据库');
  assert.throws(() => store.verifyBackupFile(bogus), /备份文件无法打开|备份完整性校验未通过/);
});

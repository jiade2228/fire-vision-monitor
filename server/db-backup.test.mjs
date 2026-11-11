import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { openStore } from './store.mjs';
import { SecretBox } from './secrets.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupScript = path.join(root, 'scripts', 'db-backup.mjs');

/**
 * 部署脚本依赖的备份链路。
 *
 * 关键点：必须用 VACUUM INTO 而不是文件复制。项目是 WAL 模式，直接复制
 * app.db 会漏掉未 checkpoint 的事务（实测漏过 1.4MB，告警从 2 条变 0 条）。
 * 这里用真实 store 写入数据后备份，断言数据确实进了备份文件。
 */

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbbackup-'));
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(async () => {
    try { store.close(); } catch { /* 已关闭 */ }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { store, dataDir };
}

test('db-backup：生成一致性备份并通过完整性校验', async (t) => {
  const { store, dataDir } = await makeStore(t);
  const user = store.createUser({
    id: crypto.randomUUID(),
    username: `backup-${crypto.randomUUID().slice(0, 8)}`,
    displayName: '备份测试',
    role: 'viewer',
    siteAdmin: false,
    salt: 's',
    passwordHash: 'h',
    disabled: false,
    tokenVersion: 0,
    createdAt: Date.now(),
  });
  assert.ok(user?.id);

  const out = path.join(dataDir, 'backups', 'manual.db');
  const { stdout } = await run(process.execPath, [
    backupScript,
    '--data-dir', dataDir,
    '--out', out,
  ]);

  const summary = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true, `备份应成功：${stdout}`);
  assert.equal(summary.integrity, 'ok');
  assert.ok(summary.users >= 1, '备份应包含已创建的用户');
  assert.ok(summary.bytes > 0, '备份文件不应为空');

  // 备份文件本身可独立打开
  const { DatabaseSync } = await import('node:sqlite');
  const check = new DatabaseSync(out, { readonly: true });
  const count = check.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  check.close();
  assert.ok(count >= 1);
});

test('db-backup：数据库不存在时返回非 0 退出码与明确信息', async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbbackup-empty-'));
  try {
    await assert.rejects(
      () => run(process.execPath, [backupScript, '--data-dir', emptyDir]),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.match(String(error.stderr), /未找到数据库文件/);
        return true;
      },
    );
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

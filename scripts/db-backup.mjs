/**
 * 数据库一致性备份（供部署脚本与运维手工调用）。
 *
 * 为什么必须用它而不是直接复制 app.db：
 *   项目使用 WAL 模式，未 checkpoint 的事务仍在 `app.db-wal` 里。
 *   直接 `copy app.db` 会得到「看起来正常、实际缺最近数据」的备份
 *   （实测某次漏掉 1.4MB WAL，告警记录从 2 条变 0 条）。
 *   `VACUUM INTO` 会写出包含全部已提交事务的一致性快照。
 *
 * 用法：
 *   node scripts/db-backup.mjs --data-dir ./data
 *   node scripts/db-backup.mjs --data-dir ./data --out ./data/backups/manual.db
 *
 * 输出：单行 JSON（便于脚本解析）
 *   { ok, target, integrity, users, cameras, alarms, bytes }
 * 退出码：0 成功；1 参数/环境错误；2 备份或校验失败
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const dataDir = path.resolve(argValue('--data-dir', path.join(process.cwd(), 'data')));
const source = path.join(dataDir, 'app.db');

if (!fs.existsSync(source)) {
  console.error(JSON.stringify({ ok: false, error: `未找到数据库文件：${source}` }));
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.resolve(
  argValue('--out', path.join(dataDir, 'backups', `backup-${stamp}.db`)),
);

fs.mkdirSync(path.dirname(target), { recursive: true });

let db;
try {
  db = new DatabaseSync(source, { readonly: true });
  // 单引号转义：SQLite 字符串字面量里 ' 需要写成 ''
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  db = null;
} catch (error) {
  try { db?.close(); } catch { /* ignore */ }
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exit(2);
}

let check;
try {
  check = new DatabaseSync(target, { readonly: true });
  const integrity = check.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
  const count = (table) => {
    try { return Number(check.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0); }
    catch { return 0; }
  };
  const summary = {
    ok: integrity === 'ok',
    target,
    integrity,
    users: count('users'),
    cameras: count('cameras'),
    alarms: count('alarms'),
    bytes: fs.statSync(target).size,
  };
  check.close();
  check = null;
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 2);
} catch (error) {
  try { check?.close(); } catch { /* ignore */ }
  console.error(
    JSON.stringify({ ok: false, target, error: `备份校验失败：${String(error?.message ?? error)}` }),
  );
  process.exit(2);
}

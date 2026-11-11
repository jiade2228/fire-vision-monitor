/**
 * 恢复被误删的内置通知模板（一次性运维工具）。
 *
 * 背景：内置模板由 V6 迁移播种，且迁移只在版本号 < 6 时执行。
 * 若旧版本误删了内置模板，升级到新版本后不会自动恢复。
 * 本脚本用同一份 BUILTIN_TEMPLATES 定义做幂等补种，不覆盖用户改过的同名模板。
 *
 * 用法：
 *   node server/restore-builtin-templates.mjs
 *   node server/restore-builtin-templates.mjs --data-dir /path/to/data
 *
 * 注意：脚本直接操作数据库，建议先停止服务或确认服务空闲（SQLite WAL 支持并发，
 * 但手工改动期间管理端可能展示旧状态）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from './store.mjs';
import { loadCredentialKey, SecretBox } from './secrets.mjs';
import { seedBuiltinTemplates } from './schema.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataDirIndex = args.indexOf('--data-dir');
const dataDir = dataDirIndex >= 0 && args[dataDirIndex + 1]
  ? path.resolve(args[dataDirIndex + 1])
  : path.join(projectRoot, 'data');

const credentialKey = await loadCredentialKey(dataDir, { createIfMissing: false });
const secretBox = new SecretBox(credentialKey);
const store = await openStore({ dataDir, secretBox });
try {
  const inserted = seedBuiltinTemplates(store.db);
  const remaining = store.db
    .prepare('SELECT id FROM notification_templates WHERE builtin = 1 ORDER BY id')
    .all()
    .map((row) => row.id);
  console.log(
    JSON.stringify(
      { dataDir, inserted, builtinTemplates: remaining },
      null,
      2,
    ),
  );
} finally {
  store.close();
}

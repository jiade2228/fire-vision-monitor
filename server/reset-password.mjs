import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredentialKey, SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';
import { passwordHash } from './auth/password.mjs';

/**
 * 本地管理员密码重置工具（忘记密码时使用）。
 *
 * 用法：
 *   node server/reset-password.mjs --username admin
 *   node server/reset-password.mjs --username admin --password 新密码
 *   node server/reset-password.mjs --username admin --data-dir /path/to/data
 *
 * 行为：直接改写该账号的密码哈希（scrypt，与服务端登录校验同参数），
 * 同时 token_version +1 使所有已登录设备立即失效——忘密码时这也正是需要的。
 * 不传 --password 时生成 16 位随机强密码并打印。
 *
 * 注意：本工具只能在本机对数据目录操作；生产服务无需停止（SQLite WAL 支持并发，
 * 单次短事务），但重置后请尽快重新登录。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { username: '', password: '', dataDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username') args.username = String(argv[++i] ?? '');
    else if (arg === '--password') args.password = String(argv[++i] ?? '');
    else if (arg === '--data-dir') args.dataDir = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/**
 * 密码哈希：复用 auth/password.mjs 的**唯一实现**。
 *
 * 改造前本文件自己调 `crypto.scryptSync(password, salt, 64)`，与服务端的
 * `promisify(crypto.scrypt)` 是两份独立实现 —— 任何一侧改参数，另一侧就会
 * 静默地让「刚重置的密码无法登录」。现在共用一份，参数升级自动同步。
 *
 * @param {string} password 明文密码。
 * @param {string} salt salt（hex）。
 * @returns {Promise<string>} 版本化哈希串。
 */
async function hashPassword(password, salt) {
  return passwordHash(password, salt);
}

function randomPassword() {
  // base62 随机 16 位，避开易混淆字符。
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.username) {
    console.log(
      '用法: node server/reset-password.mjs --username <用户名> [--password <新密码>] [--data-dir <数据目录>]',
    );
    process.exit(args.help ? 0 : 2);
  }
  const dataDir = path.resolve(args.dataDir || path.join(projectRoot, 'data'));
  const password = args.password || randomPassword();
  if (password.length < 8 || password.length > 128) {
    console.error('密码长度需在 8-128 位之间');
    process.exit(2);
  }

  // 不创建新密钥：createIfMissing=false，避免解不开已加密的通知渠道密钥。
  const credentialKey = await loadCredentialKey(dataDir, { createIfMissing: false });
  const store = await openStore({ dataDir, secretBox: new SecretBox(credentialKey) });
  try {
    const user = store.getUserByUsername(args.username);
    if (!user) {
      const users = store.listUsers?.() ?? [];
      console.error(
        `用户「${args.username}」不存在。现有用户：${users.map((u) => u.username).join('、') || '（无）'}`,
      );
      process.exit(1);
    }
    if (user.disabled) {
      console.error(`用户「${user.username}」已被停用，重置密码后仍无法登录，请先启用。`);
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    store.updateUser(user.id, {
      passwordHash: await hashPassword(password, salt),
      salt,
    });
    console.log(
      [
        `密码已重置：${user.username}（${user.role}${user.siteAdmin ? ' · 站点管理员' : ''}）`,
        `新密码：${password}`,
        '所有已登录设备需重新登录（会话已全部失效）。',
        '登录后可在「账号与权限」中修改为自己的密码。',
      ].join('\n'),
    );
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`重置失败：${error.message}`);
  process.exit(1);
});

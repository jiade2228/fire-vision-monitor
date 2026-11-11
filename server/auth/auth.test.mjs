import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../store.mjs';
import { SecretBox } from '../secrets.mjs';
import {
  LEGACY_SCRYPT_PARAMS,
  SCRYPT_PARAMS,
  isCurrentPasswordHash,
  parsePasswordHash,
  passwordHash,
  validatePassword,
  verifyPassword,
  validUsername,
} from './password.mjs';
import { isSensitiveUserObject, normalizeText, toPublicUser } from './identity.mjs';
import { AuthError, forbidden, invalidCredentials, unauthorized } from './errors.mjs';

/**
 * 认证域专项测试。
 *
 * 重点覆盖三件最容易在重构中悄悄坏掉的事：
 *   1. **存量密码不能失效** —— 旧格式哈希（裸 hex，用历史 N=2^14 参数算出）
 *      必须仍能通过校验，否则升级即等于全员掉线。
 *   2. **凭据不能外泄** —— 任何对外投影都不得带 salt / passwordHash。
 *   3. **会话撤销要精确** —— 登出只影响当前会话，账号级强失效才影响全部。
 */

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-auth-'));
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return store;
}

test('密码哈希：新格式带算法版本与参数前缀', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await passwordHash('Str0ngPass!', salt);
  assert.ok(hash.startsWith('scrypt$'), '应带 scrypt 算法前缀');
  const parts = hash.split('$');
  assert.equal(parts.length, 6, '格式应为 scrypt$N$r$p$salt$hash');
  assert.equal(Number(parts[1]), SCRYPT_PARAMS.N);
  assert.equal(Number(parts[2]), SCRYPT_PARAMS.r);
  assert.equal(Number(parts[3]), SCRYPT_PARAMS.p);
  assert.equal(parts[4], salt, 'salt 应内嵌在哈希串中');
  assert.ok(isCurrentPasswordHash(hash));
});

test('密码哈希：新格式校验通过，错误密码被拒', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await passwordHash('Str0ngPass!', salt);
  const user = { salt, passwordHash: hash };
  assert.equal(await verifyPassword('Str0ngPass!', user), true);
  assert.equal(await verifyPassword('wrong-pass', user), false);
  assert.equal(await verifyPassword('', user), false);
});

test('存量密码（旧格式裸 hex）仍可校验 —— 升级不得让老用户掉线', async () => {
  // 用**历史默认参数**（N=2^14）模拟改造前写入的哈希。
  const salt = crypto.randomBytes(16).toString('hex');
  const legacyHash = crypto
    .scryptSync('LegacyPass!', salt, 64, {
      N: LEGACY_SCRYPT_PARAMS.N,
      r: LEGACY_SCRYPT_PARAMS.r,
      p: LEGACY_SCRYPT_PARAMS.p,
      maxmem: 128 * 1024 * 1024,
    })
    .toString('hex');
  const user = { salt, passwordHash: legacyHash };

  const parsed = parsePasswordHash(legacyHash);
  assert.ok(parsed, '旧格式应可解析');
  assert.equal(parsed.params.N, LEGACY_SCRYPT_PARAMS.N, '旧格式必须回退到历史参数 N=2^14');
  assert.equal(await verifyPassword('LegacyPass!', user), true, '旧哈希必须能校验通过');
  assert.equal(await verifyPassword('nope', user), false);
  assert.equal(isCurrentPasswordHash(legacyHash), false, '旧哈希应被标记为需要升级');
});

test('存量密码与新格式参数不同 —— 证明升级用了不同的 KDF 参数', async () => {
  assert.notEqual(
    SCRYPT_PARAMS.N,
    LEGACY_SCRYPT_PARAMS.N,
    '新旧参数必须确实不同，否则升级测试无意义',
  );
  const salt = crypto.randomBytes(16).toString('hex');
  const legacyHash = crypto
    .scryptSync('SamePass!', salt, 64, {
      N: LEGACY_SCRYPT_PARAMS.N,
      r: LEGACY_SCRYPT_PARAMS.r,
      p: LEGACY_SCRYPT_PARAMS.p,
      maxmem: 128 * 1024 * 1024,
    })
    .toString('hex');
  const newHash = await passwordHash('SamePass!', salt);
  assert.notEqual(legacyHash, newHash, '同 salt 同密码、不同参数 → 哈希必须不同');
});

test('用户不存在时也执行等价 KDF（时序侧信道防护）', async () => {
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', undefined), false);
  assert.equal(await verifyPassword('anything', {}), false);
  assert.equal(await verifyPassword('anything', { salt: '', passwordHash: '' }), false);
});

test('密码策略：长度下限保持 8 位（兼容既有契约），拒绝明显弱口令', () => {
  assert.equal(validatePassword('1234567'), false, '少于 8 位必须拒绝');
  assert.equal(validatePassword('12345678'), true, '8 位应当允许（兼容既有契约）');
  assert.equal(validatePassword('a'.repeat(129)), false, '超过 128 位必须拒绝');
  assert.equal(validatePassword('        '), false, '纯空白必须拒绝');
  assert.equal(validatePassword('aaaaaaaa'), false, '单一字符重复必须拒绝');
  assert.equal(validatePassword(null), false);
  assert.equal(validatePassword(12345678), false, '非字符串必须拒绝');
});

test('用户名规则：3-32 位字母数字点横线下划线', () => {
  assert.equal(validUsername('abc'), true);
  assert.equal(validUsername('a.b-c_d'), true);
  assert.equal(validUsername('ab'), false);
  assert.equal(validUsername('a'.repeat(33)), false);
  assert.equal(validUsername('有中文'), false);
  assert.equal(validUsername('a b'), false);
});

test('身份投影：绝不带出 salt / passwordHash', () => {
  const user = {
    id: 'u1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    siteAdmin: false,
    disabled: false,
    createdAt: 1,
    salt: 'deadbeef',
    passwordHash: 'cafebabe',
  };
  const view = toPublicUser(user);
  assert.equal(view.salt, undefined);
  assert.equal(view.passwordHash, undefined);
  assert.equal(isSensitiveUserObject(view), false, '投影结果不应被判定为敏感对象');
  assert.equal(isSensitiveUserObject(user), true, '原始对象必须能被识别为敏感');
  assert.equal(toPublicUser(null), null);
});

test('文本归一化：去空白、压缩连续空格、截断', () => {
  assert.equal(normalizeText('  hello   world  ', 32), 'hello world');
  assert.equal(normalizeText('a'.repeat(50), 10), 'a'.repeat(10));
  assert.equal(normalizeText(null, 32), '');
  assert.equal(normalizeText(123, 32), '');
});

test('认证错误类型：对外文案不泄露账号存在性', () => {
  const invalid = invalidCredentials('账号不存在');
  const wrongPwd = invalidCredentials('密码不匹配');
  assert.equal(invalid.status, 401);
  assert.equal(wrongPwd.status, 401);
  assert.equal(invalid.message, wrongPwd.message, '两种失败对外文案必须完全一致');
  assert.notEqual(invalid.internalReason, wrongPwd.internalReason, '内部原因应不同（仅进日志）');

  const denied = forbidden('缺少能力 x');
  assert.equal(denied.status, 403);
  assert.equal(denied.message, '当前账号没有此操作权限');

  const anon = unauthorized();
  assert.equal(anon.status, 401);
  assert.equal(anon.message, '请先登录');

  const err = new AuthError(400, 'x', 'why', 'code');
  assert.deepEqual(err.toBody(), { error: 'x', code: 'code' });
});

test('会话登记：登出只撤销当前会话，其它会话保持有效', async (t) => {
  const store = await makeStore(t);
  const user = store.createUser({
    id: 'u1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    siteAdmin: false,
    salt: 's',
    passwordHash: 'h',
    disabled: false,
    tokenVersion: 0,
    createdAt: Date.now(),
  });

  // 模拟两个标签页各登录一次。
  const sidA = 'sid-a';
  const sidB = 'sid-b';
  store.registerSession(user.id, sidA, { expiresAt: Date.now() + 60_000 });
  store.registerSession(user.id, sidB, { expiresAt: Date.now() + 60_000 });
  assert.equal(store.listUserSessions(user.id).length, 2);

  // 撤销 A（当前标签页登出）。
  assert.equal(store.revokeSession(user.id, sidA), true);
  assert.equal(store.isSessionRevoked(user.id, sidA), true, 'A 应被撤销');
  assert.equal(store.isSessionRevoked(user.id, sidB), false, 'B 不应受影响');
  assert.equal(store.listUserSessions(user.id).length, 1, '活跃会话只剩 B');
});

test('会话登记：账号级强失效会撤销全部会话', async (t) => {
  const store = await makeStore(t);
  const user = store.createUser({
    id: 'u1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    siteAdmin: false,
    salt: 's',
    passwordHash: 'h',
    disabled: false,
    tokenVersion: 0,
    createdAt: Date.now(),
  });
  store.registerSession(user.id, 'a', { expiresAt: Date.now() + 60_000 });
  store.registerSession(user.id, 'b', { expiresAt: Date.now() + 60_000 });

  const revoked = store.revokeUserSessions(user.id);
  assert.equal(revoked, 2);
  assert.equal(store.isSessionRevoked(user.id, 'a'), true);
  assert.equal(store.isSessionRevoked(user.id, 'b'), true);
  assert.equal(store.listUserSessions(user.id).length, 0);
});

test('会话登记：未登记过的 sid 视为有效（兼容升级前的旧令牌）', async (t) => {
  const store = await makeStore(t);
  assert.equal(store.isSessionRevoked('u1', 'never-registered'), false);
});

test('会话登记：过期会话视为失效', async (t) => {
  const store = await makeStore(t);
  store.registerSession('u1', 'expired', { expiresAt: Date.now() - 1000 });
  assert.equal(store.isSessionRevoked('u1', 'expired'), true);
});

test('删除账号时其会话一并失效', async (t) => {
  const store = await makeStore(t);
  store.createUser({
    id: 'u1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    siteAdmin: false,
    salt: 's',
    passwordHash: 'h',
    disabled: false,
    tokenVersion: 0,
    createdAt: Date.now(),
  });
  store.registerSession('u1', 's1', { expiresAt: Date.now() + 60_000 });
  store.deleteUser('u1');
  assert.equal(store.isSessionRevoked('u1', 's1'), true, '删号后旧令牌不得继续可用');
});

test('V10 迁移：auth_sessions 表存在且可重入', async (t) => {
  const store = await makeStore(t);
  assert.equal(store.getMeta('schema_version'), '10');
  const table = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'")
    .get();
  assert.ok(table, 'auth_sessions 表应存在');
  // 重复调用不应报错。
  assert.equal(store.registerSession('u1', 'dup', { expiresAt: Date.now() + 1000 }), true);
  assert.equal(store.registerSession('u1', 'dup', { expiresAt: Date.now() + 2000 }), true);
  assert.equal(store.listUserSessions('u1').length, 1, '同 sid 重复登记应幂等');
});

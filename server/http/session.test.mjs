import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createSession } from './session.mjs';

function makeSession() {
  const metrics = { loginFailures: 0 };
  const session = createSession({
    store: {
      getUser: () => null,
    },
    sessionSecret: 'a'.repeat(32),
    sessionCookie: 'flame_session',
    sessionLifetimeSeconds: 3600,
    metrics,
    parseCookies: () => ({}),
  });
  return { session, metrics };
}

test('登录限流：同一来源对同一账号失败 8 次后被拦截', () => {
  const { session } = makeSession();
  for (let i = 0; i < 7; i += 1) {
    assert.equal(session.checkLoginBlocked('10.0.0.1', 'admin'), false);
    session.recordLoginFailure('10.0.0.1', 'admin');
  }
  assert.equal(session.checkLoginBlocked('10.0.0.1', 'admin'), false);
  session.recordLoginFailure('10.0.0.1', 'admin');
  assert.equal(
    session.checkLoginBlocked('10.0.0.1', 'admin'),
    true,
    '第 8 次失败后应被拦截',
  );
});

test('登录限流：账号维度配额不受 IP 伪造影响（分布式爆破）', () => {
  const { session } = makeSession();
  // 模拟开启 TRUST_PROXY 后攻击者轮换 X-Forwarded-For：
  // 每个来源 IP 只失败 1 次（不触发单 IP 配额），但都指向同一账号。
  for (let i = 0; i < 20; i += 1) {
    const ip = `10.0.0.${i + 1}`;
    session.recordLoginFailure(ip, 'admin');
  }
  assert.equal(
    session.checkLoginBlocked('10.0.0.99', 'admin'),
    true,
    '账号维度配额必须拦住轮换 IP 的暴力破解',
  );
  // 其它账号不受牵连。
  assert.equal(session.checkLoginBlocked('10.0.0.99', 'other'), false);
});

test('登录限流：单 IP 维度配额（30 次）仍然生效', () => {
  const { session } = makeSession();
  for (let i = 0; i < 30; i += 1) {
    session.recordLoginFailure('192.168.1.9', `user-${i}`);
  }
  assert.equal(session.checkLoginBlocked('192.168.1.9', 'fresh-user'), true);
});

test('登录成功清零失败计数：不再因历史失败被锁', () => {
  const { session } = makeSession();
  for (let i = 0; i < 7; i += 1) {
    session.recordLoginFailure('10.0.0.2', 'admin');
  }
  session.clearLoginFailures('admin');
  for (let i = 0; i < 7; i += 1) {
    session.recordLoginFailure('10.0.0.2', 'admin');
  }
  assert.equal(
    session.checkLoginBlocked('10.0.0.2', 'admin'),
    false,
    '登录成功清零后，7 次失败不应触发锁定',
  );
});

test('会话令牌：签名不匹配、过期与版本变更都会导致登录态失效', () => {
  const { session } = makeSession();
  const token = session.createSessionToken({ id: 'u1', tokenVersion: 3 });
  const parsed = session.readSessionToken(token);
  assert.equal(parsed.uid, 'u1');
  assert.equal(parsed.v, 3);

  // 篡改 payload → 签名校验失败。
  const [payload, signature] = token.split('.');
  const tampered = `${Buffer.from('{"uid":"u2"}').toString('base64url')}.${signature}`;
  assert.equal(session.readSessionToken(tampered), null);
  assert.equal(session.readSessionToken(`${payload}.bad`), null);
  assert.equal(session.readSessionToken('garbage'), null);

  // 过期令牌失效（用已过期的 exp 手工构造合法签名）。
  const expiredPayload = Buffer.from(
    JSON.stringify({ uid: 'u1', v: 3, exp: Date.now() - 1000 }),
  ).toString('base64url');
  const expired = `${expiredPayload}.${session.sessionSignature(expiredPayload)}`;
  assert.equal(session.readSessionToken(expired), null);
});

test('会话令牌：currentUser 在 tokenVersion 变化后立即失效', () => {
  let user = { id: 'u1', tokenVersion: 0, disabled: false };
  const session = createSession({
    store: { getUser: () => user },
    sessionSecret: 'b'.repeat(32),
    sessionCookie: 'flame_session',
    sessionLifetimeSeconds: 3600,
    metrics: { loginFailures: 0 },
    parseCookies: (header = '') => {
      const match = /flame_session=([^;]+)/.exec(String(header));
      return match ? { flame_session: decodeURIComponent(match[1]) } : {};
    },
  });
  const token = session.createSessionToken(user);
  const req = { headers: { cookie: `flame_session=${encodeURIComponent(token)}` } };
  assert.equal(session.currentUser(req)?.id, 'u1');
  user = { ...user, tokenVersion: 1 };
  assert.equal(
    session.currentUser(req),
    null,
    '密码重置/登出递增 tokenVersion 后旧令牌必须立即失效',
  );
});

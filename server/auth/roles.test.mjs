import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  ROLE_NAMES,
  capabilitiesFor,
  hasCapability,
  isManagerRole,
  isValidRole,
  normalizeRole,
} from './roles.mjs';

/**
 * 能力矩阵的回归测试。
 *
 * 核心目的：**保证重构后的权限判定与改造前完全等价**。
 * 改造前用 requireRole('admin') / requireRole('operator','admin') / requireManager
 * 三种表达，本测试把它们的判定结果固化为断言，防止后续调整能力矩阵时
 * 悄悄放宽或收紧既有权限。
 */

/** 改造前的 requireRole 实现（从 http/guards.mjs 原样搬来作为对照）。 */
function legacyRequireRole(user, roles) {
  if (!user) return false;
  return roles.includes(user.role);
}

/** 改造前的 requireManager 判定（isManager）。 */
function legacyRequireManager(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(user.siteAdmin);
}

const USERS = [
  { label: 'admin', role: 'admin', siteAdmin: false },
  { label: 'admin+siteAdmin', role: 'admin', siteAdmin: true },
  { label: 'operator', role: 'operator', siteAdmin: false },
  { label: 'operator+站点管理员', role: 'operator', siteAdmin: true },
  { label: 'viewer', role: 'viewer', siteAdmin: false },
  { label: 'viewer+站点管理员', role: 'viewer', siteAdmin: true },
];

test('角色白名单是单一来源且与 schema CHECK 约束一致', () => {
  assert.deepEqual([...ROLE_NAMES], ['admin', 'operator', 'viewer']);
  assert.ok(isValidRole('admin'));
  assert.ok(isValidRole('operator'));
  assert.ok(isValidRole('viewer'));
  assert.equal(isValidRole('manager'), false, 'manager 角色不存在（guards.mjs 的旧 JSDoc 有误）');
  assert.equal(isValidRole(''), false);
  assert.equal(isValidRole(null), false);
  assert.equal(isValidRole(undefined), false);
});

test('非法角色归一化为 viewer（与 schema.mjs 的兜底一致）', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('bogus'), 'viewer');
  assert.equal(normalizeRole(undefined), 'viewer');
  assert.equal(normalizeRole(null), 'viewer');
  assert.equal(normalizeRole(123), 'viewer');
});

test('GLOBAL_ADMIN 能力：仅全局管理员拥有，站点管理员不得拥有', () => {
  // 对应改造前 requireRole('admin') 的严格语义。
  for (const user of USERS) {
    const legacy = legacyRequireRole(user, ['admin']);
    const now = hasCapability(user, CAPABILITIES.GLOBAL_ADMIN);
    assert.equal(now, legacy, `${user.label} 的 GLOBAL_ADMIN 判定应与 requireRole('admin') 一致`);
  }
  // 站点管理员（含 viewer+siteAdmin）绝不能有 GLOBAL_ADMIN。
  assert.equal(hasCapability({ role: 'operator', siteAdmin: true }, CAPABILITIES.GLOBAL_ADMIN), false);
  assert.equal(hasCapability({ role: 'viewer', siteAdmin: true }, CAPABILITIES.GLOBAL_ADMIN), false);
});

test('ALARM_CREATE/ALARM_UPDATE：等价于 requireRole("operator","admin")', () => {
  for (const user of USERS) {
    const legacy = legacyRequireRole(user, ['operator', 'admin']);
    assert.equal(
      hasCapability(user, CAPABILITIES.ALARM_CREATE),
      legacy,
      `${user.label} 的 ALARM_CREATE 判定应与 requireRole('operator','admin') 一致`,
    );
    assert.equal(
      hasCapability(user, CAPABILITIES.ALARM_UPDATE),
      legacy,
      `${user.label} 的 ALARM_UPDATE 判定应与 requireRole('operator','admin') 一致`,
    );
  }
});

test('CAMERA_MANAGE / SITE_MANAGE / NOTIFY_MANAGE：等价于 requireManager', () => {
  for (const user of USERS) {
    const legacy = legacyRequireManager(user);
    for (const capability of [
      CAPABILITIES.CAMERA_MANAGE,
      CAPABILITIES.SITE_MANAGE,
      CAPABILITIES.NOTIFY_MANAGE,
    ]) {
      assert.equal(
        hasCapability(user, capability),
        legacy,
        `${user.label} 的 ${capability} 判定应与 requireManager 一致`,
      );
    }
  }
});

test('isManagerRole 与改造前的 isManager 判定完全一致', () => {
  for (const user of USERS) {
    assert.equal(isManagerRole(user), legacyRequireManager(user), user.label);
  }
  assert.equal(isManagerRole(null), false);
});

test('只读能力：viewer 具备读能力，但不具备任何写能力', () => {
  const viewer = { role: 'viewer', siteAdmin: false };
  assert.equal(hasCapability(viewer, CAPABILITIES.ALARM_READ), true);
  assert.equal(hasCapability(viewer, CAPABILITIES.CAMERA_READ), true);
  assert.equal(hasCapability(viewer, CAPABILITIES.SITE_READ), true);
  assert.equal(hasCapability(viewer, CAPABILITIES.ALARM_CREATE), false);
  assert.equal(hasCapability(viewer, CAPABILITIES.ALARM_UPDATE), false);
  assert.equal(hasCapability(viewer, CAPABILITIES.CAMERA_MANAGE), false);
  assert.equal(hasCapability(viewer, CAPABILITIES.NOTIFY_MANAGE), false);
  assert.equal(hasCapability(viewer, CAPABILITIES.USER_MANAGE), false);
  assert.equal(hasCapability(viewer, CAPABILITIES.GLOBAL_ADMIN), false);
});

test('admin 拥有全部能力', () => {
  const admin = { role: 'admin', siteAdmin: false };
  for (const capability of Object.values(CAPABILITIES)) {
    assert.equal(hasCapability(admin, capability), true, `admin 应拥有 ${capability}`);
  }
});

test('operator 的基础能力集合符合预期（不含管理与全局能力）', () => {
  const operator = { role: 'operator', siteAdmin: false };
  const caps = capabilitiesFor(operator);
  assert.equal(caps.has(CAPABILITIES.ALARM_READ), true);
  assert.equal(caps.has(CAPABILITIES.ALARM_CREATE), true);
  assert.equal(caps.has(CAPABILITIES.ALARM_UPDATE), true);
  assert.equal(caps.has(CAPABILITIES.CAMERA_READ), true);
  assert.equal(caps.has(CAPABILITIES.CAMERA_MANAGE), false);
  assert.equal(caps.has(CAPABILITIES.USER_MANAGE), false);
  assert.equal(caps.has(CAPABILITIES.GLOBAL_ADMIN), false);
});

test('站点管理员在基础角色之上追加管理能力，但不含 GLOBAL_ADMIN', () => {
  const siteAdmin = { role: 'operator', siteAdmin: true };
  const caps = capabilitiesFor(siteAdmin);
  assert.equal(caps.has(CAPABILITIES.CAMERA_MANAGE), true);
  assert.equal(caps.has(CAPABILITIES.SITE_MANAGE), true);
  assert.equal(caps.has(CAPABILITIES.NOTIFY_MANAGE), true);
  assert.equal(caps.has(CAPABILITIES.GLOBAL_ADMIN), false);
  assert.equal(caps.has(CAPABILITIES.USER_MANAGE), false);
});

test('账号管理能力仅全局管理员拥有', () => {
  assert.equal(hasCapability({ role: 'admin' }, CAPABILITIES.USER_MANAGE), true);
  assert.equal(
    hasCapability({ role: 'operator', siteAdmin: true }, CAPABILITIES.USER_MANAGE),
    false,
    '站点管理员不得管理账号（与改造前 requireRole("admin") 一致）',
  );
  assert.equal(hasCapability({ role: 'viewer' }, CAPABILITIES.USER_MANAGE), false);
});

test('空用户无任何能力', () => {
  assert.equal(capabilitiesFor(null).size, 0);
  assert.equal(capabilitiesFor(undefined).size, 0);
  assert.equal(hasCapability(null, CAPABILITIES.ALARM_READ), false);
});

test('能力矩阵自身结构合法：每个角色的能力都在能力常量表内', () => {
  const known = new Set(Object.values(CAPABILITIES));
  for (const role of ROLE_NAMES) {
    for (const capability of ROLE_CAPABILITIES[role]) {
      assert.ok(known.has(capability), `角色 ${role} 引用了未知能力 ${capability}`);
    }
  }
});

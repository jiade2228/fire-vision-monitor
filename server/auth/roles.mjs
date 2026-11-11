/**
 * 角色与权限模型（单一来源）。
 *
 * 重构背景：改造前角色枚举散落在 6 处 —— server/routes/users.mjs（创建/编辑两处
 * 硬编码数组）、server/schema.mjs（CHECK 约束与迁移兜底）、server/http/guards.mjs
 * （JSDoc 甚至写了并不存在的 'manager' 角色）、server/types.mjs、src/lib/api.ts。
 * 新增一个角色需要改 6 个文件，漏改一处就会出现「接口接受但 schema 拒绝」的不一致。
 *
 * 本模块把「角色 → 能力」矩阵集中定义，并提供：
 *   - ROLE_NAMES：合法角色名（唯一来源）
 *   - isValidRole()：角色合法性判断
 *   - CAPABILITIES：能力常量
 *   - ROLE_CAPABILITIES：角色 → 能力集合矩阵
 *   - capabilitiesFor(user)：解析某用户实际拥有的能力（合并全局角色与站点管理员身份）
 *
 * 兼容性约定：现有三种角色的能力划分严格保持原有行为，不做语义变更。
 * 新增能力时只需在 CAPABILITIES 增常量、在矩阵里挂到对应角色，
 * 再在路由上用 requireCapability 守卫即可，无需改动 schema。
 */

/**
 * @typedef {'admin' | 'operator' | 'viewer'} RoleName
 */

/**
 * 全部合法角色名。这是角色白名单的唯一来源。
 * 与 users 表 CHECK(role IN ('admin','operator','viewer')) 保持一致。
 * @type {readonly RoleName[]}
 */
export const ROLE_NAMES = Object.freeze(['admin', 'operator', 'viewer']);

/**
 * 角色中文名，用于界面与审计文案。
 * @type {Readonly<Record<RoleName, string>>}
 */
export const ROLE_LABELS = Object.freeze({
  admin: '全局管理员',
  operator: '操作员',
  viewer: '只读用户',
});

/**
 * 能力（capability）常量。
 *
 * 命名约定：`<域>:<动作>`，动作使用动词，避免与角色名混淆。
 * @type {Readonly<Record<string, string>>}
 */
export const CAPABILITIES = Object.freeze({
  // 告警
  ALARM_READ: 'alarm:read',
  ALARM_CREATE: 'alarm:create',
  ALARM_UPDATE: 'alarm:update',
  ALARM_DELETE: 'alarm:delete',
  // 点位
  CAMERA_READ: 'camera:read',
  CAMERA_MANAGE: 'camera:manage',
  // 站点
  SITE_READ: 'site:read',
  SITE_MANAGE: 'site:manage',
  // 账号
  USER_MANAGE: 'user:manage',
  // 通知
  NOTIFY_READ: 'notify:read',
  NOTIFY_MANAGE: 'notify:manage',
  // 系统
  SYSTEM_READ: 'system:read',
  SYSTEM_MANAGE: 'system:manage',
  // 全局管理（仅全局管理员拥有；站点管理员不具备）
  GLOBAL_ADMIN: 'system:global_admin',
  // 审计与指标
  AUDIT_READ: 'audit:read',
  METRIC_READ: 'metric:read',
});

/**
 * 角色 → 能力矩阵。
 *
 * 与改造前的实际行为逐条对齐（依据各路由的 requireRole/requireManager 声明）：
 *   - admin：全部能力。
 *   - operator：可读告警/点位/站点，可创建与更新告警，可管理自己站点的点位与通知配置。
 *   - viewer：只读。
 *
 * 注意：改造前 operator 并不能访问 requireRole('admin') 的接口（如账号管理、
 * 系统信息、审计日志），但可以通过 requireManager 访问点位管理与通知渠道管理
 * （前提是具备 siteAdmin 身份）。这一点由 SITE_MANAGE / NOTIFY_MANAGE 承载。
 *
 * @type {Readonly<Record<RoleName, readonly string[]>>}
 */
export const ROLE_CAPABILITIES = Object.freeze({
  admin: Object.freeze(Object.values(CAPABILITIES)),
  operator: Object.freeze([
    CAPABILITIES.ALARM_READ,
    CAPABILITIES.ALARM_CREATE,
    CAPABILITIES.ALARM_UPDATE,
    CAPABILITIES.CAMERA_READ,
    CAPABILITIES.SITE_READ,
    CAPABILITIES.NOTIFY_READ,
  ]),
  viewer: Object.freeze([
    CAPABILITIES.ALARM_READ,
    CAPABILITIES.CAMERA_READ,
    CAPABILITIES.SITE_READ,
  ]),
});

/**
 * 站点管理员额外获得的能力（在其被授权的站点范围内生效）。
 *
 * 这部分能力原先由 requireManager 表达：isManager(user) 为真即代表
 * 「全局管理员，或至少管理一个站点」。
 *
 * 注意：`GLOBAL_ADMIN` **不在**此列表中 —— 它代表「仅全局管理员可执行」，
 * 对应改造前 requireRole('admin') 的严格语义（如站点的新增与删除）。
 * @type {readonly string[]}
 */
export const SITE_ADMIN_CAPABILITIES = Object.freeze([
  CAPABILITIES.CAMERA_MANAGE,
  CAPABILITIES.SITE_MANAGE,
  CAPABILITIES.NOTIFY_MANAGE,
]);

/**
 * 判断角色名是否合法。
 * @param {unknown} value 待校验的角色名。
 * @returns {boolean}
 */
export function isValidRole(value) {
  return typeof value === 'string' && ROLE_NAMES.includes(value);
}

/**
 * 归一化角色名：非法值一律降级为 viewer（与改造前 schema.mjs:163 的兜底一致）。
 * @param {unknown} value 原始角色名。
 * @returns {RoleName}
 */
export function normalizeRole(value) {
  return isValidRole(value) ? /** @type {RoleName} */ (value) : 'viewer';
}

/**
 * 解析用户的实际能力集合。
 *
 * 规则：
 *   1. 基础能力来自 role（ROLE_CAPABILITIES）。
 *   2. 若用户具备站点管理员身份（siteAdmin === true），追加 SITE_ADMIN_CAPABILITIES。
 *   3. 全局管理员拥有全部能力，且不依赖 siteAdmin 标记。
 *
 * @param {{role?: string, siteAdmin?: boolean} | null | undefined} user 用户对象。
 * @returns {Set<string>} 能力集合。
 */
export function capabilitiesFor(user) {
  /** @type {Set<string>} */
  const result = new Set();
  if (!user) return result;
  const role = normalizeRole(user.role);
  for (const capability of ROLE_CAPABILITIES[role]) result.add(capability);
  if (role === 'admin') {
    // 全局管理员拥有全部能力，不依赖 siteAdmin。
    for (const capability of Object.values(CAPABILITIES)) result.add(capability);
    return result;
  }
  if (user.siteAdmin) {
    for (const capability of SITE_ADMIN_CAPABILITIES) result.add(capability);
  }
  return result;
}

/**
 * 判断用户是否拥有指定能力。
 * @param {{role?: string, siteAdmin?: boolean} | null | undefined} user 用户对象。
 * @param {string} capability 能力常量。
 * @returns {boolean}
 */
export function hasCapability(user, capability) {
  return capabilitiesFor(user).has(capability);
}

/**
 * 角色是否属于「可管理」类角色。
 *
 * 兼容改造前的语义：admin 恒为 true；非 admin 需要 siteAdmin 身份。
 * 用于 requireManager 的向后兼容实现。
 * @param {{role?: string, siteAdmin?: boolean} | null | undefined} user 用户对象。
 * @returns {boolean}
 */
export function isManagerRole(user) {
  if (!user) return false;
  if (normalizeRole(user.role) === 'admin') return true;
  return Boolean(user.siteAdmin);
}

/**
 * 能力 → 改造前对应守卫语义的映射表。
 *
 * 降级路径需要还原「改造前这个接口到底用的是哪种守卫」，否则旧调用方
 * （只提供 requireRole / requireManager 的）会因语义漂移而行为改变：
 *   - CAMERA_MANAGE / SITE_MANAGE / NOTIFY_MANAGE 改造前是 requireManager
 *     （全局管理员 **或站点管理员**），不能退化成 requireRole('admin')。
 *   - GLOBAL_ADMIN / USER_MANAGE / AUDIT_READ 等改造前是 requireRole('admin')，
 *     严格只有全局管理员。
 *
 * @type {Readonly<Record<string, 'role' | 'manager'>>}
 */
export const CAPABILITY_LEGACY_GUARD = Object.freeze({
  [CAPABILITIES.CAMERA_MANAGE]: 'manager',
  [CAPABILITIES.SITE_MANAGE]: 'manager',
  [CAPABILITIES.NOTIFY_MANAGE]: 'manager',
  [CAPABILITIES.ALARM_CREATE]: 'role',
  [CAPABILITIES.ALARM_UPDATE]: 'role',
  [CAPABILITIES.GLOBAL_ADMIN]: 'role',
  [CAPABILITIES.USER_MANAGE]: 'role',
  [CAPABILITIES.AUDIT_READ]: 'role',
  [CAPABILITIES.METRIC_READ]: 'role',
  [CAPABILITIES.SYSTEM_READ]: 'role',
  [CAPABILITIES.SYSTEM_MANAGE]: 'role',
  [CAPABILITIES.NOTIFY_READ]: 'role',
});

/**
 * 能力守卫的降级解析。
 *
 * 用途：让 `requireCapability` 成为**可选**的 deps 项。
 * 外部调用方（既有测试、潜在集成方）按旧约定只提供 requireAuth/requireRole，
 * 此时若直接调用 requireCapability(...) 会抛 "not a function" 而整个应用起不来。
 *
 * 降级规则：
 *   - 提供了 requireCapability → 直接使用（走能力矩阵，新语义）。
 *   - 未提供 → 按 CAPABILITY_LEGACY_GUARD 还原改造前的守卫语义：
 *     'manager' 用 requireManager（若可用），'role' 用 requireRole(反查到的角色)。
 *     这样旧调用方的行为与改造前**保持一致**，同时新代码仍能享受能力模型。
 *
 * @param {((capability: string) => import('express').RequestHandler) | undefined} requireCapability
 *   能力守卫（可选）。
 * @param {((...roles: string[]) => import('express').RequestHandler) | undefined} requireRole
 *   角色守卫（兼容层）。
 * @param {import('express').RequestHandler | undefined} requireManager
 *   管理守卫（兼容层，对应 requireManager）。
 * @returns {(capability: string) => import('express').RequestHandler} 可用的守卫工厂。
 */
export function resolveCapabilityGuard(requireCapability, requireRole, requireManager) {
  if (typeof requireCapability === 'function') return requireCapability;
  return (capability) => {
    const kind = CAPABILITY_LEGACY_GUARD[capability] ?? 'role';
    if (kind === 'manager' && typeof requireManager === 'function') {
      return requireManager;
    }
    if (typeof requireRole === 'function') {
      const roles = rolesWithCapability(capability);
      return requireRole(...(roles.length ? roles : ['__none__']));
    }
    if (typeof requireManager === 'function') return requireManager;
    // 守卫都不可用：恒拒绝，绝不静默放行。
    return (_req, res) => {
      res.status(403).json({ error: '当前账号没有此操作权限' });
    };
  };
}

/**
 * 反查：哪些角色天然具备指定能力（不含站点管理员附加能力）。
 *
 * 只依据 ROLE_CAPABILITIES 计算 —— 站点管理员的附加能力依赖用户上下文，
 * 无法在守卫工厂阶段静态判定，故不纳入。降级路径仅用于旧调用方兼容，
 * 主路径（提供了 requireCapability）不做此近似。
 *
 * @param {string} capability 能力常量。
 * @returns {string[]} 具备该能力的角色名。
 */
export function rolesWithCapability(capability) {
  const roles = [];
  for (const role of ROLE_NAMES) {
    if (ROLE_CAPABILITIES[role].includes(capability)) roles.push(role);
  }
  return roles;
}

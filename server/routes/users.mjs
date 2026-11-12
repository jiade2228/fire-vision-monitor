import { apiNotFound } from '../http/not-found.mjs';
import crypto from 'node:crypto';

import { badRequest, conflict, notFound } from '../auth/errors.mjs';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';
import { parseRoleInput } from '../auth/identity.mjs';

/**
 * 账号（User）接口：列表、创建、编辑、删除，以及站点授权（/api/users/:id/sites）。
 *
 * 采用 deps 注入模式：main() 作用域内创建的 store 与守卫，以及 index.mjs 中的
 * 模块级辅助函数，统一通过 deps 传入；node 内建 crypto 直接 import，避免与
 * index.mjs 循环依赖。行为与原内联路由完全一致。
 *
 * ── 重构说明（本轮）────────────────────────────────────────────────
 *
 * 1. **角色白名单单一来源**。原先 `['admin','operator','viewer']` 在本文件
 *    出现两次（创建/编辑），此外 schema.mjs、types.mjs、api.ts、guards.mjs
 *    各有一份。加新角色要改 6 处，漏改就会「接口接受但 schema 拒绝」。
 *    现在统一走 auth/roles.mjs 的 ROLE_NAMES / parseRoleInput。
 * 2. **权限守卫改用能力模型**。requireRole('admin') → requireCapability(USER_MANAGE)，
 *    语义更明确，且未来引入自定义角色时不必再逐路由改。
 * 3. **错误处理统一**。走 auth/errors.mjs，响应体格式仍是 `{ error }`（兼容）。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerUserRoutes(app, deps) {
  const {
    requireManager,
    requireRole,
    store,
    publicUser,
    passwordHash,
    validUsername,
    validatePassword,
    passwordIssue,
    requireAuth,
    requireCapability,
    normalizeText,
    clientIp,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  app.get('/api/users', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), (_req, res) => {
    res.json({ users: store.listUsers().map(publicUser) });
  });

  app.post('/api/users', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), async (req, res) => {
    const username = normalizeText(req.body.username, 32);
    const displayName = normalizeText(req.body.displayName, 32) || username;
    let role = 'viewer';
    if (req.body.role !== undefined) {
      const parsed = parseRoleInput(req.body.role);
      if (!parsed.ok) {
        const error = badRequest(parsed.error);
        return res.status(error.status).json(error.toBody());
      }
      role = parsed.role;
    }
    if (!validUsername(username)) {
      const error = badRequest('用户名需为 3-32 位字母、数字、点、横线或下划线');
      return res.status(error.status).json(error.toBody());
    }
    if (store.getUserByUsername(username)) {
      const error = conflict('用户名已存在');
      return res.status(error.status).json(error.toBody());
    }
    const createPasswordProblem = passwordIssue(req.body.password);
    if (createPasswordProblem) {
      const error = badRequest(createPasswordProblem);
      return res.status(error.status).json(error.toBody());
    }
    let user;
    try {
      user = store.createUser({
        id: crypto.randomUUID(),
        username,
        displayName,
        role,
        siteAdmin: role !== 'admin' && req.body.siteAdmin === true,
        salt: crypto.randomBytes(16).toString('hex'),
        passwordHash: await passwordHash(req.body.password),
        disabled: false,
        tokenVersion: 0,
        createdAt: Date.now(),
      });
    } catch (error) {
      // 并发同名注册：唯一索引兜底，避免把业务冲突报成 500。
      if (String(error?.message).includes('UNIQUE constraint failed')) {
        const conflictError = conflict('用户名已存在');
        return res.status(conflictError.status).json(conflictError.toBody());
      }
      throw error;
    }
    store.recordAudit({
      user: req.user,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      detail: `创建 ${role} 账号 ${username}`,
      ip: clientIp(req),
    });
    res.status(201).json({ user: publicUser(user) });
  });

  app.patch('/api/users/:id', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), async (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (req.body.role !== undefined) {
      const parsed = parseRoleInput(req.body.role);
      if (!parsed.ok) {
        const error = badRequest(parsed.error);
        return res.status(error.status).json(error.toBody());
      }
    }
    if (req.body.disabled !== undefined) {
      if (user.id === req.user.id && req.body.disabled) {
        const error = badRequest('不能停用当前登录账号');
        return res.status(error.status).json(error.toBody());
      }
    }
    const nextRole = req.body.role ?? user.role;
    if (req.body.siteAdmin === true && nextRole === 'admin') {
      const error = badRequest('全局管理员无需设置为站点管理员');
      return res.status(error.status).json(error.toBody());
    }
    let newSalt;
    let newHash;
    if (req.body.password !== undefined) {
      const updatePasswordProblem = passwordIssue(req.body.password);
      if (updatePasswordProblem) {
        const error = badRequest(updatePasswordProblem);
        return res.status(error.status).json(error.toBody());
      }
      newSalt = crypto.randomBytes(16).toString('hex');
      newHash = await passwordHash(req.body.password, newSalt);
    }
    // 「至少保留一个可用管理员」的计数与写入在同一事务内完成，避免并发降级导致 0 管理员。
    const guarded = store.updateUserWithAdminGuard(user.id, {
      displayName:
        req.body.displayName !== undefined
          ? normalizeText(req.body.displayName, 32) || user.displayName
          : undefined,
      role: req.body.role,
      disabled:
        req.body.disabled !== undefined ? Boolean(req.body.disabled) : undefined,
      siteAdmin:
        req.body.siteAdmin !== undefined
          ? nextRole !== 'admin' && Boolean(req.body.siteAdmin)
          : undefined,
      salt: newSalt,
      passwordHash: newHash,
    });
    if (!guarded.ok) {
      const error = badRequest(guarded.error ?? '账号更新失败');
      return res.status(error.status).json(error.toBody());
    }
    const updated = guarded.user;
    // 改密码 / 停用 / 改角色 = 账号级强失效：该账号全部令牌立即作废。
    // 这与「登出只撤销当前会话」是两层语义，详见 routes/auth.mjs 的说明。
    if (
      req.body.password !== undefined ||
      req.body.disabled === true ||
      req.body.role !== undefined
    ) {
      store.revokeUserSessions?.(user.id);
    }
    store.recordAudit({
      user: req.user,
      action: 'user.update',
      targetType: 'user',
      targetId: user.id,
      detail: [
        req.body.role ? `role=${req.body.role}` : '',
        req.body.siteAdmin !== undefined
          ? `siteAdmin=${Boolean(req.body.siteAdmin)}`
          : '',
        req.body.disabled !== undefined ? `disabled=${Boolean(req.body.disabled)}` : '',
        req.body.password ? 'password-reset' : '',
      ]
        .filter(Boolean)
        .join(' '),
      ip: clientIp(req),
    });
    res.json({ user: publicUser(updated) });
  });

  app.delete('/api/users/:id', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (user.id === req.user.id) {
      const error = badRequest('不能删除当前账号');
      return res.status(error.status).json(error.toBody());
    }
    // 计数与删除在同一事务内完成，避免并发删除把可用管理员降到 0。
    const guarded = store.deleteUserWithAdminGuard(user.id);
    if (!guarded.ok) {
      const error = badRequest(guarded.error ?? '账号删除失败');
      return res.status(error.status).json(error.toBody());
    }
    store.recordAudit({
      user: req.user,
      action: 'user.delete',
      targetType: 'user',
      targetId: user.id,
      detail: `删除账号 ${user.username}`,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  });

  app.get('/api/users/:id/sites', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    res.json({ siteIds: store.siteMemberSiteIds(user.id), sites: store.listSites() });
  });

  app.put('/api/users/:id/sites', requireAuth, capabilityGuard(CAPABILITIES.USER_MANAGE), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (user.role === 'admin') {
      const error = badRequest('管理员默认可见全部站点，无需单独授权');
      return res.status(error.status).json(error.toBody());
    }
    const incoming = Array.isArray(req.body.siteIds) ? req.body.siteIds : [];
    const valid = store.listSites().map((site) => site.id);
    const siteIds = incoming.filter((id) => valid.includes(String(id)));
    const result = store.setUserSites(user.id, siteIds);
    // 注意：站点归属变更**不**撤销会话。
    // 站点可见性是「每次请求实时查 site_members」判定的（见 allowedSiteIdsFor），
    // 授权变更下一瞬间即生效，无需让用户重新登录。
    // 若在此处撤销会话，会打断正在值守的终端，属于行为变更。
    store.recordAudit({
      user: req.user,
      action: 'user.sites',
      targetType: 'user',
      targetId: user.id,
      detail: `授权站点 ${result.length} 个`,
      ip: clientIp(req),
    });
    res.json({ siteIds: result });
  });
}

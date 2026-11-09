import { apiNotFound } from '../http/not-found.mjs';
import crypto from 'node:crypto';

/**
 * 账号（User）接口：列表、创建、编辑、删除，以及站点授权（/api/users/:id/sites）。
 *
 * 采用 deps 注入模式：main() 作用域内创建的 store 与守卫，以及 index.mjs 中的
 * 模块级辅助函数，统一通过 deps 传入；node 内建 crypto 直接 import，避免与
 * index.mjs 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerUserRoutes(app, deps) {
  const {
    store,
    publicUser,
    passwordHash,
    validUsername,
    validatePassword,
    requireAuth,
    requireRole,
    normalizeText,
    clientIp,
  } = deps;

  app.get('/api/users', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({ users: store.listUsers().map(publicUser) });
  });

  app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
    const username = normalizeText(req.body.username, 32);
    const displayName = normalizeText(req.body.displayName, 32) || username;
    const role = ['admin', 'operator', 'viewer'].includes(req.body.role)
      ? req.body.role
      : 'viewer';
    if (!validUsername(username)) {
      return res.status(400).json({ error: '用户名需为 3-32 位字母、数字、点、横线或下划线' });
    }
    if (store.getUserByUsername(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    if (!validatePassword(req.body.password)) {
      return res.status(400).json({ error: '密码至少需要 8 位' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = store.createUser({
      id: crypto.randomUUID(),
      username,
      displayName,
      role,
      siteAdmin: role !== 'admin' && req.body.siteAdmin === true,
      salt,
      passwordHash: passwordHash(req.body.password, salt),
      disabled: false,
      tokenVersion: 0,
      createdAt: Date.now(),
    });
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

  app.patch('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (req.body.role !== undefined) {
      if (!['admin', 'operator', 'viewer'].includes(req.body.role)) {
        return res.status(400).json({ error: '角色无效' });
      }
      if (
        user.role === 'admin' &&
        req.body.role !== 'admin' &&
        store.countActiveAdmins() <= 1
      ) {
        return res.status(400).json({ error: '必须保留至少一个可用管理员' });
      }
    }
    if (req.body.disabled !== undefined) {
      if (user.id === req.user.id && req.body.disabled) {
        return res.status(400).json({ error: '不能停用当前登录账号' });
      }
      if (user.role === 'admin' && req.body.disabled && store.countActiveAdmins() <= 1) {
        return res.status(400).json({ error: '必须保留至少一个可用管理员' });
      }
    }
    const nextRole = req.body.role ?? user.role;
    if (req.body.siteAdmin === true && nextRole === 'admin') {
      return res.status(400).json({ error: '全局管理员无需设置为站点管理员' });
    }
    let newSalt;
    let newHash;
    if (req.body.password !== undefined) {
      if (!validatePassword(req.body.password)) {
        return res.status(400).json({ error: '密码至少需要 8 位' });
      }
      newSalt = crypto.randomBytes(16).toString('hex');
      newHash = passwordHash(req.body.password, newSalt);
    }
    const updated = store.updateUser(user.id, {
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

  app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (user.id === req.user.id) return res.status(400).json({ error: '不能删除当前账号' });
    if (user.role === 'admin' && store.countActiveAdmins() <= 1) {
      return res.status(400).json({ error: '必须保留至少一个管理员' });
    }
    store.deleteUser(user.id);
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

  app.get('/api/users/:id/sites', requireAuth, requireRole('admin'), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    res.json({ siteIds: store.siteMemberSiteIds(user.id), sites: store.listSites() });
  });

  app.put('/api/users/:id/sites', requireAuth, requireRole('admin'), (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return apiNotFound(res, '账号不存在');
    if (user.role === 'admin') {
      return res.status(400).json({ error: '管理员默认可见全部站点，无需单独授权' });
    }
    const incoming = Array.isArray(req.body.siteIds) ? req.body.siteIds : [];
    const valid = store.listSites().map((site) => site.id);
    const siteIds = incoming.filter((id) => valid.includes(String(id)));
    const result = store.setUserSites(user.id, siteIds);
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

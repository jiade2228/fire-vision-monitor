import { apiNotFound } from '../http/not-found.mjs';
import crypto from 'node:crypto';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';

/**
 * 站点（Site）接口：列表、创建、更名、删除。
 *
 * 采用 deps 注入模式：main() 作用域内创建的 store 与守卫，以及 index.mjs 中的
 * 模块级辅助函数，统一通过 deps 传入；node 内建 crypto 直接 import，避免与
 * index.mjs 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerSiteRoutes(app, deps) {
  const {
    requireManager,
    requireRole,
    store,
    allowedSiteIdsFor,
    requireAuth,
    requireCapability,
    canManageSite,
    normalizeText,
    clientIp,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  app.get('/api/sites', requireAuth, (req, res) => {
    const allSites = store.listSites();
    const allowed = allowedSiteIdsFor(req.user, store);
    // 非全局管理员只返回自己可见的站点，避免暴露其他租户的站点名称。
    const sites =
      allowed === null
        ? allSites
        : allSites.filter((site) => allowed.includes(site.id));
    const mine = allowed ?? allSites.map((site) => site.id);
    res.json({ sites, defaultSiteId: store.defaultSiteId, mySiteIds: mine });
  });

  app.post('/api/sites', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (req, res) => {
    const name = normalizeText(String(req.body.name ?? ''), 48);
    if (!name) return res.status(400).json({ error: '站点名称不能为空' });
    const code = normalizeText(String(req.body.code ?? name), 24) || name;
    const existing = store.listSites().find((site) => site.code === code);
    if (existing) return res.status(409).json({ error: '站点编码已存在' });
    let site;
    try {
      site = store.createSite({
        id: crypto.randomUUID(),
        name,
        code,
        createdAt: Date.now(),
      });
    } catch (error) {
      // 并发同编码建站：唯一索引兜底，避免把业务冲突报成 500。
      if (String(error?.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: '站点编码已存在' });
      }
      throw error;
    }
    store.recordAudit({
      user: req.user,
      action: 'site.create',
      targetType: 'site',
      targetId: site.id,
      detail: `${site.code} ${site.name}`,
      ip: clientIp(req),
    });
    res.status(201).json({ site });
  });

  app.patch('/api/sites/:id', requireAuth, capabilityGuard(CAPABILITIES.SITE_MANAGE), (req, res) => {
    const site = store.getSite(req.params.id);
    if (!site) return apiNotFound(res, '站点不存在');
    if (!canManageSite(req.user, site.id)) {
      return res.status(403).json({ error: '无权管理该站点' });
    }
    const name = normalizeText(String(req.body.name ?? ''), 48);
    if (!name) return res.status(400).json({ error: '站点名称不能为空' });
    const updated = store.updateSite(site.id, { name });
    store.recordAudit({
      user: req.user,
      action: 'site.update',
      targetType: 'site',
      targetId: site.id,
      detail: updated.name,
      ip: clientIp(req),
    });
    res.json({ site: updated });
  });

  app.delete('/api/sites/:id', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (req, res) => {
    try {
      const ok = store.deleteSite(req.params.id);
      if (!ok) return apiNotFound(res, '站点不存在');
      store.recordAudit({
        user: req.user,
        action: 'site.delete',
        targetType: 'site',
        targetId: req.params.id,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      if (error?.code === 'SITE_DEFAULT') {
        return res.status(400).json({ error: error.message });
      }
      if (error?.code === 'SITE_HAS_CAMERAS') {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
  });
}

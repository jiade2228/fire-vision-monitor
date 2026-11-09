import path from 'node:path';

/**
 * 管理类只读/运维接口：审计日志、运行指标、数据库备份。
 *
 * 通过 deps 注入 main() 作用域内的服务、鉴权中间件与模块级辅助函数，
 * 避免与 index.mjs 形成循环依赖；仅 node 内建模块在此直接 import。
 *
 * @typedef {import('express').Express} Express
 */

/**
 * 注册管理类路由。
 * @param {Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 *   store 数据库访问层；streamManager 推流管理器（health/activeCount/maxStreams）；
 *   metrics 运行指标计数器；startedAt 进程启动时间戳；
 *   requireAuth 登录鉴权中间件；requireRole 角色鉴权中间件。
 */
export function registerAdminRoutes(app, deps) {
  const {
    store,
    streamManager,
    metrics,
    startedAt,
    requireAuth,
    requireRole,
    normalizeText,
    mapAudit,
    clientIp,
  } = deps;

  app.get('/api/audit', requireAuth, requireRole('admin'), (req, res) => {
    const filter = {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      action: normalizeText(String(req.query.action ?? ''), 32),
      q: normalizeText(String(req.query.q ?? ''), 64),
      from: Number(req.query.from) || null,
      to: Number(req.query.to) || null,
    };
    res.json({
      logs: store.listAuditFiltered(filter).map(mapAudit),
      total: store.countAuditFiltered(filter),
    });
  });

  app.get('/api/metrics', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({
      ...metrics,
      ...store.stats(),
      streams: streamManager.health(),
      activeStreams: streamManager.activeCount(),
      maxConcurrentStreams: streamManager.maxStreams,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  app.post('/api/admin/backup', requireAuth, requireRole('admin'), async (req, res) => {
    const file = await store.backup();
    store.recordAudit({
      user: req.user,
      action: 'system.backup',
      targetType: 'system',
      detail: path.basename(file),
      ip: clientIp(req),
    });
    res.json({ file: path.basename(file) });
  });
}

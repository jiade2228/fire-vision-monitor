import path from 'node:path';
import { AUDIT_KEYWORD_WINDOW_DAYS } from '../store/methods/audit.mjs';
import { ffmpegBudget } from '../ffmpeg-budget.mjs';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';

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
    requireManager,
    requireRole,
    store,
    streamManager,
    metrics,
    startedAt,
    requireAuth,
    requireCapability,
    normalizeText,
    mapAudit,
    clientIp,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  app.get('/api/audit', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (req, res) => {
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
      // PERF-2：关键词搜索走不到索引，已自动收敛到默认时间窗。
      // 明确告诉前端「结果可能不完整」，避免用户误判为记录缺失。
      ...(store.auditSearchWindowed(filter)
        ? { searchWindowed: true, searchWindowDays: AUDIT_KEYWORD_WINDOW_DAYS }
        : {}),
    });
  });

  app.get('/api/metrics', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (_req, res) => {
    res.json({
      ...metrics,
      ...store.stats(),
      streams: streamManager.health(),
      activeStreams: streamManager.activeCount(),
      maxConcurrentStreams: streamManager.maxStreams,
      // RES-1：FFmpeg 进程预算的实时水位。waiting 长期大于 0 说明点位太多、
      // 预算不够，需要调高 FFMPEG_MAX_PROCESSES 或减少并发点位。
      ffmpeg: ffmpegBudget.stats(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  app.post('/api/admin/backup', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), async (req, res) => {
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

import crypto from 'node:crypto';

/**
 * 通知相关接口：通知渠道（增删改查/测试）、推送日志、文案模板。
 *
 * 采用 deps 注入模式：main() 作用域内创建的服务（store/notifier）与守卫，以及
 * index.mjs 中的模块级辅助函数，统一通过 deps 传入，避免与 index.mjs 形成循环依赖。
 * 行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 *   store 数据库访问层；notifier 通知引擎（含 testChannel）。
 */
export function registerNotifyRoutes(app, deps) {
  const {
    store,
    notifier,
    requireAuth,
    requireManager,
    adminSiteIdsFor,
    canManageSite,
    normalizeText,
    clientIp,
    notifyChannelForClient,
    parseNotifyChannelInput,
  } = deps;

  app.get('/api/notify/channels', requireAuth, requireManager, (_req, res) => {
    const adminIds = adminSiteIdsFor(_req.user);
    const sites =
      adminIds === null
        ? store.listSites()
        : store.listSites().filter((site) => adminIds.includes(site.id));
    const nameById = new Map(sites.map((site) => [site.id, site.name]));
    res.json({
      channels: store
        .listNotifyChannels()
        .filter(
          (channel) =>
            adminIds === null ||
            (channel.siteId && adminIds.includes(channel.siteId)),
        )
        .map((channel) =>
          notifyChannelForClient(
            channel,
            channel.siteId ? nameById.get(channel.siteId) ?? null : null,
          ),
        ),
      sites,
    });
  });

  app.post('/api/notify/channels', requireAuth, requireManager, (req, res) => {
    const parsed = parseNotifyChannelInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const siteId = parsed.value.siteId ?? null;
    if (adminSiteIdsFor(req.user) !== null) {
      if (!siteId) {
        return res.status(400).json({ error: '站点管理员必须为渠道指定站点' });
      }
      if (!canManageSite(req.user, siteId)) {
        return res.status(403).json({ error: '无权管理该站点' });
      }
    }
    if (siteId && !store.getSite(siteId)) {
      return res.status(400).json({ error: '指定的站点不存在' });
    }
    const channel = store.createNotifyChannel({
      id: crypto.randomUUID(),
      ...parsed.value,
    });
    store.recordAudit({
      user: req.user,
      action: 'notify.create',
      targetType: 'notify',
      targetId: channel.id,
      detail: `${channel.kind} ${channel.name}`,
      ip: clientIp(req),
    });
    res.status(201).json({
      channel: notifyChannelForClient(
        channel,
        channel.siteId ? store.getSite(channel.siteId)?.name ?? null : null,
      ),
    });
  });

  app.patch(
    '/api/notify/channels/:id',
    requireAuth,
    requireManager,
    (req, res) => {
      const current = store.getNotifyChannel(req.params.id);
      if (!current) return res.status(404).json({ error: '通知渠道不存在' });
      if (!canManageSite(req.user, current.siteId)) {
        return res.status(403).json({ error: '无权管理该通知渠道' });
      }
      const parsed = parseNotifyChannelInput(req.body, { partial: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (
        parsed.value.siteId !== undefined &&
        parsed.value.siteId &&
        !store.getSite(parsed.value.siteId)
      ) {
        return res.status(400).json({ error: '指定的站点不存在' });
      }
      if (
        parsed.value.siteId !== undefined &&
        !canManageSite(req.user, parsed.value.siteId)
      ) {
        return res.status(403).json({ error: '无权管理目标站点' });
      }
      const channel = store.updateNotifyChannel(current.id, parsed.value);
      store.recordAudit({
        user: req.user,
        action: 'notify.update',
        targetType: 'notify',
        targetId: channel.id,
        detail: channel.name,
        ip: clientIp(req),
      });
      res.json({
        channel: notifyChannelForClient(
          channel,
          channel.siteId ? store.getSite(channel.siteId)?.name ?? null : null,
        ),
      });
    },
  );

  app.delete(
    '/api/notify/channels/:id',
    requireAuth,
    requireManager,
    (req, res) => {
      const current = store.getNotifyChannel(req.params.id);
      if (!current) return res.status(404).json({ error: '通知渠道不存在' });
      if (!canManageSite(req.user, current.siteId)) {
        return res.status(403).json({ error: '无权管理该通知渠道' });
      }
      const ok = store.deleteNotifyChannel(req.params.id);
      if (!ok) return res.status(404).json({ error: '通知渠道不存在' });
      store.recordAudit({
        user: req.user,
        action: 'notify.delete',
        targetType: 'notify',
        targetId: req.params.id,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    },
  );

  app.post(
    '/api/notify/channels/:id/test',
    requireAuth,
    requireManager,
    async (req, res) => {
      const channel = store.getNotifyChannel(req.params.id);
      if (!channel) return res.status(404).json({ error: '通知渠道不存在' });
      if (!canManageSite(req.user, channel.siteId)) {
        return res.status(403).json({ error: '无权管理该通知渠道' });
      }
      try {
        await notifier.testChannel(channel);
        res.json({ ok: true });
      } catch (error) {
        res.status(502).json({ error: `测试发送失败：${error.message}` });
      }
    },
  );

  app.get('/api/notify/logs', requireAuth, requireManager, (req, res) => {
    const logs = store.listNotificationLogs(req.query.limit);
    const adminIds = adminSiteIdsFor(req.user);
    if (adminIds === null) {
      return res.json({ logs });
    }
    // 站点管理员只能看到自己站点渠道的推送记录。
    const allowed = new Set(
      store
        .listNotifyChannels()
        .filter((channel) => channel.siteId && adminIds.includes(channel.siteId))
        .map((channel) => channel.id),
    );
    res.json({ logs: logs.filter((log) => allowed.has(log.channelId)) });
  });

  // 通知文案模板：可复用的告警消息模板，渠道引用后覆盖默认文案。
  app.get('/api/notify/templates', requireAuth, requireManager, (_req, res) => {
    res.json({ templates: store.listNotificationTemplates() });
  });

  app.post('/api/notify/templates', requireAuth, requireManager, (req, res) => {
    const name = normalizeText(String(req.body.name ?? ''), 32);
    const body = typeof req.body.body === 'string' ? req.body.body : '';
    if (!name) return res.status(400).json({ error: '请填写模板名称' });
    if (!body.trim()) return res.status(400).json({ error: '请填写模板内容' });
    if (body.length > 2000) {
      return res.status(400).json({ error: '模板内容过长（上限 2000 字）' });
    }
    const template = store.createNotificationTemplate({ name, body });
    store.recordAudit({
      user: req.user,
      action: 'notify.template.create',
      targetType: 'notify',
      targetId: template.id,
      detail: template.name,
      ip: clientIp(req),
    });
    res.status(201).json({ template });
  });

  app.patch(
    '/api/notify/templates/:id',
    requireAuth,
    requireManager,
    (req, res) => {
      const current = store.getNotificationTemplate(req.params.id);
      if (!current) return res.status(404).json({ error: '模板不存在' });
      const name =
        req.body.name !== undefined
          ? normalizeText(String(req.body.name ?? ''), 32)
          : undefined;
      const body = typeof req.body.body === 'string' ? req.body.body : undefined;
      if (name !== undefined && !name) {
        return res.status(400).json({ error: '请填写模板名称' });
      }
      if (body !== undefined && !body.trim()) {
        return res.status(400).json({ error: '请填写模板内容' });
      }
      if (body !== undefined && body.length > 2000) {
        return res.status(400).json({ error: '模板内容过长（上限 2000 字）' });
      }
      const template = store.updateNotificationTemplate(req.params.id, {
        name,
        body,
      });
      res.json({ template });
    },
  );

  app.delete(
    '/api/notify/templates/:id',
    requireAuth,
    requireManager,
    (req, res) => {
      const current = store.getNotificationTemplate(req.params.id);
      if (!current) return res.status(404).json({ error: '模板不存在' });
      const ok = store.deleteNotificationTemplate(req.params.id);
      if (!ok) return res.status(404).json({ error: '模板不存在' });
      store.recordAudit({
        user: req.user,
        action: 'notify.template.delete',
        targetType: 'notify',
        targetId: req.params.id,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    },
  );
}

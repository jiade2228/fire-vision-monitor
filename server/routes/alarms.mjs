import { apiNotFound } from '../http/not-found.mjs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 告警相关接口：列表、趋势统计、事件流、抓图/短视频回放、创建与状态流转。
 *
 * 采用 deps 注入模式：main() 作用域内创建的服务与守卫，以及 index.mjs 中的
 * 模块级辅助函数，统一通过 deps 传入；node 内建直接 import，避免与 index.mjs
 * 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerAlarmRoutes(app, deps) {
  const {
    store,
    metrics,
    broadcastEvent,
    notifier,
    canAccessAlarmSite,
    canAccessCameraSite,
    mapAlarmEvent,
    parseSnapshot,
    snapshotDir,
    recordingsDir,
    allowedSiteIdsFor,
    requireAuth,
    requireRole,
    normalizeText,
    clientIp,
  } = deps;

  // 统计接口的天数钳制：fallback 与下界按各接口原值传入，上界恒为 90。
  const clampDays = (value, fallback, min) =>
    Math.min(Math.max(Number(value) || fallback, min), 90);

  app.get('/api/alarms', requireAuth, (req, res) => {
    const alarms = store.listAlarms(req.query.limit, {
      allowedSiteIds: allowedSiteIdsFor(req.user, store),
    });
    res.json({ alarms });
  });

  // 误报热点：近 N 天按点位聚合的误报计数（站点隔离），供「误报治理」调优提示。
  app.get('/api/alarms/false-hotspots', requireAuth, (req, res) => {
    const days = clampDays(req.query.days, 7, 1);
    const allowed = allowedSiteIdsFor(req.user, store);
    const hotspots = store
      .listFalseAlarmCounts({ days, siteIds: allowed === null ? null : allowed })
      .map((row) => ({ ...row, count: Number(row.count) }));
    res.json({ days, hotspots });
  });

  // 趋势统计：按上海时区按天聚合，站点管理员只能看自己的站点。
  app.get('/api/alarms/stats', requireAuth, (req, res) => {
    const days = clampDays(req.query.days, 30, 7);
    const allowed = allowedSiteIdsFor(req.user, store);
    const rows = store.alarmStatsByDay({
      days,
      siteIds: allowed === null ? null : allowed,
    });
    const pad2 = (value) => String(value).padStart(2, '0');
    const emptyDay = (date) => ({
      date,
      fire: 0,
      smoke: 0,
      offline: 0,
      total: 0,
      false: 0,
      confirmed: 0,
      pending: 0,
      archived: 0,
    });
    const byDay = new Map();
    const totals = emptyDay('total');
    const siteMap = new Map();
    for (const row of rows) {
      let bucket = byDay.get(row.day);
      if (!bucket) {
        bucket = emptyDay(row.day);
        byDay.set(row.day, bucket);
      }
      bucket[row.level] = (bucket[row.level] ?? 0) + row.count;
      bucket[row.status] = (bucket[row.status] ?? 0) + row.count;
      bucket.total += row.count;
      totals[row.level] = (totals[row.level] ?? 0) + row.count;
      totals[row.status] = (totals[row.status] ?? 0) + row.count;
      totals.total += row.count;

      let siteBucket = siteMap.get(row.siteId);
      if (!siteBucket) {
        siteBucket = {
          siteId: row.siteId,
          total: 0,
          fire: 0,
          smoke: 0,
          offline: 0,
          false: 0,
        };
        siteMap.set(row.siteId, siteBucket);
      }
      siteBucket.total += row.count;
      siteBucket[row.level] = (siteBucket[row.level] ?? 0) + row.count;
      if (row.status === 'false') siteBucket.false += row.count;
    }
    const shanghaiToday = new Date(Date.now() + 8 * 3600 * 1000);
    const lastDayUtc = Date.UTC(
      shanghaiToday.getUTCFullYear(),
      shanghaiToday.getUTCMonth(),
      shanghaiToday.getUTCDate(),
    );
    const daysOut = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(lastDayUtc - offset * 86_400_000);
      const key = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
      daysOut.push(byDay.get(key) ?? emptyDay(key));
    }
    const flammable = totals.fire + totals.smoke;
    const falseRate =
      flammable > 0 ? Math.round((totals.false / flammable) * 1000) / 10 : 0;
    const bySite = [...siteMap.values()]
      .map((item) => ({
        ...item,
        name: store.getSite(item.siteId)?.name ?? '未归属站点',
      }))
      .sort((a, b) => b.total - a.total);
    res.json({ days: daysOut, totals, falseRate, bySite });
  });

  app.get('/api/alarms/:id/events', requireAuth, (req, res) => {
    const alarm = store.getAlarm(req.params.id);
    // 越权站点统一按"不存在"处理，避免通过 403 探测其他站点的告警 ID。
    if (!alarm || !canAccessAlarmSite(req.user, alarm, store)) {
      return apiNotFound(res, '告警不存在');
    }
    res.json({ events: store.listAlarmEvents(alarm.id).map(mapAlarmEvent) });
  });

  // 抓图与短视频共用同一套「越权按不存在处理 + 文件名白名单 + 私有缓存」逻辑。
  const serveAlarmMedia = (req, res, { fileFor, pattern, dir }) => {
    const alarm = store.getAlarm(req.params.id);
    const source = fileFor(alarm);
    if (!source || !canAccessAlarmSite(req.user, alarm, store)) {
      return res.status(404).end();
    }
    const safeName = path.basename(source);
    if (!pattern.test(safeName)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.join(dir, safeName), (error) => {
      if (!error) return;
      if (res.headersSent) {
        // 传输中途读失败/文件被清理时终止连接，避免响应悬挂到客户端超时。
        res.destroy();
        return;
      }
      // 文件缺失时禁止把 404 缓存 1 小时，否则稍后生成的短视频无法重试。
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).end();
    });
  };

  app.get('/api/alarms/:id/snapshot', requireAuth, (req, res) =>
    serveAlarmMedia(req, res, {
      fileFor: (alarm) => alarm?.snapshotFile,
      pattern: /^[a-f0-9-]+\.jpg$/i,
      dir: snapshotDir,
    }),
  );

  app.get('/api/alarms/:id/clip', requireAuth, (req, res) =>
    serveAlarmMedia(req, res, {
      fileFor: (alarm) => alarm?.clipFile,
      pattern: /^[a-f0-9-]+\.mp4$/i,
      dir: recordingsDir,
    }),
  );

  app.post(
    '/api/alarms',
    requireAuth,
    requireRole('operator', 'admin'),
    async (req, res) => {
      const camera = store.getCamera(String(req.body.cameraId ?? ''));
      if (!camera) return apiNotFound(res, '点位不存在');
      if (!canAccessCameraSite(req.user, camera, store)) {
        return res.status(403).json({ error: '无权操作该站点的点位' });
      }
      const existing = store.activeAlarmForCamera(camera.id);
      if (existing) return res.status(200).json({ alarm: existing, duplicate: true });

      const level =
        req.body.level === 'fire' ? 'fire' : req.body.level === 'smoke' ? 'smoke' : '';
      if (!level) return res.status(400).json({ error: '告警类型无效' });
      const confidence = Math.min(Math.max(Number(req.body.confidence) || 0, 0), 100);
      const hotspotX = Math.min(Math.max(Number(req.body.hotspot?.x) || 0, 0), 100);
      const hotspotY = Math.min(Math.max(Number(req.body.hotspot?.y) || 0, 0), 100);

      const id = crypto.randomUUID();
      let snapshotBuffer;
      try {
        snapshotBuffer = parseSnapshot(req.body.snapshot);
      } catch (error) {
        return res.status(error.status ?? 400).json({ error: error.message });
      }
      let snapshotFile = null;
      if (snapshotBuffer) {
        snapshotFile = `${id}.jpg`;
        await fsp.writeFile(path.join(snapshotDir, snapshotFile), snapshotBuffer, {
          mode: 0o600,
        });
      }
      try {
        const alarm = store.createAlarm({
          id,
          cameraId: camera.id,
          cameraName: camera.name,
          zone: camera.zone,
          siteId: camera.siteId || store.defaultSiteId,
          level,
          confidence,
          hotspot: { x: hotspotX, y: hotspotY },
          snapshotFile,
          actor: req.user,
        });
        metrics.alarmsCreated += 1;
        store.recordAudit({
          user: req.user,
          action: 'alarm.create',
          targetType: 'alarm',
          targetId: alarm.id,
          detail: `${camera.code} ${level}`,
          ip: clientIp(req),
        });
        broadcastEvent('alarm.created', { alarm }, alarm.siteId);
        void notifier
          ?.notifyAlarm(alarm, 'created', { camera })
          .catch(() => undefined);
        res.status(201).json({ alarm });
      } catch (error) {
        if (snapshotFile) {
          await fsp.rm(path.join(snapshotDir, snapshotFile), { force: true });
        }
        if (String(error?.message).includes('UNIQUE constraint failed')) {
          const active = store.activeAlarmForCamera(camera.id);
          if (active) return res.status(200).json({ alarm: active, duplicate: true });
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/alarms/:id',
    requireAuth,
    requireRole('operator', 'admin'),
    (req, res) => {
      const alarm = store.getAlarm(req.params.id);
      if (!alarm) return apiNotFound(res, '告警不存在');
      if (!canAccessAlarmSite(req.user, alarm, store)) {
        // 与 events / snapshot / clip 一致：跨站按「不存在」处理，避免用 403 探测告警 ID。
        return apiNotFound(res, '告警不存在');
      }
      const changes = {};
      const events = [];
      if (req.body.status !== undefined) {
        const transitions = {
          pending: ['confirmed', 'false'],
          confirmed: ['archived'],
          false: ['archived'],
          archived: [],
        };
        if (!transitions[alarm.status]?.includes(req.body.status)) {
          return res.status(409).json({ error: '当前告警状态不允许此操作' });
        }
        changes.status = req.body.status;
        const timestamp = Date.now();
        if (req.body.status === 'confirmed') changes.confirmedAt = timestamp;
        if (req.body.status === 'false') changes.falseAt = timestamp;
        if (req.body.status === 'archived') changes.archivedAt = timestamp;
        events.push({ action: req.body.status, detail: `状态更新为 ${req.body.status}` });
      }
      if (req.body.note !== undefined) {
        const note = normalizeText(req.body.note, 300);
        if (note !== alarm.note) {
          changes.note = note;
          events.push({ action: 'note', detail: note.slice(0, 300) });
        }
      }
      if (req.body.steps !== undefined) {
        if (
          !Array.isArray(req.body.steps) ||
          req.body.steps.length > 16 ||
          !req.body.steps.every((step) => typeof step === 'boolean')
        ) {
          return res.status(400).json({ error: '处置步骤格式无效' });
        }
        if ((req.body.status ?? alarm.status) !== 'confirmed') {
          return res.status(409).json({ error: '只有已确认告警可以更新处置步骤' });
        }
        changes.steps = req.body.steps;
        events.push({
          action: 'steps',
          detail: `${req.body.steps.filter(Boolean).length} 项已完成`,
        });
      }
      if (!events.length) return res.json({ alarm });
      const updated = store.transaction(() => {
        const next = store.updateAlarm(alarm.id, changes, req.user);
        for (const event of events) {
          store.addAlarmEvent(alarm.id, req.user, event.action, event.detail);
        }
        store.recordAudit({
          user: req.user,
          action: 'alarm.update',
          targetType: 'alarm',
          targetId: alarm.id,
          detail: events.map((event) => event.action).join(','),
          ip: clientIp(req),
        });
        return next;
      });
      broadcastEvent('alarm.updated', { alarm: updated }, updated.siteId);
      if (changes.status === 'confirmed' || changes.status === 'false') {
        void notifier
          ?.notifyAlarm(updated, changes.status, { actorName: req.user?.displayName })
          .catch(() => undefined);
      }
      res.json({ alarm: updated });
    },
  );
}

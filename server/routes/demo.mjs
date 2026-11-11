import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DemoSourceError } from '../demo-source.mjs';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';

/**
 * 演示模式、系统/检测/边缘网关状态接口。
 *
 * 采用 deps 注入模式：main() 作用域内创建的服务（demoSource/detectionEngine/
 * streamManager/edgeHub 等）与守卫、模块级辅助，统一通过 deps 传入；node 内建与
 * 第一方 DemoSourceError 直接 import，避免与 index.mjs 循环依赖。行为与原内联
 * 路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerDemoRoutes(app, deps) {
  const {
    requireManager,
    requireRole,
    store,
    demoSource,
    demoPurgeFilter,
    rememberDemoCameraId,
    computeMediaUsage,
    recordingStatus = null,
    syncDetection,
    streamManager,
    detectionEngine,
    edgeHub,
    ffprobeOk,
    mediaMaxBytes,
    edgeGatewayToken,
    snapshotDir,
    recordingsDir,
    databaseFile,
    DEMO_CAMERA_CODE,
    DEMO_CAMERA_NAME,
    DEMO_CAMERA_ZONE,
    normalizeText,
    clientIp,
    log,
    requireAuth,
    requireCapability,
    adminSiteIdsFor = () => null,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  function findDemoCamera() {
    return store.listCameras().find((camera) => camera.code === DEMO_CAMERA_CODE) ?? null;
  }

  // 演示模式：用 FFmpeg 合成一段火焰直播流并自动注册「演示点位」，
  // 无需任何真实摄像头即可验证播放、识别、告警、抓拍与推送闭环。
  app.get('/api/demo/status', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (_req, res) => {
    const camera = findDemoCamera();
    res.json({
      ...demoSource.status(),
      purgeable: store.countDemoAlarms(demoPurgeFilter()),
      camera: camera
        ? { id: camera.id, code: camera.code, name: camera.name, streamUrl: camera.sourceUrl }
        : null,
    });
  });

  app.post('/api/demo/start', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), async (req, res) => {
    try {
      const state = await demoSource.start();
      const sourceUrl = state.playlistUrl;
      const siteId =
        normalizeText(String(req.body?.siteId ?? ''), 64) || store.defaultSiteId;
      const existing = findDemoCamera();
      let camera = existing;
      if (existing) {
        camera = store.updateCamera(existing.id, {
          name: DEMO_CAMERA_NAME,
          zone: DEMO_CAMERA_ZONE,
          protocol: 'hls',
          sourceUrl,
          siteId,
          enabled: true,
          detectEnabled: true,
          updatedAt: Date.now(),
        });
      } else {
        camera = store.createCamera({
          id: crypto.randomUUID(),
          code: DEMO_CAMERA_CODE,
          name: DEMO_CAMERA_NAME,
          zone: DEMO_CAMERA_ZONE,
          protocol: 'hls',
          sourceUrl,
          siteId,
          enabled: true,
          detectEnabled: true,
          detectSensitivity: 'standard',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      syncDetection();
      rememberDemoCameraId(camera.id);
      store.recordAudit({
        user: req.user,
        action: 'demo.start',
        targetType: 'camera',
        targetId: camera.id,
        detail: `${camera.code} 演示视频源已启动`,
        ip: clientIp(req),
      });
      res.json({
        ...demoSource.status(),
        purgeable: store.countDemoAlarms(demoPurgeFilter()),
        camera: {
          id: camera.id,
          code: camera.code,
          name: camera.name,
          streamUrl: camera.sourceUrl,
        },
      });
    } catch (error) {
      const demoError =
        error instanceof DemoSourceError
          ? error
          : new DemoSourceError(
              error instanceof Error ? error.message : '演示视频源启动失败',
            );
      res.status(demoError.status).json({ error: demoError.message });
    }
  });

  app.post('/api/demo/stop', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (req, res) => {
    demoSource.stop();
    const existing = findDemoCamera();
    let removed = false;
    if (existing) {
      store.deleteCamera(existing.id);
      streamManager.stop(existing.id);
      detectionEngine.stop(existing.id);
      removed = true;
    }
    syncDetection();
    if (removed) {
      store.recordAudit({
        user: req.user,
        action: 'demo.stop',
        targetType: 'camera',
        targetId: existing.id,
        detail: `${existing.code} 演示视频源已停止`,
        ip: clientIp(req),
      });
    }
    res.json({ ...demoSource.status(), camera: null, removed });
  });

  // 一键清除演示数据：删演示告警及其事件、推送日志与媒体文件。
  // 审计日志保留（操作留痕）；真实告警与点位不受影响。演示运行中也可安全执行。
  app.post('/api/demo/purge', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), async (req, res) => {
    const filter = demoPurgeFilter();
    const before = store.countDemoAlarms(filter);
    if (!before.alarms) {
      return res.json({ removed: 0, purgeable: before });
    }
    const result = store.purgeDemoAlarms(filter);
    const removeMedia = async (files, dir) => {
      let removed = 0;
      for (const file of files) {
        try {
          await fsp.rm(path.join(dir, path.basename(file)), { force: true });
          removed += 1;
        } catch {
          // 文件缺失不阻断
        }
      }
      return removed;
    };
    const filesRemoved =
      (await removeMedia(result.snapshots, snapshotDir)) +
      (await removeMedia(result.clips, recordingsDir));
    store.recordAudit({
      user: req.user,
      action: 'demo.purge',
      targetType: 'system',
      detail: `清除演示告警 ${result.deleted} 条、媒体 ${filesRemoved} 个、事件 ${result.events} 条、推送日志 ${result.notifications} 条`,
      ip: clientIp(req),
    });
    log('info', 'demo_purged', {
      alarms: result.deleted,
      files: filesRemoved,
      events: result.events,
      notifications: result.notifications,
    });
    res.json({
      removed: result.deleted,
      filesRemoved,
      events: result.events,
      notifications: result.notifications,
      purgeable: store.countDemoAlarms(filter),
    });
  });

  app.get('/api/system', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), async (req, res) => {
    const usage = await computeMediaUsage();
    const dbStat = await fsp.stat(databaseFile).catch(() => null);
    // 纵深防御：检测状态里含摄像头错误详情，按调用者可管理的站点过滤。
    // 当前只有全局管理员能到达（adminSiteIdsFor 对全局管理员返回 null = 不过滤），
    // 但一旦将来放开给站点管理员，过滤已就位。
    const allowedSiteIds = adminSiteIdsFor(req.user);
    res.json({
      ffmpegAvailable: streamManager.ffmpegAvailable,
      ffprobeAvailable: ffprobeOk,
      nodeVersion: process.version,
      maxConcurrentStreams: streamManager.maxStreams,
      activeStreams: streamManager.activeCount(),
      database: 'sqlite',
      schemaVersion: store.schemaVersion,
      detection: detectionEngine.status({ allowedSiteIds }),
      // 持续录像独立配额与采集状态；continuous 取索引用量，不与短视频水位混算。
      recording: recordingStatus ? recordingStatus() : null,
      storage: {
        dbBytes: dbStat?.size ?? 0,
        snapshots: usage.snapshots,
        recordings: usage.recordings,
        continuous: usage.continuous ?? { files: 0, bytes: 0, protectedFiles: 0 },
        // 备份目录此前完全不在视野内：14 份全库快照随库体积线性放大，
        // 磁盘写满时 SQLite 写入失败 = 告警记不下来。现在显式统计并给出总量。
        backups: usage.backups ?? { files: 0, bytes: 0 },
        streams: usage.streams ?? { files: 0, bytes: 0 },
        dataBytes:
          (usage.snapshots?.bytes ?? 0) +
          (usage.recordings?.bytes ?? 0) +
          (usage.continuous?.bytes ?? 0) +
          (usage.backups?.bytes ?? 0),
        mediaBytes: usage.snapshots.bytes + usage.recordings.bytes,
        mediaMaxBytes,
      },
    });
  });

  app.get('/api/detection/status', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (req, res) => {
    res.json(detectionEngine.status({ allowedSiteIds: adminSiteIdsFor(req.user) }));
  });

  app.get('/api/edge/status', requireAuth, capabilityGuard(CAPABILITIES.GLOBAL_ADMIN), (_req, res) => {
    res.json({
      enabled: edgeHub.enabled,
      gateways: edgeHub.status(),
      // 配对令牌用于在边缘网关上配置接入，管理员需要看到完整值；
      // 额外给一个脱敏提示，便于运维在日志/工单中核对而不必打印明文。
      pairingToken: edgeGatewayToken,
      pairingTokenHint: edgeGatewayToken
        ? `****${String(edgeGatewayToken).slice(-4)}`
        : '',
    });
  });
}

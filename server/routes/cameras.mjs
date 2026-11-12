import { apiNotFound } from '../http/not-found.mjs';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { VENDORS_BY_ID, buildVendorUrl } from '../vendors.mjs';
import { ffprobeAvailable, probeStream } from '../probe.mjs';
import { discoverDevices } from '../onvif.mjs';
import { discoverOnvifDevices } from '../onvif-discovery.mjs';
import { blockedOutboundHost } from '../net-guard.mjs';

/**
 * 点位（摄像头）与设备发现相关接口：点位增删改查、批量操作、测流/预览、
 * 品牌/ONVIF 设备导入，以及运行流健康度。
 *
 * 采用 deps 注入模式：main() 作用域内创建的服务与守卫，以及 index.mjs 中的
 * 模块级辅助函数，统一通过 deps 传入；第一方叶子模块与 node 内建直接 import，
 * 避免与 index.mjs 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerCameraRoutes(app, deps) {
  const {
    requireManager,
    requireRole,
    store,
    streamManager,
    edgeHub,
    ffprobeOk,
    syncDetection,
    detectionEngine,
    dataDir,
    previewDir,
    log,
    validateCameraInput,
    capturePreview,
    requireAuth,
    requireCapability,
    canManageCamera,
    canManageSite,
    allowedSiteIdsFor,
    fallbackSiteIdFor,
    normalizeText,
    clientIp,
    cameraForClient,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  // 点位站点 ID 与批量 ids 的公共解析：保持原有短路求值与兜底语义。
  const siteIdInput = (req) => normalizeText(String(req.body.siteId ?? ''), 64);
  const parseCameraIds = (body) =>
    Array.isArray(body.ids)
      ? body.ids.slice(0, 200).filter((id) => typeof id === 'string' && id)
      : [];

  // 站点归属校验（存在性 → 管理权限）的公共骨架：失败返回 { status, error }
  // 交由调用点按原状态码/文案发送，成功返回 null；denyMessage 逐处传入以保留
  // 「无权管理该站点」与「无权管理目标站点」两种原文案及原有校验顺序。
  const siteGuard = (req, siteId, denyMessage) => {
    if (!store.getSite(siteId)) {
      return { status: 400, error: '指定的站点不存在' };
    }
    if (!canManageSite(req.user, siteId)) {
      return { status: 403, error: denyMessage };
    }
    return null;
  };

  app.get('/api/cameras', requireAuth, (req, res) => {
    const allowed = allowedSiteIdsFor(req.user, store);
    const siteId = normalizeText(req.query.siteId, 64) || null;
    const cameras = store
      .listCameras({ allowedSiteIds: allowed, siteId })
      .map((camera) => cameraForClient(camera, req.user));
    res.json({ cameras });
  });

  app.get('/api/streams/health', requireAuth, (req, res) => {
    const runtime = new Map(
      streamManager.health().map((item) => [item.cameraId, item]),
    );
    const allowed = allowedSiteIdsFor(req.user, store);
    const cameras = store.listCameras({ allowedSiteIds: allowed }).map((camera) => {
      const state = runtime.get(camera.id);
      let status = 'external';
      let lastError = state?.error ?? null;
      if (!camera.enabled) status = 'disabled';
      else if (!camera.sourceUrl) status = 'unconfigured';
      else if (camera.protocol === 'rtsp') {
        if (state?.starting) status = 'starting';
        else if (state?.running) status = 'running';
        else if (state?.error) status = 'error';
        else status = 'idle';
      } else if (camera.protocol === 'edge') {
        const edge = edgeHub.cameraState(camera.sourceUrl);
        status = edge.connected ? 'gateway' : 'error';
        lastError = edge.error ?? null;
      }
      return {
        cameraId: camera.id,
        code: camera.code,
        name: camera.name,
        protocol: camera.protocol,
        enabled: camera.enabled,
        hasSource: Boolean(camera.sourceUrl),
        status,
        attempts: state?.attempts ?? 0,
        lastAccess: state?.lastAccess ?? null,
        lastError,
      };
    });
    res.json({ cameras, probeAvailable: ffprobeOk });
  });

  app.post(
    '/api/cameras/:id/test',
    requireAuth,
    capabilityGuard(CAPABILITIES.CAMERA_MANAGE),
    async (req, res) => {
      const camera = store.getCamera(req.params.id);
      if (!camera) return apiNotFound(res, '点位不存在');
      if (!canManageCamera(req.user, camera)) {
        return res.status(403).json({ error: '无权管理该站点的点位' });
      }
      if (!camera.sourceUrl || camera.protocol === 'none') {
        return res.status(400).json({ error: '该点位尚未配置视频流' });
      }
      let result;
      if (camera.protocol === 'edge') {
        const startedAt = Date.now();
        try {
          const body = await edgeHub.request(camera.sourceUrl, 'index.m3u8');
          result = body.toString('utf8').includes('#EXTINF')
            ? {
                ok: true,
                latencyMs: Date.now() - startedAt,
                codec: 'HLS',
                format: 'edge-gateway',
              }
            : {
                ok: false,
                latencyMs: Date.now() - startedAt,
                error: '边缘网关未返回有效 HLS 播放列表',
              };
        } catch (error) {
          result = {
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : '边缘网关测流失败',
          };
        }
      } else {
        if (!ffprobeOk) {
          return res.status(503).json({ error: '服务器未安装 FFprobe，无法测流' });
        }
        result = await probeStream({
          sourceUrl: camera.sourceUrl,
          protocol: camera.protocol,
        });
      }
      store.recordAudit({
        user: req.user,
        action: 'camera.test',
        targetType: 'camera',
        targetId: camera.id,
        detail: result.ok
          ? `测试成功 ${result.codec ?? ''} ${result.width ?? ''}x${result.height ?? ''}`
          : `测试失败 ${String(result.error ?? '').slice(0, 120)}`,
        ip: clientIp(req),
      });
      res.json(result);
    },
  );

  // 抓取一帧作为 ROI 编辑底图；60 秒内复用缓存，?refresh=1 强制刷新。
  app.get(
    '/api/cameras/:id/preview',
    requireAuth,
    capabilityGuard(CAPABILITIES.CAMERA_MANAGE),
    async (req, res) => {
      const camera = store.getCamera(req.params.id);
      if (!camera || !camera.sourceUrl || camera.protocol === 'none') {
        return apiNotFound(res, '该点位没有可预览的视频源');
      }
      if (!canManageCamera(req.user, camera)) {
        return res.status(403).json({ error: '无权管理该站点的点位' });
      }
      if (camera.protocol === 'edge') {
        return res.status(400).json({ error: '边缘网关点位暂不支持预览抓图' });
      }
      const name = `${camera.id.replace(/[^a-zA-Z0-9-]/g, '')}.jpg`;
      const target = path.join(previewDir, name);
      try {
        await fsp.mkdir(previewDir, { recursive: true, mode: 0o700 });
        const stat =
          req.query.refresh === '1'
            ? null
            : await fsp.stat(target).catch(() => null);
        if (!stat || Date.now() - stat.mtimeMs > 60_000) {
          const ok = await capturePreview(camera, target);
          if (!ok) {
            return res
              .status(502)
              .json({ error: '抓取预览失败，请检查视频源是否可访问' });
          }
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(target, (error) => {
          if (!error) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.status(404).end();
        });
      } catch (error) {
        // 不回显内部错误原文（可能含绝对路径、ffmpeg 命令行等内部细节）。
        log('warn', 'camera_preview_failed', {
          cameraId: camera.id,
          message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: '抓取预览失败，请检查视频源与服务器环境' });
      }
    },
  );

  /**
   * FFmpeg 依赖预检（D 系列反馈：感知滞后）。
   *
   * RTSP 转码播放、服务端识别、持续录像、告警短视频都依赖 FFmpeg。
   * 缺失时**不阻断**创建/更新（FFmpeg 可能随后安装，healthz 与
   * StreamManager.init 都会在下次启动重新探测），但必须在响应里
   * 明确警告，避免用户建完点位、点开播放才看到 503。
   *
   * @param {string} protocol 点位协议。
   * @param {boolean} enabled 是否启用。
   * @returns {string[]} 警告列表（无警告为空数组）。
   */
  const ffmpegWarningsFor = (protocol, enabled) => {
    if (protocol !== 'rtsp' || !enabled || streamManager.ffmpegAvailable) {
      return [];
    }
    return [
      '服务器未检测到 FFmpeg：该 RTSP 点位的转码播放暂不可用，服务端识别、持续录像、告警短视频同样受影响。' +
        '安装 FFmpeg 并加入 PATH（或在 config/fire-vision.env 中设置 FFMPEG_PATH）后重启服务即可恢复；' +
        'HLS/HTTP 点位不受影响。',
    ];
  };

  app.post('/api/cameras', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), (req, res) => {
    const parsed = validateCameraInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const siteId =
      siteIdInput(req) || fallbackSiteIdFor(req.user);
    const guard = siteGuard(req, siteId, '无权管理该站点');
    if (guard) return res.status(guard.status).json({ error: guard.error });
    try {
      const camera = store.createCamera({
        id: crypto.randomUUID(),
        name: parsed.value.name,
        zone: parsed.value.zone,
        protocol: parsed.value.protocol,
        sourceUrl: parsed.value.sourceUrl,
        siteId,
        enabled: parsed.value.enabled,
        detectEnabled: parsed.value.detectEnabled,
        detectSensitivity: parsed.value.detectSensitivity,
        detectRoi: parsed.value.detectRoi,
        schedule: parsed.value.schedule,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      store.recordAudit({
        user: req.user,
        action: 'camera.create',
        targetType: 'camera',
        targetId: camera.id,
        detail: `${camera.code} ${camera.name} (${camera.protocol})`,
        ip: clientIp(req),
      });
      syncDetection();
      res
        .status(201)
        .json({ camera: cameraForClient(camera, req.user), warnings: ffmpegWarningsFor(camera.protocol, camera.enabled) });
    } catch (error) {
      if (error?.code === 'DUPLICATE_SOURCE') {
        return res.status(409).json({ error: error.message });
      }
      if (String(error?.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: '点位编码或视频流地址已存在' });
      }
      throw error;
    }
  });

  app.patch('/api/cameras/:id', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), (req, res) => {
    const camera = store.getCamera(req.params.id);
    if (!camera) return apiNotFound(res, '点位不存在');
    if (!canManageCamera(req.user, camera)) {
      return res.status(403).json({ error: '无权管理该站点的点位' });
    }
    const merged = {
      name: req.body.name ?? camera.name,
      zone: req.body.zone ?? camera.zone,
      protocol: req.body.protocol ?? camera.protocol,
      sourceUrl: req.body.sourceUrl ?? camera.sourceUrl,
      enabled: req.body.enabled ?? camera.enabled,
      // 未显式下发检测字段时沿用当前值，避免普通编辑把检测配置重置。
      detectEnabled:
        req.body.detectEnabled !== undefined
          ? req.body.detectEnabled
          : camera.detectEnabled,
      detectSensitivity:
        req.body.detectSensitivity !== undefined
          ? req.body.detectSensitivity
          : camera.detectSensitivity,
      detectRoi:
        req.body.detectRoi !== undefined ? req.body.detectRoi : camera.detectRoi,
      // 未显式下发时沿用当前布防配置（解析形态），避免普通编辑把时间表清空。
      schedule:
        req.body.schedule !== undefined ? req.body.schedule : camera.schedule,
    };
    if (req.body.siteId !== undefined) {
      const siteId = siteIdInput(req);
      if (!siteId) {
        return res.status(400).json({ error: '站点 ID 不能为空' });
      }
      const guard = siteGuard(req, siteId, '无权管理目标站点');
      if (guard) return res.status(guard.status).json({ error: guard.error });
      merged.siteId = siteId;
    }
    const parsed = validateCameraInput(merged);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (
      camera.protocol === 'rtsp' &&
      (parsed.value.protocol !== 'rtsp' ||
        parsed.value.sourceUrl !== camera.sourceUrl ||
        !parsed.value.enabled)
    ) {
      streamManager.stop(camera.id);
    }
    try {
      // validateCameraInput 只校验基础字段，站点归属需在此显式合并，否则改站点会被丢弃。
      const updated = store.updateCamera(camera.id, {
        ...parsed.value,
        ...(merged.siteId !== undefined ? { siteId: merged.siteId } : {}),
      });
      store.recordAudit({
        user: req.user,
        action: 'camera.update',
        targetType: 'camera',
        targetId: camera.id,
        detail: `${camera.code} ${updated.name} (${updated.protocol})`,
        ip: clientIp(req),
      });
      syncDetection();
      res.json({
        camera: cameraForClient(updated, req.user),
        warnings: ffmpegWarningsFor(updated.protocol, updated.enabled),
      });
    } catch (error) {
      if (error?.code === 'DUPLICATE_SOURCE') {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  app.delete('/api/cameras/:id', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), async (req, res) => {
    const camera = store.getCamera(req.params.id);
    if (!camera) return apiNotFound(res, '点位不存在');
    if (!canManageCamera(req.user, camera)) {
      return res.status(403).json({ error: '无权管理该站点的点位' });
    }
    // 有未处置告警时拒绝直接删除：会让告警变成无法复核的孤儿记录。
    // 与删除站点（有摄像头则拒绝）保持同一防护思路。
    const openAlarms = store.countOpenAlarmsByCamera?.(camera.id) ?? 0;
    if (openAlarms > 0) {
      return res.status(409).json({
        error: `该点位还有 ${openAlarms} 条未处置告警，请先确认或标记误报后再删除`,
      });
    }
    streamManager.stop(camera.id);
    detectionEngine?.stop(camera.id);
    // 清索引必须早于删目录：反过来的话对账会把「文件已消失」误判为孤儿清理，
    // 丢掉本应由这里精确控制的删除记录。
    const removedSegments = store.deleteRecordingSegmentsByCamera?.(camera.id) ?? {
      files: [],
      deleted: 0,
    };
    store.deleteCamera(camera.id);
    syncDetection();
    store.recordAudit({
      user: req.user,
      action: 'camera.delete',
      targetType: 'camera',
      targetId: camera.id,
      detail: `${camera.code} ${camera.name}${removedSegments.deleted ? `（清理录像索引 ${removedSegments.deleted} 段）` : ''}`,
      ip: clientIp(req),
    });
    // 清理该点位的所有派生文件：流、录像段、回放/导出临时产物、抓拍。
    // 旧实现只删 streams/，continuous/ 会留到按天保留策略（默认 14 天）才淘汰。
    for (const dir of [
      path.join(dataDir, 'streams', camera.id),
      path.join(dataDir, 'continuous', camera.id),
      path.join(dataDir, 'continuous-play', camera.id),
      path.join(dataDir, 'continuous-export', camera.id),
    ]) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    // D-03：历史告警按设计保留（处置留痕），但它们引用的抓拍与短视频
    // 会成为无人引用的孤儿文件 —— 既占磁盘，又无法被「媒体水位淘汰」回收
    // （水位策略按告警状态清理，不会处理已删点位的残留）。
    const media = store.listAlarmMediaByCamera?.(camera.id) ?? { snapshots: [], clips: [] };
    let cleanedMedia = 0;
    for (const [files, dir] of [
      [media.snapshots, path.join(dataDir, 'snapshots')],
      [media.clips, path.join(dataDir, 'recordings')],
    ]) {
      for (const file of files) {
        // 只取文件名再拼接，避免库内数据里的路径成分越出目录。
        try {
          await fsp.rm(path.join(dir, path.basename(file)), { force: true });
          cleanedMedia += 1;
        } catch {
          // 文件缺失或被占用不阻断删除点位
        }
      }
    }
    res.json({ ok: true, cleanedSegments: removedSegments.deleted, cleanedMedia });
  });

  // 点位批量操作：启停检测 / 灵敏度 / 站点迁移 / 删除，逐条鉴权并在同一响应汇总结果。
  app.post('/api/cameras/batch-update', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), (req, res) => {
    const ids = parseCameraIds(req.body);
    if (ids.length === 0) return res.status(400).json({ error: '请选择至少一个点位' });
    const patch = {};
    if (req.body.detectEnabled !== undefined) {
      patch.detectEnabled = req.body.detectEnabled === true;
    }
    if (req.body.detectSensitivity !== undefined) {
      const allowed = ['low', 'standard', 'high', null];
      if (!allowed.includes(req.body.detectSensitivity)) {
        return res.status(400).json({ error: '灵敏度取值无效' });
      }
      patch.detectSensitivity = req.body.detectSensitivity;
    }
    if (req.body.siteId !== undefined) {
      const siteId = siteIdInput(req);
      if (!siteId) return res.status(400).json({ error: '站点 ID 不能为空' });
      const guard = siteGuard(req, siteId, '无权管理目标站点');
      if (guard) return res.status(guard.status).json({ error: guard.error });
      patch.siteId = siteId;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '没有可应用的批量修改项' });
    }
    const updated = [];
    const errors = [];
    for (const id of ids) {
      const camera = store.getCamera(id);
      if (!camera) {
        errors.push({ id, error: '点位不存在' });
        continue;
      }
      if (!canManageCamera(req.user, camera)) {
        errors.push({ id, error: '无权管理该站点点位' });
        continue;
      }
      try {
        updated.push(cameraForClient(store.updateCamera(id, patch), req.user));
      } catch (error) {
        errors.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    store.recordAudit({
      user: req.user,
      action: 'camera.batch_update',
      targetType: 'camera',
      targetId: ids.join(','),
      detail: `批量更新 ${updated.length}/${ids.length} 个点位：${Object.keys(patch).join(',')}`,
      ip: clientIp(req),
    });
    syncDetection();
    res.json({ updated: updated.length, errors, cameras: updated });
  });

  app.post(
    '/api/cameras/batch-delete',
    requireAuth,
    capabilityGuard(CAPABILITIES.CAMERA_MANAGE),
    async (req, res) => {
      const ids = parseCameraIds(req.body);
      if (ids.length === 0) return res.status(400).json({ error: '请选择至少一个点位' });
      const deleted = [];
      const errors = [];
      for (const id of ids) {
        const camera = store.getCamera(id);
        if (!camera) {
          errors.push({ id, error: '点位不存在' });
          continue;
        }
        if (!canManageCamera(req.user, camera)) {
          errors.push({ id, error: '无权管理该站点点位' });
          continue;
        }
        try {
          streamManager.stop(camera.id);
          detectionEngine?.stop(camera.id);
          store.deleteCamera(camera.id);
          await fsp
            .rm(path.join(dataDir, 'streams', camera.id), { recursive: true, force: true })
            .catch(() => undefined);
          deleted.push(camera.id);
        } catch (error) {
          errors.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      store.recordAudit({
        user: req.user,
        action: 'camera.batch_delete',
        targetType: 'camera',
        targetId: deleted.join(','),
        detail: `批量删除 ${deleted.length}/${ids.length} 个点位`,
        ip: clientIp(req),
      });
      syncDetection();
      res.json({ deleted: deleted.length, errors });
    },
  );

  async function importBrandCameras(req, res, forcedVendorId = '') {
    const vendorId =
      forcedVendorId ||
      (typeof req.body.vendorId === 'string' ? req.body.vendorId.trim() : '');
    const vendor = VENDORS_BY_ID.get(vendorId);
    if (!vendor) return res.status(400).json({ error: '不支持的设备品牌' });

    const host = typeof req.body.host === 'string' ? req.body.host.trim() : '';
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const zone = normalizeText(req.body.zone, 32);
    const namePrefix = normalizeText(req.body.namePrefix, 24) || vendor.name.slice(0, 16);
    const rtspPort = Number(req.body.rtspPort ?? vendor.defaultPort);
    const singleChannel = Boolean(vendor.singleChannel);
    const startChannel = singleChannel ? 1 : Number(req.body.startChannel ?? 1);
    const count = singleChannel ? 1 : Number(req.body.count ?? 1);
    const stream =
      vendor.supportsSubstream === false
        ? 'main'
        : req.body.stream === 'main'
          ? 'main'
          : 'sub';

    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) {
      return res.status(400).json({ error: '请填写设备 IP 或域名，不要包含协议和路径' });
    }
    const siteId =
      siteIdInput(req) || fallbackSiteIdFor(req.user);
    const guard = siteGuard(req, siteId, '无权管理该站点');
    if (guard) return res.status(guard.status).json({ error: guard.error });
    if (!username) return res.status(400).json({ error: '请填写设备用户名' });
    if (!password) return res.status(400).json({ error: '请填写设备密码' });
    if (!zone) return res.status(400).json({ error: '请填写这些点位的所属区域' });
    if (!Number.isInteger(rtspPort) || rtspPort < 1 || rtspPort > 65535) {
      return res.status(400).json({ error: 'RTSP 端口无效' });
    }
    if (
      !Number.isInteger(startChannel) ||
      !Number.isInteger(count) ||
      startChannel < 1 ||
      count < 1 ||
      count > 64 ||
      startChannel + count - 1 > 256
    ) {
      return res.status(400).json({ error: '通道范围无效，单次最多导入 64 个通道' });
    }

    const items = [];
    for (let index = 0; index < count; index += 1) {
      const channel = startChannel + index;
      let sourceUrl;
      try {
        sourceUrl = buildVendorUrl(vendor, {
          username,
          password,
          host,
          port: rtspPort,
          channel,
          stream,
          template: req.body.template,
        });
      } catch (error) {
        return res.status(400).json({
          error: error instanceof Error ? error.message : '视频流地址生成失败',
        });
      }
      if (!/^rtsps?:\/\//i.test(sourceUrl) || sourceUrl.length > 2048) {
        return res.status(400).json({ error: '生成的 RTSP 地址无效或过长' });
      }
      items.push({
        name: singleChannel
          ? namePrefix.slice(0, 24)
          : `${namePrefix} ${String(channel).padStart(2, '0')}`.slice(0, 24),
        zone,
        protocol: 'rtsp',
        sourceUrl,
        siteId,
        enabled: true,
      });
    }

    const result = store.importCameras(items);
    syncDetection();
    store.recordAudit({
      user: req.user,
      action: 'camera.import',
      targetType: 'camera',
      detail: `${vendor.name} 创建 ${result.created.length} 个，跳过 ${result.skipped} 个重复地址`,
      ip: clientIp(req),
    });
    res.status(201).json({
      created: result.created.length,
      skipped: result.skipped,
      cameras: result.created.map((camera) => cameraForClient(camera, req.user)),
      stream,
      vendor: { id: vendor.id, name: vendor.name, singleChannel },
    });
  }

  // WS-Discovery 组播扫描：无需设备 IP 或凭据，先列出网段内的 ONVIF 设备。
  app.post('/api/onvif/scan', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), async (req, res) => {
    const startedAt = Date.now();
    const timeoutMs = Math.min(
      Math.max(Number(req.body.timeoutMs) || 4000, 1000),
      12_000,
    );
    try {
      const devices = await discoverOnvifDevices({ timeoutMs });
      res.json({ devices, durationMs: Date.now() - startedAt });
    } catch (error) {
      log('warn', 'onvif_scan_failed', { message: error.message });
      res.status(502).json({
        error: '网段扫描失败，请确认服务器已接入摄像头所在网络后重试',
      });
    }
  });

  // ONVIF 自动发现：给定设备 IP/列表 + 凭据，单播 SOAP 探测并取 Profile S 流地址。
  app.post('/api/onvif/discover', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), async (req, res) => {
    const rawHosts = Array.isArray(req.body.hosts)
      ? req.body.hosts.map((h) => String(h).trim()).filter(Boolean)
      : String(req.body.hosts ?? '')
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
    if (rawHosts.length === 0) {
      return res.status(400).json({ error: '请至少填写一个设备主机或 IP' });
    }
    if (rawHosts.length > 32) {
      return res.status(400).json({ error: '单次最多探测 32 台设备' });
    }
    const port = Number(req.body.port) || 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: '设备端口需为 1-65535 之间的整数' });
    }
    // 主机格式与出网地址校验：杜绝 userinfo/路径注入与云元数据探测。
    for (const host of rawHosts) {
      if (!/^[a-zA-Z0-9._:-]+$/.test(host)) {
        return res.status(400).json({ error: `设备主机格式无效：${host.slice(0, 40)}` });
      }
      const blocked = blockedOutboundHost(host, {
        allowPrivate: true,
        allowLoopback: true,
        allowLinkLocal: true,
      });
      if (blocked) {
        return res.status(400).json({ error: `设备主机被拒绝：${blocked}` });
      }
    }
    const username = normalizeText(req.body.username, 64) || '';
    const password = String(req.body.password ?? '');
    const targets = rawHosts.map((host) => ({ host, port, username, password }));
    const results = await discoverDevices(targets);
    const safe = results.map((item) => ({
      ok: item.ok,
      error: item.error,
      target: { host: item.target.host, port: item.target.port },
      device: item.device,
    }));
    res.json({ results: safe });
  });

  app.post('/api/onvif/import', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), async (req, res) => {
    const devices = Array.isArray(req.body.devices) ? req.body.devices : [];
    if (devices.length === 0) {
      return res.status(400).json({ error: '没有可导入的通道' });
    }
    // 数量上限：单次导入会逐条写库（每条一次事务 + fsync），
    // 不设上限时恶意/误操作的大数组会长时间独占写锁并冻结事件循环。
    if (devices.length > 64) {
      return res.status(400).json({ error: '单次最多导入 64 个通道' });
    }
    const fallbackSiteId =
      siteIdInput(req) || fallbackSiteIdFor(req.user);
    const guard = siteGuard(req, fallbackSiteId, '无权管理该站点');
    if (guard) return res.status(guard.status).json({ error: guard.error });
    // 先整体校验设备与站点，避免循环中途失败留下「部分导入 + 4xx」的不一致状态。
    const safeDevices = devices.filter(
      (device) => device && typeof device === 'object',
    );
    if (safeDevices.length === 0) {
      return res.status(400).json({ error: '没有可导入的通道' });
    }
    for (const device of safeDevices) {
      const deviceSiteId =
        normalizeText(String(device.siteId ?? ''), 64) || fallbackSiteId;
      const guard = siteGuard(req, deviceSiteId, '无权管理目标站点');
      if (guard) return res.status(guard.status).json({ error: guard.error });
    }
    // 通道（profile）总数上限：每个通道都会写一次库（事务 + fsync），
    // 不设上限时超大数组会长时间独占写锁并冻结事件循环。
    const totalChannels = safeDevices.reduce(
      (sum, device) =>
        sum + (Array.isArray(device?.profiles) ? device.profiles.length : 0),
      0,
    );
    if (totalChannels > 256) {
      return res.status(400).json({ error: '单次最多导入 256 个视频通道' });
    }
    const created = [];
    let skipped = 0;
    for (const device of safeDevices) {
      const label = normalizeText(device.label || device.host || '', 32);
      const zone = normalizeText(device.zone || device.host || '', 32) || 'ONVIF';
      // 前端按设备下发 siteId，缺省时回退到请求级站点，避免全部落到默认站点。
      const deviceSiteId =
        normalizeText(String(device.siteId ?? ''), 64) || fallbackSiteId;
      const profiles = Array.isArray(device.profiles) ? device.profiles : [];
      for (const profile of profiles) {
        const rtspUri = String(profile.rtspUri || '');
        if (!/^rtsps?:\/\//i.test(rtspUri)) {
          skipped += 1;
          continue;
        }
        const name =
          normalizeText(`${label || 'ONVIF'} ${profile.name || profile.token || ''}`.trim(), 24) ||
          'ONVIF 通道';
        const parsed = validateCameraInput({
          name,
          zone,
          protocol: 'rtsp',
          sourceUrl: rtspUri,
          enabled: true,
        });
        if (parsed.error) {
          skipped += 1;
          continue;
        }
        try {
          const camera = store.createCamera({
            id: crypto.randomUUID(),
            name: parsed.value.name,
            zone: parsed.value.zone,
            protocol: parsed.value.protocol,
            sourceUrl: parsed.value.sourceUrl,
            siteId: deviceSiteId,
            enabled: parsed.value.enabled,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          store.recordAudit({
            user: req.user,
            action: 'camera.create',
            targetType: 'camera',
            targetId: camera.id,
            detail: `${camera.code} ${camera.name} (onvif)`,
            ip: clientIp(req),
          });
          created.push(cameraForClient(camera, req.user));
        } catch (error) {
          if (error?.code === 'DUPLICATE_SOURCE') {
            skipped += 1;
          } else {
            throw error;
          }
        }
      }
    }
    syncDetection();
    res.status(201).json({ created, skipped });
  });

  app.post('/api/cameras/import-brand', requireAuth, capabilityGuard(CAPABILITIES.CAMERA_MANAGE), async (req, res) => {
    await importBrandCameras(req, res);
  });

  app.post(
    '/api/cameras/import-hikvision',
    requireAuth,
    capabilityGuard(CAPABILITIES.CAMERA_MANAGE),
    async (req, res) => {
      await importBrandCameras(req, res, 'hikvision');
    },
  );
}

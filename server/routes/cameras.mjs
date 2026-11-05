import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { VENDORS_BY_ID, buildVendorUrl } from '../vendors.mjs';
import { ffprobeAvailable, probeStream } from '../probe.mjs';
import { discoverDevices } from '../onvif.mjs';
import { discoverOnvifDevices } from '../onvif-discovery.mjs';

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
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.streamManager
 * @param {object} deps.edgeHub
 * @param {boolean} deps.ffprobeOk
 * @param {() => void} deps.syncDetection
 * @param {any} deps.detectionEngine
 * @param {string} deps.dataDir
 * @param {string} deps.previewDir
 * @param {Function} deps.log
 * @param {Function} deps.validateCameraInput
 * @param {Function} deps.capturePreview
 * @param {import('express').RequestHandler} deps.requireAuth
 * @param {import('express').RequestHandler} deps.requireManager
 * @param {(user: any, camera: any) => boolean} deps.canManageCamera
 * @param {(user: any, siteId?: string) => boolean} deps.canManageSite
 * @param {(user: any, store: object) => string[] | null} deps.allowedSiteIdsFor
 * @param {(user: any) => string} deps.fallbackSiteIdFor
 * @param {(value: any, maxLength?: number) => string} deps.normalizeText
 * @param {(req: import('express').Request) => string} deps.clientIp
 * @param {Function} deps.cameraForClient
 */
export function registerCameraRoutes(app, deps) {
  const {
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
    requireManager,
    canManageCamera,
    canManageSite,
    allowedSiteIdsFor,
    fallbackSiteIdFor,
    normalizeText,
    clientIp,
    cameraForClient,
  } = deps;

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
    requireManager,
    async (req, res) => {
      const camera = store.getCamera(req.params.id);
      if (!camera) return res.status(404).json({ error: '点位不存在' });
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
    requireManager,
    async (req, res) => {
      const camera = store.getCamera(req.params.id);
      if (!camera || !camera.sourceUrl || camera.protocol === 'none') {
        return res.status(404).json({ error: '该点位没有可预览的视频源' });
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
          if (error && !res.headersSent) res.status(404).end();
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post('/api/cameras', requireAuth, requireManager, (req, res) => {
    const parsed = validateCameraInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const siteId =
      normalizeText(String(req.body.siteId ?? ''), 64) || fallbackSiteIdFor(req.user);
    if (!store.getSite(siteId)) {
      return res.status(400).json({ error: '指定的站点不存在' });
    }
    if (!canManageSite(req.user, siteId)) {
      return res.status(403).json({ error: '无权管理该站点' });
    }
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
      res.status(201).json({ camera: cameraForClient(camera, req.user) });
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

  app.patch('/api/cameras/:id', requireAuth, requireManager, (req, res) => {
    const camera = store.getCamera(req.params.id);
    if (!camera) return res.status(404).json({ error: '点位不存在' });
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
      const siteId = normalizeText(String(req.body.siteId ?? ''), 64);
      if (!siteId) {
        return res.status(400).json({ error: '站点 ID 不能为空' });
      }
      if (!store.getSite(siteId)) {
        return res.status(400).json({ error: '指定的站点不存在' });
      }
      if (!canManageSite(req.user, siteId)) {
        return res.status(403).json({ error: '无权管理目标站点' });
      }
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
      res.json({ camera: cameraForClient(updated, req.user) });
    } catch (error) {
      if (error?.code === 'DUPLICATE_SOURCE') {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  app.delete('/api/cameras/:id', requireAuth, requireManager, async (req, res) => {
    const camera = store.getCamera(req.params.id);
    if (!camera) return res.status(404).json({ error: '点位不存在' });
    if (!canManageCamera(req.user, camera)) {
      return res.status(403).json({ error: '无权管理该站点的点位' });
    }
    streamManager.stop(camera.id);
    detectionEngine?.stop(camera.id);
    store.deleteCamera(camera.id);
    syncDetection();
    store.recordAudit({
      user: req.user,
      action: 'camera.delete',
      targetType: 'camera',
      targetId: camera.id,
      detail: `${camera.code} ${camera.name}`,
      ip: clientIp(req),
    });
    await fsp.rm(path.join(dataDir, 'streams', camera.id), {
      recursive: true,
      force: true,
    });
    res.json({ ok: true });
  });

  // 点位批量操作：启停检测 / 灵敏度 / 站点迁移 / 删除，逐条鉴权并在同一响应汇总结果。
  app.post('/api/cameras/batch-update', requireAuth, requireManager, (req, res) => {
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.slice(0, 200).filter((id) => typeof id === 'string' && id)
      : [];
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
      const siteId = normalizeText(String(req.body.siteId ?? ''), 64);
      if (!siteId) return res.status(400).json({ error: '站点 ID 不能为空' });
      if (!store.getSite(siteId)) {
        return res.status(400).json({ error: '指定的站点不存在' });
      }
      if (!canManageSite(req.user, siteId)) {
        return res.status(403).json({ error: '无权管理目标站点' });
      }
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
    requireManager,
    async (req, res) => {
      const ids = Array.isArray(req.body.ids)
        ? req.body.ids.slice(0, 200).filter((id) => typeof id === 'string' && id)
        : [];
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
      normalizeText(String(req.body.siteId ?? ''), 64) || fallbackSiteIdFor(req.user);
    if (!store.getSite(siteId)) {
      return res.status(400).json({ error: '指定的站点不存在' });
    }
    if (!canManageSite(req.user, siteId)) {
      return res.status(403).json({ error: '无权管理该站点' });
    }
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
  app.post('/api/onvif/scan', requireAuth, requireManager, async (req, res) => {
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
  app.post('/api/onvif/discover', requireAuth, requireManager, async (req, res) => {
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

  app.post('/api/onvif/import', requireAuth, requireManager, async (req, res) => {
    const devices = Array.isArray(req.body.devices) ? req.body.devices : [];
    if (devices.length === 0) {
      return res.status(400).json({ error: '没有可导入的通道' });
    }
    const fallbackSiteId =
      normalizeText(String(req.body.siteId ?? ''), 64) || fallbackSiteIdFor(req.user);
    if (!store.getSite(fallbackSiteId)) {
      return res.status(400).json({ error: '指定的站点不存在' });
    }
    if (!canManageSite(req.user, fallbackSiteId)) {
      return res.status(403).json({ error: '无权管理该站点' });
    }
    const created = [];
    let skipped = 0;
    for (const device of devices) {
      const label = normalizeText(device.label || device.host || '', 32);
      const zone = normalizeText(device.zone || device.host || '', 32) || 'ONVIF';
      // 前端按设备下发 siteId，缺省时回退到请求级站点，避免全部落到默认站点。
      const deviceSiteId =
        normalizeText(String(device.siteId ?? ''), 64) || fallbackSiteId;
      if (!store.getSite(deviceSiteId)) {
        return res.status(400).json({ error: '指定的站点不存在' });
      }
      if (!canManageSite(req.user, deviceSiteId)) {
        return res.status(403).json({ error: '无权管理目标站点' });
      }
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

  app.post('/api/cameras/import-brand', requireAuth, requireManager, async (req, res) => {
    await importBrandCameras(req, res);
  });

  app.post(
    '/api/cameras/import-hikvision',
    requireAuth,
    requireManager,
    async (req, res) => {
      await importBrandCameras(req, res, 'hikvision');
    },
  );
}

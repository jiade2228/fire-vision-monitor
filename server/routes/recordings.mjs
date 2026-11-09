import { apiNotFound } from '../http/not-found.mjs';
import fsp from 'node:fs/promises';
import {
  buildTimeline,
  dayRangeFromDate,
  reconcileRecordingSegments,
} from '../recording-index.mjs';
import {
  MAX_PLAYBACK_WINDOW_MS,
  parsePlaybackWindow,
  selectSegments,
} from '../recording-playback.mjs';

/**
 * 持续录像时间线 / 回放 / 导出接口（设计文档 §6）。
 *
 * 权限约定：所有接口先 requireAuth；跨站点一律 404 防探测；
 * 回放会话额外绑定 userId，读取分片时实时复核点位站点权限（撤权后立即失效）。
 *
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 *   continuousDir 录像段根目录；recordingEnabled 采集总闸状态；
 *   playbackManager 按需转码会话管理；exportRecording 导出函数；captureManager 采集状态。
 *   后几项可选（未接线时新接口返回 503，保证只挂索引路由的部署不受影响）。
 */
export function registerRecordingRoutes(app, deps) {
  const {
    store,
    continuousDir,
    recordingEnabled,
    canAccessCameraSite,
    requireAuth,
    requireRole,
    normalizeText,
    playbackManager = null,
    captureManager = null,
    exportRecording = null,
    exportDir = null,
    ffmpegAvailable = false,
    retentionDays = 14,
    recordingProbe = undefined,
    logger = null,
  } = deps;

  /** 点位 + 窗口公共校验；失败时直接发送响应并返回 null。 */
  const resolveRequest = (req, res, { maxWindowMs = MAX_PLAYBACK_WINDOW_MS } = {}) => {
    const cameraId = normalizeText(req.query.cameraId, 64);
    if (!cameraId) {
      res.status(400).json({ error: '缺少 cameraId' });
      return null;
    }
    // 按主键查询，避免全表加载点位并逐个解密 RTSP 凭据；不存在的 ID 返回 null。
    const camera = store.getCamera(cameraId);
    if (!camera) {
      apiNotFound(res, '点位不存在');
      return null;
    }
    // 跨站点一律 404，与现有媒体接口一致，避免泄露点位是否存在。
    if (!canAccessCameraSite(req.user, camera, store)) {
      apiNotFound(res, '点位不存在');
      return null;
    }
    const window = parsePlaybackWindow(req.query, { maxWindowMs });
    if (!window) {
      res.status(400).json({
        error: `from/to 无效或窗口超过 ${Math.round(maxWindowMs / 3600000)} 小时`,
      });
      return null;
    }
    // 可选起点（前端点击时间条换算）；非法值报错，越界值裁剪到窗口内。
    let startAt = null;
    if (req.query.startAt !== undefined) {
      const value = Number(req.query.startAt);
      if (!Number.isFinite(value)) {
        res.status(400).json({ error: 'startAt 无效' });
        return null;
      }
      startAt = Math.min(Math.max(value, window.from), window.to);
    }
    return { camera, cameraId, ...window, startAt };
  };

  const segmentsFor = (context) => {
    const rows = store.listRecordingSegments({
      cameraId: context.cameraId,
      from: context.from,
      to: context.to,
    });
    return {
      files: selectSegments(rows, context.from, context.to),
      // concat 输入的时间轴从第一段起点开始，seek 偏移量以此为基准。
      firstStartedAt: rows.reduce(
        (min, row) => Math.min(min, row.startedAt),
        Number.POSITIVE_INFINITY,
      ),
    };
  };

  app.get('/api/recordings/timeline', requireAuth, (req, res) => {
    const cameraId = normalizeText(req.query.cameraId, 64);
    if (!cameraId) return res.status(400).json({ error: '缺少 cameraId' });
    const camera = store.getCamera(cameraId);
    if (!camera) return apiNotFound(res, '点位不存在');
    if (!canAccessCameraSite(req.user, camera, store)) {
      return apiNotFound(res, '点位不存在');
    }

    let from;
    let to;
    if (req.query.date !== undefined) {
      const range = dayRangeFromDate(String(req.query.date));
      if (!range) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
      ({ from, to } = range);
    } else {
      from = Number(req.query.from);
      to = Number(req.query.to);
      const maxWindow = 48 * 60 * 60 * 1000;
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to <= from ||
        to - from > maxWindow
      ) {
        return res.status(400).json({ error: 'from/to 无效或窗口超过 48 小时' });
      }
    }

    const segments = store.listRecordingSegments({ cameraId, from, to });
    return res.json({
      cameraId,
      enabled: recordingEnabled,
      timeline: buildTimeline(segments, from, to),
    });
  });

  /** 采集状态：前端据此提示「未启用 / 运行中 N 路 / FFmpeg 不可用」。 */
  app.get('/api/recordings/status', requireAuth, (req, res) => {
    const state = captureManager?.status?.() ?? {};
    return res.json({
      enabled: Boolean(recordingEnabled),
      active: state.active ?? 0,
      total: state.total ?? 0,
      skipped: state.skipped ?? 0,
      ffmpegAvailable: Boolean(ffmpegAvailable || state.ffmpegAvailable),
      retentionDays: Number(retentionDays) || 14,
    });
  });

  /** 按需转码：选出覆盖窗口的段，启动一次 HLS 会话并返回 playlist 地址。 */
  app.get('/api/recordings/play', requireAuth, async (req, res) => {
    const context = resolveRequest(req, res);
    if (!context) return;
    if (!playbackManager) return res.status(503).json({ error: '回放服务未启用' });
    const { files, firstStartedAt } = segmentsFor(context);
    if (!files.length) return apiNotFound(res, '所选时段暂无录像段');
    try {
      const session = await playbackManager.create({
        userId: req.user?.id ?? '',
        cameraId: context.cameraId,
        siteId: context.camera.siteId ?? null,
        from: context.from,
        to: context.to,
        files,
        startAt: context.startAt,
        firstStartedAt,
      });
      if (!session) return res.status(503).json({ error: '回放服务暂不可用' });
      return res.json(session);
    } catch (error) {
      logger?.warn?.('recording_play_failed', { message: error?.message ?? String(error) });
      return res.status(503).json({ error: '回放服务暂不可用' });
    }
  });

  /** 会话转码状态：必须注册在 :sessionId/:file 之前，否则会被分片路由吞掉。 */
  app.get('/api/recordings/play/:sessionId/status', requireAuth, (req, res) => {
    if (!playbackManager) return res.status(404).end();
    const session = playbackManager.touch(req.params.sessionId);
    if (!session || session.userId !== (req.user?.id ?? '')) return res.status(404).end();
    const camera = store.getCamera(session.cameraId);
    if (!camera || !canAccessCameraSite(req.user, camera, store)) {
      return res.status(404).end();
    }
    return res.json(
      playbackManager.sessionStatus(session.id) ?? { state: 'failed', error: '会话已过期' },
    );
  });

  /** HLS 分片与播放列表；每次命中续期，并实时复核会话归属与站点权限。 */
  app.get('/api/recordings/play/:sessionId/:file', requireAuth, (req, res) => {
    if (!playbackManager) return res.status(404).end();
    const session = playbackManager.touch(req.params.sessionId);
    if (!session || session.userId !== (req.user?.id ?? '')) return res.status(404).end();
    const camera = store.getCamera(session.cameraId);
    if (!camera || !canAccessCameraSite(req.user, camera, store)) {
      return res.status(404).end();
    }
    const file = playbackManager.filePath(session, req.params.file);
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, no-store');
    if (String(req.params.file).endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    return res.sendFile(file, (error) => {
      if (!error) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).end();
    });
  });

  /** 导出：选中段 copy 拼接为单个 MP4 并下载，响应结束后清理临时文件。 */
  app.get('/api/recordings/export', requireAuth, async (req, res) => {
    const context = resolveRequest(req, res);
    if (!context) return;
    if (!exportRecording || !exportDir) {
      return res.status(503).json({ error: '导出服务未启用' });
    }
    const { files } = segmentsFor(context);
    if (!files.length) return apiNotFound(res, '所选时段暂无录像段');
    let target;
    try {
      target = await exportRecording({ files, continuousDir, exportDir });
    } catch (error) {
      logger?.warn?.('recording_export_failed', { message: error?.message ?? String(error) });
      target = null;
    }
    if (!target) return res.status(503).json({ error: '导出失败，请稍后重试' });
    const safeCode = String(context.camera.code || context.cameraId).replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    );
    const stamp = new Date(context.from).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return res.download(target, `recording-${safeCode}-${stamp}.mp4`, (error) => {
      void fsp.rm(target, { force: true }).catch(() => undefined);
      if (error && !res.headersSent) {
        logger?.warn?.('recording_export_send_failed', { message: error.message });
      }
    });
  });

  // 手动触发一次「文件系统 → 索引」对账，便于部署后校验与故障排查。
  app.post('/api/recordings/reconcile', requireAuth, requireRole('admin'), async (req, res) => {
    try {
      const result = await reconcileRecordingSegments(store, continuousDir, {
        probe: recordingProbe,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
}

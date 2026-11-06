import {
  buildTimeline,
  dayRangeFromDate,
  reconcileRecordingSegments,
} from '../recording-index.mjs';

/**
 * 持续录像时间线接口（设计文档 §6 的第一阶段）。
 *
 * 当前只提供「索引查询 + 手动对账」：采集 worker 与按需转码依赖真机联调，
 * 因此不暴露 play/export 接口，避免给出必然 404 的入口。
 *
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object} deps.store
 * @param {string} deps.continuousDir 录像段根目录
 * @param {boolean} deps.recordingEnabled 采集总闸状态
 * @param {(user: any, camera: any, store: object) => boolean} deps.canAccessCameraSite
 * @param {import('express').RequestHandler} deps.requireAuth
 * @param {(...roles: string[]) => import('express').RequestHandler} deps.requireRole
 * @param {(value: any, maxLength?: number) => string} deps.normalizeText
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
  } = deps;

  app.get('/api/recordings/timeline', requireAuth, (req, res) => {
    const cameraId = normalizeText(req.query.cameraId, 64);
    if (!cameraId) return res.status(400).json({ error: '缺少 cameraId' });
    // listCameras 而非 getCamera：后者对不存在的 ID 会走到行对象解析器。
    const camera = store.listCameras().find((item) => item.id === cameraId);
    if (!camera) return res.status(404).json({ error: '点位不存在' });
    // 跨站点一律 404，与现有媒体接口一致，避免泄露点位是否存在。
    if (!canAccessCameraSite(req.user, camera, store)) {
      return res.status(404).json({ error: '点位不存在' });
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

  // 手动触发一次「文件系统 → 索引」对账，便于部署后校验与故障排查。
  app.post('/api/recordings/reconcile', requireAuth, requireRole('admin'), async (req, res) => {
    try {
      const result = await reconcileRecordingSegments(store, continuousDir);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
}

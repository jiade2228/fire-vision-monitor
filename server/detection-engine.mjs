import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runFfmpegOnce } from './ffmpeg-once.mjs';
import { FlameDetector, buildRoiMask } from './detector.mjs';
import { analyzeFrameQuality } from './frame-quality.mjs';
import { isArmedNow } from './schedule.mjs';
import { sanitizeErrorText } from './sanitize.mjs';
import { ffmpegBudget } from './ffmpeg-budget.mjs';

/**
 * 服务端检测引擎（最小可行版）。
 *
 * 每个点位一个常驻 FFmpeg：按固定帧率抽帧、等比缩放到 160×90 的固定画布，
 * 以 rawvideo/RGBA 输出到 stdout；引擎按固定帧长切片后交给 FlameDetector。
 * 检测命中时写入告警（同一相机已有未处置告警时跳过），并通过 onAlarm 回调
 * 交给上层做审计与 SSE 推送。
 */

const SUPPORTED_PROTOCOLS = new Set(['rtsp', 'hls', 'http']);

/**
 * 从缓冲区中切出完整帧，返回帧列表与剩余不完整字节。
 *
 * @param {Buffer} buffer FFmpeg rawvideo/RGBA 输出流累积缓冲。
 * @param {number} frameBytes 单帧字节数（width × height × 4）。
 * @returns {{frames: Buffer[], rest: Buffer}} 完整帧列表与未成帧的剩余字节。
 */
export function extractFrames(buffer, frameBytes) {
  if (!frameBytes || frameBytes <= 0) return { frames: [], rest: buffer };
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= frameBytes) {
    frames.push(buffer.subarray(offset, offset + frameBytes));
    offset += frameBytes;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * 单点位常驻抽帧工作进程（内部类）：一个点位一个 FFmpeg 子进程，
 * 负责拉流抽帧、断流自动重启与帧回调；生命周期由 DetectionEngine 管理。
 */
class CameraWorker {
  constructor(engine, camera) {
    this.engine = engine;
    this.camera = camera;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.stopping = false;
    this.restartTimer = null;
    this.backoffMs = 1_000;
    this.frames = 0;
    this.startedAt = Date.now();
    this.lastFrameAt = 0;
    this.lastError = null;
    // RES-1：FFmpeg 进程预算名额。start() 需先排队拿到名额才能拉起子进程。
    this.budgetToken = null;
    this.starting = false;
    void this.start();
  }

  get frameBytes() {
    return this.engine.width * this.engine.height * 4;
  }

  buildArgs() {
    const { width, height, fps, keyframesOnly } = this.engine;
    const filter =
      `fps=${fps},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    const args = ['-v', 'error', '-nostdin'];
    // 只解关键帧可把 CPU 降一个数量级，适合几十路以上的部署；默认关闭。
    if (keyframesOnly) args.push('-skip_frame', 'nokey');
    if (this.camera.protocol === 'rtsp') {
      args.push('-rtsp_transport', 'tcp');
    }
    args.push(
      '-i',
      this.engine.sourceFor(this.camera),
      '-an',
      '-vf',
      filter,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    );
    return args;
  }

  start() {
    if (this.stopping || this.starting || this.child) return;
    // RES-1：先申请 FFmpeg 进程预算。预算不足时排队等待，
    // 超时则退避重试 —— 避免几十路点位同时把 FFmpeg 拉满把机器打挂。
    //
    // 快路径必须保持同步：构造函数里同步拉起 FFmpeg，
    // 若改成异步会在启动瞬间产生「没有子进程也没有帧」的空窗，
    // 既影响首帧延迟，也会打乱调用方对 worker.child 的同步预期。
    const token = this.engine.budget.tryAcquire({
      label: `detect:${this.camera.code}`,
    });
    if (token) {
      this.budgetToken = token;
      this.spawnChild();
      return;
    }
    this.starting = true;
    void this.engine.budget
      .acquire({ label: `detect:${this.camera.code}` })
      .then((queued) => {
        this.starting = false;
        if (this.stopping) {
          this.engine.budget.release(queued);
          return;
        }
        this.budgetToken = queued;
        this.spawnChild();
      })
      .catch((error) => {
        this.starting = false;
        this.scheduleRestart(error.message);
      });
  }

  /** 真正拉起 FFmpeg 子进程（预算名额已就位）。 */
  spawnChild() {
    if (this.stopping) return;
    let child;
    try {
      child = this.engine.spawnImpl(this.engine.ffmpegPath, this.buildArgs(), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.engine.budget.release(this.budgetToken);
      this.budgetToken = null;
      this.scheduleRestart(`FFmpeg 启动失败：${error.message}`);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk) => this.onData(chunk));
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      // FFmpeg 会把输入 URL 原样打进 stderr（含 rtsp://user:pass@host），
      // 这里必须先抹除 userinfo 再落库，否则 lastError 经状态接口回传前端会泄露摄像头密码。
      if (text) this.lastError = sanitizeErrorText(text, 400);
    });
    child.on('error', (error) => this.onExit(`FFmpeg 错误：${error.message}`));
    child.on('exit', (code) => this.onExit(`FFmpeg 退出（code=${code}）`));
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const { frames, rest } = extractFrames(this.buffer, this.frameBytes);
    // 保留剩余不完整字节；上面的 concat 已复制，避免长期持有大块内存。
    this.buffer = rest.length ? Buffer.from(rest) : Buffer.alloc(0);
    for (const frame of frames) {
      this.frames += 1;
      this.engine.stats.frames += 1;
      this.lastFrameAt = Date.now();
      this.backoffMs = 1_000;
      this.lastError = null;
      // 帧交给检测器前先复制：Buffer 切片与 stdin 缓冲区共享内存。
      const owned = Buffer.from(frame);
      void this.engine.handleFrame(this.camera, owned).catch((error) => {
        this.engine.logger?.warn?.(
          `[detection] ${this.camera.code} 检测失败：${error.message}`,
        );
      });
    }
  }

  onExit(reason) {
    this.child = null;
    this.buffer = Buffer.alloc(0);
    // RES-1：进程退出即归还预算名额，否则名额会被永久占用直到重启。
    if (this.budgetToken) {
      this.engine.budget.release(this.budgetToken);
      this.budgetToken = null;
    }
    if (reason) this.lastError = sanitizeErrorText(reason, 400);
    if (this.stopping) return;
    this.scheduleRestart(reason);
  }

  scheduleRestart(reason) {
    if (this.stopping || this.restartTimer) return;
    if (reason) this.lastError = sanitizeErrorText(reason, 400);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // ignore
    }
    this.child = null;
    this.buffer = Buffer.alloc(0);
    // 若此时还在排队等预算，等候结束后 start() 会因 stopping 直接归还名额。
    if (this.budgetToken) {
      this.engine.budget.release(this.budgetToken);
      this.budgetToken = null;
    }
  }
}

/**
 * @typedef {object} DetectionEngineOptions
 * @property {import('./store.mjs').Store} store 数据存储（读点位配置、写告警）。
 * @property {string|null} [snapshotDir] 抓拍输出目录（null 表示不抓拍）。
 * @property {string|null} [recordingsDir] 短视频输出目录（null 表示不补录）。
 * @property {((alarm: object) => void)|null} [onAlarm] 告警命中回调（上层做审计与 SSE 推送）。
 * @property {((alarm: object, file: string) => void)|null} [onClip] 短视频就绪回调。
 * @property {((camera: object, event: object) => void)|null} [onQualityEvent]
 *   画面质量事件回调：{ kind: 'abnormal'|'recovered', reason, durationMs? }。
 * @property {boolean} [qualityCheck] 是否启用画面异常检测（遮挡/过暗/过曝，默认开）。
 * @property {string} [ffmpegPath] FFmpeg 可执行文件路径（默认取 FFMPEG_PATH 或 'ffmpeg'）。
 * @property {boolean} [enabled] 是否启用服务端识别。
 * @property {number} [width] 检测画布宽（32-640，默认 160）。
 * @property {number} [height] 检测画布高（32-640，默认 90）。
 * @property {number} [fps] 抽帧帧率（0.2-10，默认 1）。
 * @property {string} [sensitivity] 全局默认灵敏度（low/standard/high）。
 * @property {number} [cooldownMs] 同点位告警冷却毫秒数（默认 12000）。
 * @property {number} [snapshotTimeoutMs] 抓拍超时毫秒数（默认 5000）。
 * @property {number} [clipSeconds] 补录时长秒（2-60，默认 10）。
 * @property {number} [clipTimeoutMs] 补录超时毫秒数（默认 25000）。
 * @property {number} [maxCameras] 最大并发检测点位数（1-256，默认 24）。
 * @property {boolean} [keyframesOnly] 是否只按关键帧抽帧。
 * @property {((url: string, camera: object) => string)|null} [resolveSourceUrl] 相对源地址解析器（演示流用）。
 * @property {Console} [logger] 日志对象。
 * @property {typeof import('node:child_process').spawn} [spawnImpl] 进程拉起函数（测试注入用）。
 */

/**
 * 服务端识别引擎（对外公共接口）：点位对齐、帧处理、告警生成、
 * 抓拍/补录与状态查询。内部通过 CameraWorker 管理每点位的 FFmpeg 进程。
 */
// 画面异常去抖窗口：异常持续 45s 才告警，连续正常 10s 才恢复。
const QUALITY_CONFIRM_MS = 45_000;
const QUALITY_RECOVER_MS = 10_000;

export class DetectionEngine {
  /**
   * @param {DetectionEngineOptions} [options]
   */
  constructor({
    store,
    snapshotDir = null,
    recordingsDir = null,
    onAlarm = null,
    onClip = null,
    // RES-2：抓拍异步补齐完成后的回调（用于广播告警更新）。
    onSnapshot = null,
    onQualityEvent = null,
    qualityCheck = process.env.CAMERA_QUALITY_CHECK !== '0',
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    enabled = true,
    width = Number(process.env.DETECTION_WIDTH) || 160,
    height = Number(process.env.DETECTION_HEIGHT) || 90,
    fps = Number(process.env.DETECTION_FPS) || 1,
    sensitivity = process.env.DETECTION_SENSITIVITY || 'standard',
    cooldownMs = Number(process.env.DETECTION_COOLDOWN_MS) || 12_000,
    snapshotTimeoutMs = 5_000,
    clipSeconds = Number(process.env.ALARM_CLIP_SECONDS) || 10,
    clipTimeoutMs = 25_000,
    maxCameras = Number(process.env.MAX_DETECTION_CAMERAS) || 24,
    keyframesOnly = process.env.DETECTION_KEYFRAMES_ONLY === '1',
    // 相对地址（如本地演示流 /demo/<token>/index.m3u8）交给上层解析成 FFmpeg 可访问的绝对地址。
    resolveSourceUrl = null,
    logger = console,
    spawnImpl = spawn,
    // 可选共享帧源（SharedSourceHub）：启用后同一点位不再额外拉一路 FFmpeg。
    frameSource = null,
    // RES-1：全局 FFmpeg 进程预算（可注入，便于测试与多实例隔离）。
    budget = ffmpegBudget,
  } = {}) {
    this.store = store;
    this.snapshotDir = snapshotDir;
    this.recordingsDir = recordingsDir;
    this.onAlarm = onAlarm;
    this.onClip = onClip;
    this.onSnapshot = onSnapshot;
    this.onQualityEvent = onQualityEvent;
    this.qualityCheck = qualityCheck;
    this.qualityStates = new Map();
    this.ffmpegPath = ffmpegPath;
    this.enabled = enabled;
    this.clipSeconds = Math.min(Math.max(Number(clipSeconds) || 10, 2), 60);
    this.clipTimeoutMs = clipTimeoutMs;
    this.maxCameras = Math.min(Math.max(Number(maxCameras) || 24, 1), 256);
    this.keyframesOnly = keyframesOnly;
    this.resolveSourceUrl = resolveSourceUrl;
    this.width = Math.min(Math.max(Math.round(width), 32), 640);
    this.height = Math.min(Math.max(Math.round(height), 32), 640);
    this.fps = Math.min(Math.max(Number(fps) || 1, 0.2), 10);
    this.sensitivity = sensitivity;
    this.cooldownMs = cooldownMs;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.ffmpegOk = true;
    this.workers = new Map();
    this.frameSource = frameSource;
    this.budget = budget;
    this.sharedCameras = new Map();
    this.detectors = new Map();
    this.masks = new Map();
    this.pending = new Set();
    this.skipped = 0;
    this.lastSkipped = 0;
    this.stats = {
      frames: 0,
      alarms: 0,
      duplicates: 0,
      errors: 0,
      clips: 0,
      // RES-2：抓拍改为异步补齐，成功入库的抓拍数单独计数。
      snapshots: 0,
      qualityAlarms: 0,
      qualityRecovered: 0,
      disarmedFrames: 0,
    };
  }

  /**
   * 探测 FFmpeg 可用性（启动时调用一次）；不可用时引擎自动停用。
   *
   * @returns {boolean} FFmpeg 是否可用。
   */
  init() {
    const result = spawnSync(this.ffmpegPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    this.ffmpegOk = result.status === 0;
    if (!this.ffmpegOk && this.enabled) {
      this.logger?.warn?.('[detection] 未找到 FFmpeg，服务端检测已停用');
    }
    return this.ffmpegOk;
  }

  /** @returns {boolean} 引擎是否处于可用状态（已启用且 FFmpeg 就绪）。 */
  get active() {
    return Boolean(this.enabled && this.ffmpegOk);
  }

  /**
   * 实际喂给 FFmpeg 的地址：相对路径（如站内演示流）先交给上层解析。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @returns {string} FFmpeg 可访问的绝对地址。
   */
  sourceFor(camera) {
    const raw = camera?.sourceUrl ?? '';
    try {
      return this.resolveSourceUrl?.(raw, camera) || raw;
    } catch {
      return raw;
    }
  }

  /**
   * 点位是否受服务端识别支持（协议在支持列表内且已启用识别）。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @returns {boolean}
   */
  supports(camera) {
    return Boolean(
      camera &&
        camera.enabled &&
        camera.detectEnabled !== false &&
        camera.sourceUrl &&
        SUPPORTED_PROTOCOLS.has(camera.protocol),
    );
  }

  /**
   * 按当前点位列表对齐 worker：新增的启动、移除的停止。
   *
   * @param {import('./types.mjs').Camera[]} [cameras] 启用识别的点位列表。
   * @returns {object} 对齐后的引擎状态快照（同 status()）。
   */
  sync(cameras = []) {
    if (!this.active) {
      this.stopAll();
      return this.status();
    }
    const keep = new Set();
    let skipped = 0;
    for (const camera of cameras) {
      if (!this.supports(camera)) continue;
      const existing = this.workers.get(camera.id);
      if (existing) {
        keep.add(camera.id);
        existing.camera = camera;
        continue;
      }
      // 共享源模式下由外部 tee 进程供帧，不再为该点位额外拉一路 FFmpeg。
      if (this.frameSource?.has(camera.id)) {
        keep.add(camera.id);
        this.ensureSharedSubscription(camera);
        continue;
      }
      // 全局并发上限：超出部分跳过，避免几十路同时解码把 CPU 打满。
      if (this.workers.size >= this.maxCameras) {
        skipped += 1;
        continue;
      }
      keep.add(camera.id);
      this.workers.set(camera.id, new CameraWorker(this, camera));
    }
    for (const id of [...this.workers.keys()]) {
      if (!keep.has(id)) this.stop(id);
    }
    for (const [id, entry] of [...this.sharedCameras]) {
      if (keep.has(id)) continue;
      try {
        entry.unsubscribe?.();
      } catch {
        // ignore
      }
      this.sharedCameras.delete(id);
    }
    this.skipped = skipped;
    if (skipped > 0 && skipped !== this.lastSkipped) {
      this.logger?.warn?.(
        `[detection] 已达并发上限 ${this.maxCameras} 路，${skipped} 路点位未启动巡检`,
      );
    }
    this.lastSkipped = skipped;
    return this.status();
  }

  /** 为共享源点位建立帧订阅；重复 sync 时只刷新 camera 引用。 */
  ensureSharedSubscription(camera) {
    const existing = this.sharedCameras.get(camera.id);
    if (existing) {
      existing.camera = camera;
      return;
    }
    const entry = { camera, unsubscribe: null };
    entry.unsubscribe = this.frameSource?.subscribe(camera.id, (frame) => {
      void this.handleFrame(entry.camera, frame).catch(() => undefined);
    }) ?? null;
    this.sharedCameras.set(camera.id, entry);
  }

  /**
   * 停止指定点位的检测进程并清理其检测器/掩码缓存。
   *
   * @param {string} cameraId 点位 ID。
   * @returns {void}
   */
  stop(cameraId) {
    const worker = this.workers.get(cameraId);
    if (worker) {
      worker.stop();
      this.workers.delete(cameraId);
    }
    this.detectors.delete(cameraId);
    this.masks.delete(cameraId);
    this.pending.delete(cameraId);
    this.qualityStates.delete(cameraId);
  }

  /** 停止全部检测进程（关机/重载时调用）。 @returns {void} */
  stopAll() {
    for (const id of [...this.workers.keys()]) this.stop(id);
    for (const [id, entry] of this.sharedCameras) {
      try {
        entry.unsubscribe?.();
      } catch {
        // ignore
      }
      this.sharedCameras.delete(id);
    }
  }

  /**
   * 按点位灵敏度缓存检测器；灵敏度变更时自动重建。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @returns {import('./detector.mjs').FlameDetector} 该点位当前可用的检测器。
   */
  detectorFor(camera) {
    const sensitivity = camera.detectSensitivity || this.sensitivity;
    const signature = `${sensitivity}:${this.cooldownMs}`;
    const existing = this.detectors.get(camera.id);
    if (existing && existing.signature === signature) return existing.detector;
    const detector = new FlameDetector(sensitivity, this.cooldownMs);
    this.detectors.set(camera.id, { detector, signature });
    return detector;
  }

  /**
   * 按点位屏蔽区缓存掩码；ROI 变更时自动重建。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @returns {Uint8Array|null} 逐像素掩码（无屏蔽区时为 null）。
   */
  maskFor(camera) {
    const roi = Array.isArray(camera.detectRoi) ? camera.detectRoi : [];
    const signature = JSON.stringify(roi);
    const existing = this.masks.get(camera.id);
    if (existing && existing.signature === signature) return existing.mask;
    const mask = buildRoiMask(roi, this.width, this.height);
    this.masks.set(camera.id, { mask, signature });
    return mask;
  }

  /**
   * 处理一帧 RGBA 画面；命中则写入告警并返回告警对象。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @param {Buffer} frame RGBA 帧数据（width × height × 4 字节）。
   * @returns {Promise<import('./types.mjs').Alarm|null>} 新建告警（未命中/冷却中/并发受限为 null）。
   */
  async handleFrame(camera, frame) {
    if (!this.active || !camera) return null;
    if (this.qualityCheck) this.trackFrameQuality(camera, frame);
    // 撤防时段（布防时间表外）跳过火情检测，但画面质量监测与播放不受影响。
    if (!isArmedNow(camera.schedule)) {
      this.stats.disarmedFrames += 1;
      return null;
    }
    const detector = this.detectorFor(camera);
    const result = detector.analyze(frame, this.width, this.height, {
      mask: this.maskFor(camera),
    });
    if (!result) return null;

    const active = this.store.activeAlarmForCamera(camera.id);
    if (active && active.level !== 'offline') {
      this.stats.duplicates += 1;
      return null;
    }
    // 画面恢复但仍挂着离线告警时，先归档离线告警，再落新的火情告警。
    if (active?.level === 'offline') {
      try {
        const actor = { id: null, username: 'server-detector' };
        this.store.updateAlarm(
          active.id,
          { status: 'archived', archivedAt: Date.now() },
          actor,
        );
        this.store.addAlarmEvent(
          active.id,
          actor,
          'archived',
          '画面恢复并检测到新告警，自动归档',
        );
      } catch {
        // 归档失败不阻断，createAlarm 若撞唯一索引会记录到 errors。
      }
    }
    if (this.pending.has(camera.id)) {
      this.stats.duplicates += 1;
      return null;
    }
    this.pending.add(camera.id);
    // 记录抓拍开始时的 worker；stop() 会把它从 workers 移除。
    const workerAtStart = this.workers.get(camera.id);
    try {
      const id = crypto.randomUUID();
      // 点位在检测期间被停止/移除时，不再写入指向已删除点位的幽灵告警。
      // RES-2：抓拍已改为异步补齐，这个检查必须前移到落库之前。
      if (workerAtStart && !this.workers.has(camera.id)) return null;
      // RES-2：告警先落库，抓拍与短视频在后台补齐。
      //
      // 原实现把抓拍放在 createAlarm 之前：RTSP 建连通常要 1~3 秒，
      // 这段时间里告警还没进库 —— 进程一旦崩溃或被杀，这段火情就永久丢失。
      // 火情告警的第一要务是「先记下来」，素材可以晚几秒补。
      const alarm = this.store.createAlarm({
        id,
        cameraId: camera.id,
        cameraName: camera.name,
        zone: camera.zone,
        siteId: camera.siteId || this.store.defaultSiteId,
        level: result.level,
        confidence: result.confidence,
        hotspot: result.hotspot,
        snapshotFile: null,
        actor: { id: null, username: 'server-detector' },
      });
      this.stats.alarms += 1;
      try {
        this.onAlarm?.(alarm, camera);
      } catch (error) {
        this.logger?.warn?.(`[detection] 告警回调失败：${error.message}`);
      }
      // 抓拍异步补齐：完成后回填并广播，前端无需等待。
      void this.captureSnapshot(camera, id)
        .then((snapshotFile) => {
          if (!snapshotFile) return;
          try {
            const updated = this.store.setAlarmSnapshot(alarm.id, snapshotFile);
            this.stats.snapshots += 1;
            this.onSnapshot?.(updated, camera);
          } catch (error) {
            this.logger?.warn?.(`[detection] 抓拍入库失败：${error.message}`);
          }
        })
        .catch((error) => {
          this.logger?.warn?.(`[detection] 抓拍失败：${error.message}`);
        });
      // 先返回告警，再异步补录短视频；录完广播更新，前端无需等待。
      void this.captureClip(camera, alarm.id)
        .then((clipFile) => {
          if (!clipFile) return;
          try {
            const updated = this.store.setAlarmClip(alarm.id, clipFile);
            this.stats.clips += 1;
            this.onClip?.(updated, camera);
          } catch (error) {
            this.logger?.warn?.(`[detection] 短视频入库失败：${error.message}`);
          }
        })
        .catch(() => undefined);
      return alarm;
    } catch (error) {
      this.stats.errors += 1;
      this.logger?.warn?.(
        `[detection] ${camera.code ?? camera.id} 写告警失败：${error.message}`,
      );
      return null;
    } finally {
      this.pending.delete(camera.id);
    }
  }

  /**
   * 画面质量状态机：连续异常持续超过确认窗口才上报，恢复需连续正常一段时长。
   *
   * 去抖设计针对两类误报场景：夜视低照度偶发低纹理帧（covered）、
   * 车灯/闪光灯导致的瞬时过曝帧（bright）。持续时间是最强的判据。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @param {Buffer} frame RGBA 帧数据。
   * @returns {void}
   */
  trackFrameQuality(camera, frame) {
    const assessment = analyzeFrameQuality(frame, this.width, this.height);
    const now = Date.now();
    const state = this.qualityStates.get(camera.id);

    if (assessment.ok) {
      if (!state) return;
      // 恢复判定：连续正常保持 RECOVER_OK_MS 才算真正恢复。
      if (!state.okSince) state.okSince = now;
      if (state.reported && now - state.okSince >= QUALITY_RECOVER_MS) {
        this.qualityStates.delete(camera.id);
        this.stats.qualityRecovered += 1;
        try {
          this.onQualityEvent?.(camera, {
            kind: 'recovered',
            reason: state.reason,
          });
        } catch (error) {
          this.logger?.warn?.(`[detection] 画面恢复回调失败：${error.message}`);
        }
      }
      return;
    }

    // 异常帧：类别变化时重新计时（遮挡→过暗是两种不同故障）。
    if (!state || state.reason !== assessment.reason) {
      this.qualityStates.set(camera.id, {
        reason: assessment.reason,
        firstBadAt: now,
        reported: false,
        okSince: null,
      });
      return;
    }
    state.okSince = null;
    if (!state.reported && now - state.firstBadAt >= QUALITY_CONFIRM_MS) {
      state.reported = true;
      this.stats.qualityAlarms += 1;
      try {
        this.onQualityEvent?.(camera, {
          kind: 'abnormal',
          reason: assessment.reason,
          durationMs: now - state.firstBadAt,
          meanLuma: Math.round(assessment.meanLuma * 10) / 10,
          edgeStrength: Math.round(assessment.edgeStrength * 100) / 100,
        });
      } catch (error) {
        this.logger?.warn?.(`[detection] 画面异常回调失败：${error.message}`);
      }
    }
  }

  /**
   * 命中时补一张抓拍，失败不影响告警落库。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @param {string} id 告警 ID。
   * @returns {Promise<string|null>} 抓拍文件名（未配置目录或失败为 null）。
   */
  async captureSnapshot(camera, id) {
    if (!this.snapshotDir) return null;
    const file = `${id}.jpg`;
    const target = path.join(this.snapshotDir, file);
    // 临时名保留 .jpg 扩展名（FFmpeg 依据扩展名推断封装格式），
    // 成功后再原子改名：失败/超时时磁盘上不会留下不完整的半成品文件。
    const temp = path.join(this.snapshotDir, `.tmp-${file}`);
    try {
      await fsp.mkdir(this.snapshotDir, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
    const args = ['-v', 'error', '-nostdin', '-y'];
    if (camera.protocol === 'rtsp') args.push('-rtsp_transport', 'tcp');
    args.push('-i', this.sourceFor(camera), '-frames:v', '1', '-q:v', '4', '-an', temp);

    // RES-1：抓拍也占 FFmpeg 进程名额，避免告警高峰时与常驻抽帧进程抢 CPU。
    // 拿不到名额等同抓拍失败（返回 null），不影响告警落库。
    try {
      return await this.budget.withSlot({ label: `snapshot:${camera.code}` }, () =>
        runFfmpegOnce({
          spawnImpl: this.spawnImpl,
          ffmpegPath: this.ffmpegPath,
          args,
          timeoutMs: this.snapshotTimeoutMs,
          stdio: ['ignore', 'ignore', 'ignore'],
          failureValue: null,
          onExit: (code) => {
            try {
              if (code !== 0 || !fs.existsSync(temp)) {
                try {
                  fs.unlinkSync(temp);
                } catch {
                  // ignore
                }
                return null;
              }
              fs.renameSync(temp, target);
              return file;
            } catch {
              try {
                fs.unlinkSync(temp);
              } catch {
                // ignore
              }
              return null;
            }
          },
        }),
      );
    } catch {
      return null;
    }
  }

  /**
   * 命中后补录一段短视频，转成浏览器可播放的 H.264 MP4。
   *
   * @param {import('./types.mjs').Camera} camera 点位。
   * @param {string} id 告警 ID。
   * @returns {Promise<string|null>} 短视频文件名（未配置目录或失败为 null）。
   */
  async captureClip(camera, id) {
    if (!this.recordingsDir) return null;
    const file = `${id}.mp4`;
    const target = path.join(this.recordingsDir, file);
    // 同抓拍：先写临时文件，成功后原子改名，失败时清理半成品。
    const temp = path.join(this.recordingsDir, `.tmp-${file}`);
    try {
      await fsp.mkdir(this.recordingsDir, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
    const args = ['-v', 'error', '-nostdin', '-y'];
    if (camera.protocol === 'rtsp') args.push('-rtsp_transport', 'tcp');
    args.push(
      '-i',
      this.sourceFor(camera),
      '-t',
      String(this.clipSeconds),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      temp,
    );
    // RES-1：补录同样占用 FFmpeg 进程名额（转码比抽帧更吃 CPU）。
    try {
      return await this.budget.withSlot({ label: `clip:${camera.code}` }, () =>
        runFfmpegOnce({
          spawnImpl: this.spawnImpl,
          ffmpegPath: this.ffmpegPath,
          args,
          timeoutMs: this.clipTimeoutMs,
          stdio: ['ignore', 'ignore', 'ignore'],
          failureValue: null,
          onExit: (code) => {
            try {
              if (code !== 0 || !fs.existsSync(temp)) {
                try {
                  fs.unlinkSync(temp);
                } catch {
                  // ignore
                }
                return null;
              }
              fs.renameSync(temp, target);
              return file;
            } catch {
              try {
                fs.unlinkSync(temp);
              } catch {
                // ignore
              }
              return null;
            }
          },
        }),
      );
    } catch {
      return null;
    }
  }

  /**
   * 引擎运行状态快照（/api/detection/status 用）。
   *
   * @returns {{enabled: boolean, ffmpegAvailable: boolean, active: boolean,
   *   width: number, height: number, fps: number, sensitivity: string,
   *   cooldownMs: number, maxCameras: number, skipped: number,
   *   keyframesOnly: boolean, clipSeconds: number,
   *   stats: {frames: number, alarms: number, duplicates: number, errors: number,
   *     clips: number, qualityAlarms: number, qualityRecovered: number, disarmedFrames: number},
   *   cameras: Array<{cameraId: string, code: string, name: string, siteId: string|null,
   *     sensitivity: string, roiCount: number, running: boolean, frames: number,
   *     startedAt: number, lastFrameAt: number|null, lastError: string|null}>}}
   */
  status(options = {}) {
    // 站点管理员只能看到自己站点下的点位：状态里含 lastError（摄像头错误详情），
    // 不过滤会把其它站点的点位信息一并泄露出去。
    const allowedSiteIds = Array.isArray(options.allowedSiteIds)
      ? options.allowedSiteIds
      : null;
    const visible = (camera) =>
      allowedSiteIds === null ||
      allowedSiteIds.includes(camera.siteId ?? this.store?.defaultSiteId ?? null);
    return {
      enabled: this.enabled,
      ffmpegAvailable: this.ffmpegOk,
      active: this.active,
      width: this.width,
      height: this.height,
      fps: this.fps,
      sensitivity: this.sensitivity,
      cooldownMs: this.cooldownMs,
      maxCameras: this.maxCameras,
      skipped: this.skipped,
      keyframesOnly: this.keyframesOnly,
      clipSeconds: this.clipSeconds,
      stats: { ...this.stats },
      cameras: [
        ...[...this.workers.values()]
          .filter((worker) => visible(worker.camera))
          .map((worker) => ({
        cameraId: worker.camera.id,
        code: worker.camera.code,
        name: worker.camera.name,
        siteId: worker.camera.siteId ?? null,
        sensitivity: worker.camera.detectSensitivity ?? this.sensitivity,
        roiCount: Array.isArray(worker.camera.detectRoi)
          ? worker.camera.detectRoi.length
          : 0,
        running: Boolean(worker.child),
        frames: worker.frames,
        startedAt: worker.startedAt,
        lastFrameAt: worker.lastFrameAt || null,
        lastError: worker.lastError,
      })),
        ...[...this.sharedCameras.values()]
          .filter((entry) => visible(entry.camera))
          .map((entry) => ({
          cameraId: entry.camera.id,
          code: entry.camera.code,
          name: entry.camera.name,
          siteId: entry.camera.siteId ?? null,
          sensitivity: entry.camera.detectSensitivity ?? this.sensitivity,
          roiCount: Array.isArray(entry.camera.detectRoi)
            ? entry.camera.detectRoi.length
            : 0,
          running: true,
          frames: this.frameSource?.status?.()?.cameras?.find(
            (item) => item.cameraId === entry.camera.id,
          )?.frames ?? 0,
          startedAt: this.startedAt ?? Date.now(),
          lastFrameAt: null,
          lastError: null,
        })),
      ],
    };
  }
}

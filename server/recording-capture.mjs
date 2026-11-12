/**
 * 持续录像采集（设计文档 docs/continuous-recording-design.md §3）。
 *
 * 与检测引擎 / 观看转码完全分离：本模块只负责把点位源按 60 秒分段
 * `stream copy` 落到 data/continuous/<cameraId>/<YYYYMMDD>/<HHmmss>.ts，
 * 索引与回放由 recording-index.mjs / recording-playback.mjs 负责。
 *
 * 设计要点：
 * - 文件名由 FFmpeg `segment` muxer 的 `-strftime 1` 生成，子进程显式注入
 *   `TZ=UTC`，保证段名与 recording-index.mjs 的 UTC 解释一致（不依赖服务器时区）。
 * - 目录按 UTC 日由 Node 预建；跨 UTC 日时 manager.rotate() 会重建进程与目录，
 *   避免段文件落到前一天目录。
 * - spawnImpl / ffmpegCheck / clock / armedCheck 均可注入，因此完整生命周期
 *   可在纯夹具上测试，不需要真实设备或 FFmpeg。
 * - 默认 enabled=false，未显式开启时不会启动任何进程。
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { isArmedNow } from './schedule.mjs';
import { sanitizeErrorText } from './sanitize.mjs';
import { inputTimeoutArgs } from './ffmpeg-input.mjs';
import { ffmpegBudget } from './ffmpeg-budget.mjs';

/** 点位 ID 必须是安全路径片段，杜绝目录穿越。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SUPPORTED_PROTOCOLS = new Set(['rtsp', 'hls', 'http', 'edge']);
const pad2 = (value) => String(value).padStart(2, '0');

/** @param {number} atMs epoch ms @returns {string} UTC 日目录名 YYYYMMDD */
export function utcDayStamp(atMs) {
  const date = new Date(atMs);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

/**
 * 计算某点位某时刻的录像目录；ID 非法时返回 null（拒绝录像而非静默拼接路径）。
 * @param {string} rootDir
 * @param {string} cameraId
 * @param {number} atMs
 * @returns {string | null}
 */
export function captureDirFor(rootDir, cameraId, atMs) {
  const id = String(cameraId ?? '');
  if (!SAFE_ID.test(id)) return null;
  return path.join(rootDir, id, utcDayStamp(atMs));
}

/**
 * 构造 FFmpeg copy 分段命令行（纯函数，便于断言）。
 * @param {{source: string, isRtsp?: boolean, outputPattern: string, segmentSeconds: number}} options
 * @returns {string[]}
 */
export function buildCaptureArgs({ source, isRtsp = false, outputPattern, segmentSeconds }) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    ...inputTimeoutArgs({ isRtsp }),
  ];
  if (isRtsp) args.push('-rtsp_transport', 'tcp');
  args.push(
    '-i',
    source,
    // 只取首个视频流与可选音频流，避免数据流/字幕让 mpegts muxer 报错。
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-segment_format',
    'mpegts',
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    outputPattern,
  );
  return args;
}

class CaptureWorker {
  constructor(manager, camera) {
    this.manager = manager;
    this.camera = camera;
    this.child = null;
    this.restartTimer = null;
    this.backoffMs = 1_000;
    this.stopping = false;
    this.lastError = null;
    this.dayStamp = null;
    this.startedAt = manager.clock();
    // RES-1：FFmpeg 进程预算名额。
    this.budgetToken = null;
    // P0-2：裸 void 的 rejection 会变成 unhandledRejection 并终止进程，这里显式兜住。
    void this.start().catch((error) => {
      manager.logger?.warn?.('recording_capture_start_failed', {
        cameraId: camera.id,
        message: error.message,
      });
    });
  }

  sourceFor() {
    const raw = this.camera?.sourceUrl ?? '';
    try {
      return this.manager.resolveSourceUrl?.(raw, this.camera) || raw;
    } catch {
      return raw;
    }
  }

  async start() {
    if (this.stopping) return;
    // RES-1：先申请 FFmpeg 进程预算，避免录像与检测/共享源一起把进程数打爆。
    let token = null;
    try {
      token = await this.manager.budget.acquire({ label: `capture:${this.camera.code}` });
    } catch (error) {
      this.scheduleRestart(error.message);
      return;
    }
    if (this.stopping) {
      this.manager.budget.release(token);
      return;
    }
    this.budgetToken = token;
    const at = this.manager.clock();
    const dir = captureDirFor(this.manager.rootDir, this.camera.id, at);
    if (!dir) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
      this.lastError = '点位 ID 含非法字符，已跳过录像';
      this.manager.logger?.warn?.('recording_capture_invalid_camera_id', {
        cameraId: this.camera.id,
      });
      return;
    }
    this.dayStamp = utcDayStamp(at);
    try {
      await fsp.mkdir(dir, { recursive: true, mode: this.manager.dirMode });
    } catch (error) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
      this.scheduleRestart(`创建录像目录失败：${error.message}`);
      return;
    }
    if (this.stopping) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
      return;
    }
    const source = this.sourceFor();
    if (!source) {
      this.lastError = '点位未配置视频源';
      return;
    }
    const args = buildCaptureArgs({
      source,
      isRtsp: this.camera.protocol === 'rtsp',
      outputPattern: path.join(dir, '%H%M%S.ts'),
      segmentSeconds: this.manager.segmentSeconds,
    });
    let child;
    try {
      child = this.manager.spawnImpl(this.manager.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, TZ: 'UTC' },
      });
    } catch (error) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
      this.scheduleRestart(`FFmpeg 启动失败：${error.message}`);
      return;
    }
    this.child = child;
    child.stderr?.on?.('data', (chunk) => {
      const text = chunk.toString().trim();
      // FFmpeg 会把输入 URL 原样打进 stderr（含 rtsp://user:pass@host），
      // 落库前先抹除 userinfo，否则状态接口会把摄像头密码回传给前端。
      if (text) this.lastError = sanitizeErrorText(text, 400);
    });
    // 用 token 判定回调是否属于当前进程：换日/停止时先置空 this.child，
    // 旧进程被 kill 后触发的 exit 会被忽略，不会误触发退避重启。
    child.on?.('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(`FFmpeg 错误：${error.message}`);
    });
    child.on?.('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(`FFmpeg 退出（code=${code}）`);
    });
  }

  onExit(reason) {
    // RES-1：进程退出即归还预算名额。
    if (this.budgetToken) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
    }
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
      // P0-2：裸 void 的 rejection 会变成 unhandledRejection 并终止进程，这里显式兜住。
      void this.start().catch((error) => {
        this.manager.logger?.warn?.('recording_capture_restart_failed', {
          cameraId: this.camera.id,
          message: error.message,
        });
      });
    }, delay);
    this.restartTimer.unref?.();
    this.manager.logger?.warn?.('recording_capture_restart', {
      cameraId: this.camera.id,
      delay,
      reason: this.lastError,
    });
  }

  /** 跨 UTC 日时重建进程与目录。 */
  async rotateIfNeeded() {
    if (this.stopping) return false;
    const stamp = utcDayStamp(this.manager.clock());
    if (stamp === this.dayStamp) return false;
    this.stopChild();
    this.backoffMs = 1_000;
    await this.start();
    return true;
  }

  stopChild() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    // 先摘掉引用，旧进程的 exit/error 回调会因 token 不匹配被忽略。
    this.child = null;
    try {
      child?.kill?.('SIGKILL');
    } catch {
      // ignore
    }
    // RES-1：换日/停止时必须立刻归还名额，否则录像位会一直占着预算不放。
    if (this.budgetToken) {
      this.manager.budget.release(this.budgetToken);
      this.budgetToken = null;
    }
  }

  stop() {
    this.stopping = true;
    this.stopChild();
  }

  status() {
    return {
      cameraId: this.camera.id,
      siteId: this.camera.siteId ?? null,
      day: this.dayStamp,
      running: Boolean(this.child),
      lastError: this.lastError,
      backoffMs: this.backoffMs,
    };
  }
}

export class RecordingCaptureManager {
  /**
   * @param {object} [options]
   * @param {string} options.rootDir 录像段根目录。
   * @param {boolean} [options.enabled] 采集总闸（RECORDING=1）。
   * @param {typeof import('node:child_process').spawn} [options.spawnImpl]
   * @param {() => boolean} [options.ffmpegCheck] FFmpeg 可用性检测（测试注入）。
   * @param {(raw: string, camera: object) => string} [options.resolveSourceUrl]
   * @param {() => number} [options.clock]
   * @param {(schedule: unknown, at?: Date) => boolean} [options.armedCheck]
   */
  constructor({
    rootDir,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    spawnImpl = nodeSpawn,
    ffmpegCheck,
    enabled = false,
    segmentSeconds = 60,
    maxCameras = 24,
    resolveSourceUrl = null,
    clock = () => Date.now(),
    armedCheck = isArmedNow,
    sharedHub = null,
    logger = console,
    dirMode = 0o700,
    // RES-1：全局 FFmpeg 进程预算（可注入，便于测试）。
    budget = ffmpegBudget,
  } = {}) {
    this.rootDir = rootDir;
    this.ffmpegPath = ffmpegPath;
    this.spawnImpl = spawnImpl;
    this.ffmpegCheck =
      ffmpegCheck ||
      (() => spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' }).status === 0);
    this.enabled = Boolean(enabled);
    this.segmentSeconds = Math.min(Math.max(Number(segmentSeconds) || 60, 10), 600);
    this.maxCameras = Math.min(Math.max(Number(maxCameras) || 24, 1), 256);
    this.resolveSourceUrl = resolveSourceUrl;
    this.clock = clock;
    this.armedCheck = armedCheck;
    this.sharedHub = sharedHub;
    this.logger = logger;
    this.dirMode = dirMode;
    this.budget = budget;
    this.workers = new Map();
    this.ffmpegAvailable = false;
    this.skipped = 0;
  }

  init() {
    try {
      this.ffmpegAvailable = Boolean(this.ffmpegCheck());
    } catch {
      this.ffmpegAvailable = false;
    }
    return this.ffmpegAvailable;
  }

  supports(camera) {
    return Boolean(
      camera &&
        SAFE_ID.test(String(camera.id ?? '')) &&
        camera.enabled &&
        camera.sourceUrl &&
        SUPPORTED_PROTOCOLS.has(camera.protocol),
    );
  }

  /** 对齐点位列表（启停、改源、布防时段、并发上限）。 */
  sync(cameras = []) {
    if (!this.enabled || !this.ffmpegAvailable) {
      this.stopAll();
      return this.status();
    }
    // 共享源模式：hub 统一拉流并产段，本管理器只负责布防与并发过滤。
    if (this.sharedHub) {
      const supported = cameras.filter((camera) => this.supports(camera));
      const eligible = supported
        .filter((camera) => this.armedCheck(camera.schedule))
        .slice(0, this.maxCameras);
      this.skipped = Math.max(0, supported.length - eligible.length);
      void this.sharedHub.sync(eligible).catch((error) => {
        this.logger?.warn?.('recording_shared_sync_failed', { message: error.message });
      });
      return this.status();
    }
    const keep = new Set();
    let skipped = 0;
    for (const camera of cameras) {
      if (!this.supports(camera)) continue;
      if (!this.armedCheck(camera.schedule)) continue;
      const existing = this.workers.get(camera.id);
      if (existing) {
        keep.add(camera.id);
        existing.camera = camera;
        continue;
      }
      if (this.workers.size >= this.maxCameras) {
        skipped += 1;
        continue;
      }
      keep.add(camera.id);
      this.workers.set(camera.id, new CaptureWorker(this, camera));
    }
    for (const id of [...this.workers.keys()]) {
      if (!keep.has(id)) this.stop(id);
    }
    this.skipped = skipped;
    return this.status();
  }

  /** 定时换日检查；串行执行避免同一轮内多个进程同时重建。 */
  async rotate() {
    if (this.sharedHub) {
      this.sharedHub.rotate();
      return;
    }
    for (const worker of this.workers.values()) {
      try {
        await worker.rotateIfNeeded();
      } catch (error) {
        this.logger?.warn?.('recording_capture_rotate_failed', {
          message: error.message,
        });
      }
    }
  }

  stop(cameraId) {
    const worker = this.workers.get(cameraId);
    if (!worker) return;
    worker.stop();
    this.workers.delete(cameraId);
  }

  stopAll() {
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
    this.sharedHub?.stopAll();
  }

  status(options = {}) {
    const shared = this.sharedHub?.status?.();
    // 站点管理员只应看到自己站点的采集状态（状态含摄像头错误详情）。
    const allowedSiteIds = Array.isArray(options.allowedSiteIds)
      ? options.allowedSiteIds
      : null;
    const visible = (siteId) => allowedSiteIds === null || allowedSiteIds.includes(siteId);
    const cameras = shared ? shared.cameras : [...this.workers.values()].map((worker) => worker.status());
    return {
      enabled: this.enabled,
      ffmpegAvailable: this.ffmpegAvailable,
      active: shared ? shared.active : this.workers.size,
      total: shared ? shared.active : this.workers.size,
      skipped: this.skipped,
      maxCameras: this.maxCameras,
      segmentSeconds: this.segmentSeconds,
      cameras: cameras.filter((item) => visible(item.siteId ?? null)),
    };
  }
}

/**
 * 共享 FFmpeg 源（设计取舍项 #10，默认关闭）。
 *
 * 常规模式下同一 RTSP 点位会被「检测抽帧」与「录像 copy」各拉一路流；
 * 本模块用一个 FFmpeg 进程接同一输入，两个输出：
 *   ① -c copy -f segment 产 TS 段（不解码）
 *   ② -vf fps/scale -f rawvideo pipe:1 供检测引擎抽帧
 * 收益是省一路 RTSP 连接/带宽；代价是两个 worker 生命周期耦合，故仅在
 * `RECORDING_SHARED_SOURCE=1` 且 RECORDING=1 时由装配层显式启用。
 *
 * spawnImpl / clock 可注入，全部行为可离线测试；不启用时项目行为零变化。
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { extractFrames } from './detection-engine.mjs';
import { captureDirFor, utcDayStamp } from './recording-capture.mjs';

/**
 * 构造「一路输入、两路输出」的 FFmpeg 参数（纯函数）。
 * @param {{source:string, isRtsp?:boolean, outputPattern:string, segmentSeconds:number,
 *   width:number, height:number, fps:number}} options
 */
export function buildTeeArgs({
  source,
  isRtsp = false,
  outputPattern,
  segmentSeconds,
  width,
  height,
  fps,
}) {
  const filter =
    `fps=${fps},` +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-rw_timeout',
    '15000000',
    ...(isRtsp ? ['-rtsp_transport', 'tcp'] : []),
    '-i',
    source,
    // 输出 1：原始码流 copy 分段（不解码，CPU 开销接近零）。
    '-map',
    '0:v:0',
    '-an',
    '-c:v',
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
    // 输出 2：抽帧供服务端识别（复用同一输入连接）。
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    filter,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ];
}

export class SharedSourceHub {
  constructor({
    rootDir,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    spawnImpl = nodeSpawn,
    segmentSeconds = 60,
    width = 160,
    height = 90,
    fps = 1,
    clock = () => Date.now(),
    logger = console,
    dirMode = 0o700,
  } = {}) {
    this.rootDir = rootDir;
    this.ffmpegPath = ffmpegPath;
    this.spawnImpl = spawnImpl;
    this.segmentSeconds = segmentSeconds;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.clock = clock;
    this.logger = logger;
    this.dirMode = dirMode;
    this.sessions = new Map();
    this.frameBytes = width * height * 4;
  }

  has(cameraId) {
    return this.sessions.has(cameraId);
  }

  activeIds() {
    return [...this.sessions.keys()];
  }

  /** 启动（或复用）某点位的共享进程；失败返回 null。 */
  async start(camera) {
    const existing = this.sessions.get(camera.id);
    if (existing && existing.child) return existing;
    const at = this.clock();
    const dir = captureDirFor(this.rootDir, camera.id, at);
    if (!dir) return null;
    try {
      await fsp.mkdir(dir, { recursive: true, mode: this.dirMode });
    } catch (error) {
      this.logger?.warn?.('shared_source_mkdir_failed', { message: error.message });
      return null;
    }
    const args = buildTeeArgs({
      source: camera.sourceUrl,
      isRtsp: camera.protocol === 'rtsp',
      outputPattern: path.join(dir, '%H%M%S.ts'),
      segmentSeconds: this.segmentSeconds,
      width: this.width,
      height: this.height,
      fps: this.fps,
    });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TZ: 'UTC' },
      });
    } catch (error) {
      this.logger?.warn?.('shared_source_spawn_failed', { message: error.message });
      return null;
    }
    const session = {
      camera,
      child,
      day: utcDayStamp(at),
      subscribers: new Set(),
      buffer: Buffer.alloc(0),
      frames: 0,
      startedAt: at,
      lastError: null,
    };
    this.sessions.set(camera.id, session);
    child.stdout?.on?.('data', (chunk) => {
      session.buffer = session.buffer.length
        ? Buffer.concat([session.buffer, chunk])
        : chunk;
      const { frames, rest } = extractFrames(session.buffer, this.frameBytes);
      session.buffer = rest.length ? Buffer.from(rest) : Buffer.alloc(0);
      for (const frame of frames) {
        session.frames += 1;
        for (const callback of session.subscribers) {
          try {
            callback(frame);
          } catch {
            // 单个订阅者异常不影响其它订阅者与采集进程。
          }
        }
      }
    });
    child.stderr?.on?.('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) session.lastError = text.slice(-400);
    });
    child.on?.('error', (error) => {
      session.lastError = error.message;
    });
    child.on?.('exit', () => {
      // 交由下一轮 sync 重建，避免与停止流程竞争。
      if (this.sessions.get(camera.id) === session) session.child = null;
    });
    return session;
  }

  /** 订阅某点位的帧；返回取消订阅函数，会话不存在返回 null。 */
  subscribe(cameraId, callback) {
    const session = this.sessions.get(cameraId);
    if (!session) return null;
    session.subscribers.add(callback);
    return () => session.subscribers.delete(callback);
  }

  /** 对齐点位列表；onFrameFor 可选，用于为检测引擎建立订阅。 */
  async sync(cameras = [], { onFrameFor = null } = {}) {
    const keep = new Set();
    for (const camera of cameras) {
      if (!camera?.enabled || !camera.sourceUrl) continue;
      const session = await this.start(camera);
      if (!session) continue;
      keep.add(camera.id);
      session.camera = camera;
      if (onFrameFor && !session.detectionAttached) {
        const unsubscribe = onFrameFor(camera.id);
        session.detectionAttached = Boolean(unsubscribe);
        if (unsubscribe) session.detachDetection = unsubscribe;
      }
    }
    for (const id of [...this.sessions.keys()]) {
      if (!keep.has(id)) this.stop(id);
    }
    return this.status();
  }

  /** 跨 UTC 日时终止进程，下一次 sync 会用新日期目录重建。 */
  rotate() {
    const day = utcDayStamp(this.clock());
    for (const [id, session] of this.sessions) {
      if (session.day !== day) this.stop(id);
    }
  }

  stop(cameraId) {
    const session = this.sessions.get(cameraId);
    if (!session) return;
    this.sessions.delete(cameraId);
    try {
      session.detachDetection?.();
    } catch {
      // ignore
    }
    session.subscribers.clear();
    try {
      session.child?.kill?.('SIGKILL');
    } catch {
      // ignore
    }
    session.child = null;
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  status() {
    return {
      active: this.sessions.size,
      cameras: [...this.sessions.values()].map((session) => ({
        cameraId: session.camera.id,
        day: session.day,
        running: Boolean(session.child),
        frames: session.frames,
        lastError: session.lastError,
      })),
    };
  }
}

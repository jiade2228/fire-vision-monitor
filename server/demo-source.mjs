import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

/**
 * 本地演示视频源。
 *
 * 没有真实摄像头时，用 FFmpeg 的 lavfi 虚拟输入合成一段「会闪烁的火光」，
 * 实时转封装成无限循环的 HLS 直播流（分片滚动删除，不会占满磁盘）。
 * 该流对上层完全透明：既是浏览器可直接播放的 m3u8，
 * 也能被服务端检测引擎解码，从而在没有硬件的情况下跑通
 * 「播放 → 识别 → 告警 → 抓拍/短视频 → 推送 → 统计」的完整闭环。
 *
 * 安全性：播放列表与分片走一次性随机 token（/demo/<token>/…），
 * 演示停止后 token 失效、目录删除，避免留下长期可访问的地址。
 */

export const DEMO_CAMERA_CODE = 'DEMO-01';
export const DEMO_CAMERA_NAME = '演示点位（合成火焰）';
export const DEMO_CAMERA_ZONE = '演示区';

export class DemoSourceError extends Error {
  constructor(message, { code = 'DEMO_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'DemoSourceError';
    this.code = code;
    this.status = status;
  }
}

function clamp(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

/** 生成火焰合成画面：两块暖色方块按 1 秒周期交替亮灭，模拟火焰明暗跳动。 */
export function demoFilter({ width = 640, height = 360, fps = 15 } = {}) {
  const drawbox = (fx, fy, fw, fh, color, enable) => {
    const x = Math.round(width * fx);
    const y = Math.round(height * fy);
    const w = Math.max(Math.round(width * fw), 8);
    const h = Math.max(Math.round(height * fh), 8);
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@0.95:t=fill:enable='${enable}'`;
  };
  return [
    `testsrc2=s=${width}x${height}:r=${fps}`,
    drawbox(0.18, 0.42, 0.2, 0.44, '0xff4500', 'lt(mod(t,2),1)'),
    drawbox(0.5, 0.33, 0.16, 0.36, '0xff2200', 'gte(mod(t,2),1)'),
  ].join(',');
}

export class DemoSource {
  constructor({
    dataDir,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    width = Number(process.env.DEMO_WIDTH) || 640,
    height = Number(process.env.DEMO_HEIGHT) || 360,
    fps = Number(process.env.DEMO_FPS) || 15,
    logger = console,
    spawnImpl = spawn,
  } = {}) {
    this.dataDir = dataDir;
    this.ffmpegPath = ffmpegPath;
    this.width = clamp(width, 640, 320, 1280);
    this.height = clamp(height, 360, 180, 720);
    this.fps = clamp(fps, 15, 5, 30);
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.segmentSeconds = clamp(process.env.DEMO_SEGMENT_SECONDS, 2, 1, 6);
    this.playlistSize = clamp(process.env.DEMO_PLAYLIST_SIZE, 6, 3, 12);
    this.child = null;
    this.token = null;
    this.startedAt = 0;
    this.lastError = null;
    this.ffmpegAvailable = false;
  }

  init() {
    try {
      const result = spawnSync(this.ffmpegPath, ['-version'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      this.ffmpegAvailable = result.status === 0;
    } catch {
      this.ffmpegAvailable = false;
    }
    return this.ffmpegAvailable;
  }

  get directory() {
    return path.join(this.dataDir, 'demo');
  }

  get playlistFile() {
    return path.join(this.directory, 'index.m3u8');
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  buildArgs() {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      // lavfi 是虚拟输入，不加 -re 会瞬间生成；-re 让它按帧率实时产出。
      '-re',
      '-f',
      'lavfi',
      '-i',
      demoFilter({ width: this.width, height: this.height, fps: this.fps }),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-g',
      String(Math.max(Math.round(this.fps * 2), 15)),
      '-sc_threshold',
      '0',
      // 每个分片起点强制关键帧，保证分片时长稳定、起播更快。
      '-force_key_frames',
      `expr:gte(t,n_forced*${this.segmentSeconds})`,
      '-f',
      'hls',
      '-hls_time',
      String(this.segmentSeconds),
      '-hls_list_size',
      String(this.playlistSize),
      '-hls_flags',
      'delete_segments+omit_endlist+independent_segments+temp_file',
      '-hls_segment_filename',
      path.join(this.directory, 'seg-%05d.ts'),
      this.playlistFile,
    ];
  }

  /** 启动合成流并等待首个分片就绪；已运行时直接返回当前状态。 */
  async start({ timeoutMs = 15_000 } = {}) {
    if (this.running) return this.status();
    if (!this.ffmpegAvailable) {
      throw new DemoSourceError('服务器未安装 FFmpeg，无法生成演示视频源', {
        code: 'FFMPEG_MISSING',
        status: 503,
      });
    }
    const token = crypto.randomBytes(16).toString('hex');
    await fsp.rm(this.directory, { recursive: true, force: true });
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, this.buildArgs(), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      throw new DemoSourceError(`FFmpeg 启动失败：${error.message}`, {
        code: 'SPAWN_FAILED',
      });
    }
    this.child = child;
    this.token = token;
    this.startedAt = Date.now();
    this.lastError = null;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.fail(`FFmpeg 启动失败：${error.message}`);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.fail(`演示流中断（退出码 ${code}）${stderr ? `：${stderr.trim().slice(0, 200)}` : ''}`);
    });
    try {
      await this.waitForPlaylist(timeoutMs);
    } catch (error) {
      this.stop();
      throw error;
    }
    return this.status();
  }

  fail(message) {
    this.lastError = message;
    this.child = null;
    this.token = null;
    this.logger?.warn?.(message);
  }

  /** 轮询等待播放列表出现首个分片。 */
  async waitForPlaylist(timeoutMs = 15_000) {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1_000), 60_000);
    while (Date.now() < deadline) {
      if (this.lastError) {
        throw new DemoSourceError(`演示视频源启动失败：${this.lastError}`);
      }
      try {
        const content = await fsp.readFile(this.playlistFile, 'utf8');
        if (content.includes('#EXTINF')) return true;
      } catch {
        // 等待 FFmpeg 落地首个分片
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new DemoSourceError('等待演示视频源超时，请确认服务器可用 FFmpeg 生成视频', {
      code: 'DEMO_TIMEOUT',
    });
  }

  async playlist() {
    return fsp.readFile(this.playlistFile, 'utf8');
  }

  segmentPath(name) {
    if (!/^[a-zA-Z0-9._-]+\.ts$/.test(name)) return null;
    return path.join(this.directory, name);
  }

  verifyToken(value) {
    if (!this.running || typeof value !== 'string' || !this.token) return false;
    const provided = Buffer.from(value);
    const expected = Buffer.from(this.token);
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.token = null;
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出则忽略
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          // 已退出则忽略
        }
      }, 3_000).unref?.();
    }
    void fsp.rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  status() {
    return {
      running: this.running,
      ffmpegAvailable: this.ffmpegAvailable,
      width: this.width,
      height: this.height,
      fps: this.fps,
      segmentSeconds: this.segmentSeconds,
      playlistSize: this.playlistSize,
      startedAt: this.startedAt || null,
      lastError: this.lastError,
      // 只有运行中才暴露播放令牌，停止后旧地址自动失效。
      playlistUrl: this.running ? `/demo/${this.token}/index.m3u8` : null,
    };
  }
}

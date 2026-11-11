import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sanitizeErrorText } from './sanitize.mjs';
import { ffmpegBudget } from './ffmpeg-budget.mjs';

export class StreamError extends Error {
  constructor(message, { code = 'STREAM_ERROR', status = 502, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class StreamManager {
  constructor({
    dataDir,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    maxStreams = Number(process.env.MAX_CONCURRENT_STREAMS || 8),
    maxIdleMs = 90_000,
    logger = console,
    // RES-1：全局 FFmpeg 进程预算（可注入，便于测试）。
    budget = ffmpegBudget,
    // 由启动时的 FFmpeg 能力探测注入；缺省时回退环境变量/首选编码器。
    videoCodec = process.env.FFMPEG_VIDEO_CODEC || 'libx264',
  }) {
    this.dataDir = dataDir;
    this.ffmpegPath = ffmpegPath;
    this.videoCodec = videoCodec;
    // Math.max(NaN, 1) 仍是 NaN —— 会让 activeCount() >= maxStreams 恒假，
    // 并发上限彻底失效。显式把非法值回退到 8 再钳制。
    const requested = Number(maxStreams);
    this.maxStreams = Math.min(Math.max(Number.isFinite(requested) ? requested : 8, 1), 64);
    this.maxIdleMs = maxIdleMs;
    this.logger = logger;
    this.budget = budget;
    this.streams = new Map();
    this.ffmpegAvailable = false;
    this.timer = null;
  }

  init() {
    const result = spawnSync(this.ffmpegPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    this.ffmpegAvailable = result.status === 0;
    this.timer = setInterval(() => this.cleanupIdle(), 30_000);
    this.timer.unref?.();
    return this.ffmpegAvailable;
  }

  activeCount() {
    let count = 0;
    for (const state of this.streams.values()) {
      if (state.starting || (state.process && state.process.exitCode === null)) {
        count += 1;
      }
    }
    return count;
  }

  directory(cameraId) {
    return path.join(this.dataDir, 'streams', cameraId);
  }

  state(cameraId) {
    return this.streams.get(cameraId) ?? null;
  }

  fail(state, message) {
    state.error = sanitizeErrorText(message);
    state.retryAt =
      Date.now() + Math.min(2_000 * 2 ** Math.max(state.attempts - 1, 0), 30_000);
    state.process = null;
    // RES-1：转码失败后必须归还名额，否则重试会被自己的名额卡住。
    this.releaseBudget(state);
  }

  async ensure(camera) {
    let state = this.streams.get(camera.id);
    if (state?.starting) {
      await state.starting;
      return state;
    }
    if (state?.process && state.process.exitCode === null) {
      state.lastAccess = Date.now();
      return state;
    }
    if (state?.error && Date.now() < state.retryAt) {
      throw new StreamError(state.error, {
        code: 'RETRY_BACKOFF',
        retryAfter: Math.ceil((state.retryAt - Date.now()) / 1000),
      });
    }
    if (!state || !state.process) {
      if (this.activeCount() >= this.maxStreams) {
        throw new StreamError('并发转码路数已达上限，请稍后再试', {
          code: 'STREAM_LIMIT',
          status: 503,
          retryAfter: 5,
        });
      }
      state = {
        cameraId: camera.id,
        process: null,
        lastAccess: Date.now(),
        attempts: (state?.attempts ?? 0) + 1,
        retryAt: 0,
        error: '',
        starting: null,
        // RES-1：该路转码持有的 FFmpeg 预算名额。
        budgetToken: null,
      };
      state.starting = this.launch(camera, state).finally(() => {
        state.starting = null;
      });
      this.streams.set(camera.id, state);
      await state.starting;
    }
    return state;
  }

  async launch(camera, state) {
    if (!this.ffmpegAvailable) {
      throw new StreamError('服务器未安装 FFmpeg，无法转码 RTSP', {
        code: 'FFMPEG_MISSING',
        status: 503,
      });
    }
    const directory = this.directory(camera.id);
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.mkdir(directory, { recursive: true });
    const playlist = path.join(directory, 'index.m3u8');
    const segmentPattern = path.join(directory, 'segment-%05d.ts');
    // 1 秒分片 + 4 片窗口，配合 hls.js 的 liveSyncDurationCount=2，
    // 端到端延迟可压到 2-4 秒；仍可用环境变量回退到更保守的配置。
    const segmentSeconds = Math.min(
      Math.max(Number(process.env.HLS_SEGMENT_SECONDS) || 1, 1),
      6,
    );
    const playlistSize = Math.min(
      Math.max(Number(process.env.HLS_PLAYLIST_SIZE) || 4, 3),
      12,
    );
    const copyVideo = process.env.FFMPEG_VIDEO_CODEC === 'copy';
    // rtsp_transport 只对 RTSP 输入有效；HTTP/HLS 源（网络摄像头、边缘网关演示源）不能加。
    const isRtsp = /^rtsps?:\/\//i.test(camera.sourceUrl);
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-rw_timeout',
      '15000000',
      ...(isRtsp ? ['-rtsp_transport', 'tcp'] : []),
      '-i',
      camera.sourceUrl,
      '-an',
      '-c:v',
      this.videoCodec,
      ...(copyVideo
        ? []
        : [
            '-preset',
            process.env.FFMPEG_PRESET || 'veryfast',
            '-tune',
            'zerolatency',
            '-g',
            '30',
            '-sc_threshold',
            '0',
            // 强制每个分片起点为关键帧，保证 independent_segments 与固定分片时长。
            '-force_key_frames',
            `expr:gte(t,n_forced*${segmentSeconds})`,
          ]),
      '-f',
      'hls',
      '-hls_time',
      String(segmentSeconds),
      '-hls_list_size',
      String(playlistSize),
      '-hls_flags',
      'delete_segments+omit_endlist+independent_segments+temp_file',
      '-hls_segment_filename',
      segmentPattern,
      playlist,
    ];
    // RES-1：转码进程同样占用 FFmpeg 预算名额，与检测/录像进程共享同一上限。
    // 拿不到名额时按「并发转码路数已达上限」返回 503，前端可提示稍后重试。
    let budgetToken = null;
    try {
      budgetToken = await this.budget.acquire({ label: `hls:${camera.id}` });
    } catch (error) {
      throw new StreamError(
        `FFmpeg 进程预算已满，请稍后重试：${sanitizeErrorText(error.message, 120)}`,
        { code: 'FFMPEG_BUDGET', status: 503, retryAfter: 5 },
      );
    }
    let child;
    try {
      child = spawn(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      this.budget.release(budgetToken);
      throw error;
    }
    state.budgetToken = budgetToken;
    state.process = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.once('error', (error) => {
      if (this.streams.get(camera.id) === state) {
        this.fail(state, `FFmpeg 启动失败：${error.message}`);
        this.logger.warn?.('stream_spawn_error', {
          cameraId: camera.id,
          message: sanitizeErrorText(error.message),
        });
      }
      // RES-1：启动失败也要归还名额。
      this.releaseBudget(state);
    });
    child.once('exit', (code) => {
      if (this.streams.get(camera.id) !== state) return;
      state.process = null;
      // RES-1：进程退出即归还名额。
      this.releaseBudget(state);
      if (code !== 0) {
        this.fail(
          state,
          `RTSP 转码中断（退出码 ${code}）${stderr ? `：${sanitizeErrorText(stderr)}` : ''}`,
        );
        this.logger.warn?.('stream_exit', {
          cameraId: camera.id,
          code,
          message: sanitizeErrorText(stderr),
        });
      }
    });
    state.lastAccess = Date.now();
  }

  async playlist(camera) {
    const state = await this.ensure(camera);
    const file = path.join(this.directory(camera.id), 'index.m3u8');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (state.error) {
        throw new StreamError(state.error, {
          code: 'STREAM_START_FAILED',
          retryAfter: Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000)),
        });
      }
      try {
        const content = await fsp.readFile(file, 'utf8');
        if (content.includes('#EXTINF')) {
          state.lastAccess = Date.now();
          state.attempts = 0;
          state.error = '';
          state.retryAt = 0;
          return content;
        }
      } catch {
        // 等待 FFmpeg 生成首个分片。
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    throw new StreamError('等待 RTSP 转码超时，请检查地址、网络和账号密码', {
      code: 'STREAM_TIMEOUT',
      retryAfter: 5,
    });
  }

  touch(cameraId) {
    const state = this.streams.get(cameraId);
    if (state) state.lastAccess = Date.now();
  }

  segmentPath(cameraId, segment) {
    if (!/^[a-zA-Z0-9._-]+\.ts$/.test(segment)) return null;
    return path.join(this.directory(cameraId), segment);
  }

  stop(cameraId) {
    const state = this.streams.get(cameraId);
    if (!state) return;
    const child = state.process;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    }
    // RES-1：停止即归还名额，不等进程真正退出（否则会白占预算 3 秒）。
    this.releaseBudget(state);
    this.streams.delete(cameraId);
  }

  /**
   * 归还该路转码占用的 FFmpeg 预算名额（幂等）。
   * @param {{budgetToken?: object|null}} state
   * @returns {void}
   */
  releaseBudget(state) {
    if (!state?.budgetToken) return;
    this.budget.release(state.budgetToken);
    state.budgetToken = null;
  }

  cleanupIdle() {
    const current = Date.now();
    for (const [cameraId, state] of this.streams) {
      if (!state.starting && current - state.lastAccess > this.maxIdleMs) {
        this.stop(cameraId);
      }
    }
  }

  stopAll() {
    for (const cameraId of [...this.streams.keys()]) this.stop(cameraId);
    if (this.timer) clearInterval(this.timer);
  }

  health() {
    return [...this.streams.entries()].map(([cameraId, state]) => ({
      cameraId,
      running: Boolean(state.process && state.process.exitCode === null),
      starting: Boolean(state.starting),
      attempts: state.attempts,
      error: state.error || null,
      lastAccess: state.lastAccess,
    }));
  }
}

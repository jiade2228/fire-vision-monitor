/**
 * 持续录像按需回放与导出（设计文档 §6）。
 *
 * 与索引层同样刻意保持「可离线测试」：选段、路径校验、concat 列表、
 * FFmpeg 参数构造都是纯函数；进程生命周期通过 spawnImpl 注入。
 * 只有真正点播/导出时才启动 FFmpeg，且默认没有任何常驻进程。
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { runFfmpegOnce } from './ffmpeg-once.mjs';

/** 单次回放/导出窗口上限：避免一次拼接过多段把内存与磁盘打满。 */
export const MAX_PLAYBACK_WINDOW_MS = 4 * 60 * 60 * 1000;
/** 单段 60s，4h 最多 240 段；留余量兼容短段。 */
export const MAX_PLAYBACK_SEGMENTS = 600;

// 相对路径严格限定为 <cameraId>/<YYYYMMDD>/<HHmmss>.ts，杜绝目录穿越。
const SEGMENT_REL = /^[A-Za-z0-9_-]+\/\d{8}\/\d{6}\.ts$/;
const HLS_FILE = /^(index\.m3u8|segment-\d{5}\.ts)$/;

/**
 * 解析并校验回放窗口。
 * @param {{from?: unknown, to?: unknown}} query
 * @param {{maxWindowMs?: number}} [options]
 * @returns {{from: number, to: number} | null}
 */
export function parsePlaybackWindow(query = {}, { maxWindowMs = MAX_PLAYBACK_WINDOW_MS } = {}) {
  const from = Number(query.from);
  const to = Number(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to <= from || to - from > maxWindowMs) return null;
  return { from, to };
}

/**
 * 选出覆盖窗口的段文件（按时间升序、按 file 去重、限流）。
 * @param {Array<{file: string, startedAt: number, endedAt: number}>} segments
 * @param {number} from
 * @param {number} to
 * @param {{maxSegments?: number}} [options]
 * @returns {string[]}
 */
export function selectSegments(
  segments,
  from,
  to,
  { maxSegments = MAX_PLAYBACK_SEGMENTS } = {},
) {
  const picked = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && segment.endedAt > from && segment.startedAt < to)
    .sort((a, b) => a.startedAt - b.startedAt);
  const seen = new Set();
  const files = [];
  for (const segment of picked) {
    if (seen.has(segment.file)) continue;
    seen.add(segment.file);
    files.push(segment.file);
    if (files.length >= maxSegments) break;
  }
  return files;
}

/**
 * 把索引内的相对路径解析成 rootDir 内的绝对路径；非法路径返回 null。
 * @param {string} rootDir
 * @param {string} file
 * @returns {string | null}
 */
export function safeSegmentPath(rootDir, file) {
  if (typeof file !== 'string' || !SEGMENT_REL.test(file)) return null;
  const root = path.resolve(rootDir);
  const full = path.resolve(root, ...file.split('/'));
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
  return full;
}

/** FFmpeg concat demuxer 列表：单引号转义，Windows 反斜杠归一为正斜杠。 */
export function concatListContent(files) {
  return `${files
    .map((file) => `file '${String(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n')}\n`;
}

/**
 * @param {{listFile: string, playlist: string, segmentPattern: string, seekSeconds?: number}} options
 *   seekSeconds 为相对 concat 输入起点的偏移；copy 模式下精度受关键帧限制。
 */
export function buildHlsArgs({ listFile, playlist, segmentPattern, seekSeconds = 0 }) {
  const offset = Number(seekSeconds) > 0 ? Number(seekSeconds).toFixed(3) : null;
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    // 输入侧 -ss 必须位于 -i 之前，才能从点击时刻而非首段开头起播。
    ...(offset ? ['-ss', offset] : []),
    '-i',
    listFile,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    // 0 = 保留全部分片并写入 ENDLIST，作为 VOD 点播而非直播流。
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    segmentPattern,
    playlist,
  ];
}

/** @param {{listFile: string, target: string}} options */
export function buildExportArgs({ listFile, target }) {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    target,
  ];
}

/**
 * 按需转码会话管理：每个会话独占一个目录与一个 FFmpeg 进程，
 * 空闲超时或超并发时回收。会话绑定 userId/cameraId/siteId，路由层再实时鉴权。
 */
export class PlaybackSessionManager {
  constructor({
    rootDir,
    continuousDir,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    spawnImpl = nodeSpawn,
    maxSessions = 8,
    idleMs = 90_000,
    logger = console,
    now = () => Date.now(),
  } = {}) {
    this.rootDir = rootDir;
    this.continuousDir = continuousDir;
    this.ffmpegPath = ffmpegPath;
    this.spawnImpl = spawnImpl;
    this.maxSessions = Math.min(Math.max(Number(maxSessions) || 8, 1), 64);
    this.idleMs = Math.min(Math.max(Number(idleMs) || 90_000, 10_000), 3_600_000);
    this.logger = logger;
    this.now = now;
    this.sessions = new Map();
  }

  /**
   * 创建一个回放会话。
   * @returns {Promise<{sessionId: string, playlist: string, from: number, to: number,
   *   segmentCount: number, expiresAt: number} | null>} 无可用段或启动失败返回 null
   */
  async create({ userId, cameraId, siteId, from, to, files, startAt, firstStartedAt }) {
    const absolute = (files || [])
      .map((file) => safeSegmentPath(this.continuousDir, file))
      .filter(Boolean);
    if (!absolute.length) return null;

    this.cleanupIdle();
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort(
        (a, b) => a.lastTouch - b.lastTouch,
      )[0];
      if (oldest) await this.stop(oldest.id);
    }

    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.join(this.rootDir, id);
    const listFile = path.join(dir, 'list.txt');
    const playlist = path.join(dir, 'index.m3u8');
    const segmentPattern = path.join(dir, 'segment-%05d.ts');
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(listFile, concatListContent(absolute), 'utf8');
    } catch (error) {
      this.logger?.warn?.('recording_playback_prepare_failed', { message: error.message });
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return null;
    }

    const seekSeconds =
      Number.isFinite(startAt) && Number.isFinite(firstStartedAt)
        ? Math.max(0, (startAt - firstStartedAt) / 1000)
        : 0;
    let child;
    try {
      child = this.spawnImpl(
        this.ffmpegPath,
        buildHlsArgs({ listFile, playlist, segmentPattern, seekSeconds }),
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
      );
    } catch (error) {
      this.logger?.warn?.('recording_playback_spawn_failed', { message: error.message });
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return null;
    }

    const touched = this.now();
    const session = {
      id,
      userId,
      cameraId,
      siteId: siteId ?? null,
      from,
      to,
      dir,
      child,
      segmentCount: absolute.length,
      lastTouch: touched,
      expiresAt: touched + this.idleMs,
      // pending → ready / failed；失败原因供前端展示，不再让 hls.js 无限重试。
      state: 'pending',
      error: null,
    };
    this.sessions.set(id, session);
    const markFailed = (message) => {
      if (this.sessions.get(id) !== session) return;
      session.state = 'failed';
      session.error = message;
      this.logger?.warn?.('recording_playback_process_failed', { sessionId: id, message });
    };
    // 必须挂 error 监听，否则可执行文件缺失会变成 uncaughtException。
    child.on?.('error', (error) => markFailed(`回放转码启动失败：${error.message}`));
    child.on?.('exit', (code) => {
      if (this.sessions.get(id) !== session) return;
      if (code === 0) session.state = 'ready';
      else markFailed(`回放转码进程退出（code=${code}）`);
    });
    return {
      sessionId: id,
      playlist: `/api/recordings/play/${id}/index.m3u8`,
      from,
      to,
      segmentCount: absolute.length,
      expiresAt: touched + this.idleMs,
    };
  }

  /** 命中即续期；过期会话立即回收并返回 null。 */
  touch(sessionId) {
    const session = this.sessions.get(String(sessionId ?? ''));
    if (!session) return null;
    const at = this.now();
    if (at >= session.expiresAt) {
      // P0-2：裸 void 的 rejection 会变成未捕获异常并终止进程，显式兜住。
      void this.stop(session.id).catch(() => undefined);
      return null;
    }
    session.lastTouch = at;
    session.expiresAt = at + this.idleMs;
    return session;
  }

  /** @returns {{state: string, error: string|null} | null} 会话转码状态（不续期）。 */
  sessionStatus(sessionId) {
    const session = this.sessions.get(String(sessionId ?? ''));
    if (!session) return null;
    return { state: session.state, error: session.error };
  }

  /** @returns {string | null} 会话目录内允许访问的文件绝对路径。 */
  filePath(session, name) {
    if (!session || !HLS_FILE.test(String(name ?? ''))) return null;
    return path.join(session.dir, String(name));
  }

  cleanupIdle() {
    const at = this.now();
    for (const session of [...this.sessions.values()]) {
      // P0-2：裸 void 的 rejection 会变成未捕获异常并终止进程，显式兜住。
      if (at >= session.expiresAt) void this.stop(session.id).catch(() => undefined);
    }
  }

  async stop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      session.child?.kill?.('SIGKILL');
    } catch {
      // ignore
    }
    await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async stopAll() {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
  }

  status() {
    return { active: this.sessions.size, maxSessions: this.maxSessions, idleMs: this.idleMs };
  }
}

/**
 * 把选中的 TS 段拼接为单个 MP4（copy、不转码），供下载。
 * @returns {Promise<string | null>} 生成文件的绝对路径；失败返回 null
 */
export async function exportRecordingToMp4({
  files,
  continuousDir,
  exportDir,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  spawnImpl = nodeSpawn,
  timeoutMs = 120_000,
}) {
  const absolute = (files || [])
    .map((file) => safeSegmentPath(continuousDir, file))
    .filter(Boolean);
  if (!absolute.length) return null;

  const id = crypto.randomBytes(12).toString('hex');
  const target = path.join(exportDir, `${id}.mp4`);
  const listFile = path.join(exportDir, `${id}.txt`);
  try {
    await fsp.mkdir(exportDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(listFile, concatListContent(absolute), 'utf8');
  } catch {
    return null;
  }

  const result = await runFfmpegOnce({
    spawnImpl,
    ffmpegPath,
    args: buildExportArgs({ listFile, target }),
    timeoutMs,
    failureValue: null,
    onExit: (code) => {
      if (code !== 0) return null;
      try {
        return fs.existsSync(target) ? target : null;
      } catch {
        return null;
      }
    },
  });
  await fsp.rm(listFile, { force: true }).catch(() => undefined);
  if (!result) await fsp.rm(target, { force: true }).catch(() => undefined);
  return result;
}

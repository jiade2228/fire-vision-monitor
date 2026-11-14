/**
 * FFmpeg 输入侧参数（集中一处，避免四个调用点各写一份后再次漂移）。
 *
 * 为什么 RTSP 与非 RTSP 要分开：
 *   - `-rw_timeout` 是 URLContext（http/ftp 等协议）的选项，RTSP 输入不接受，
 *     FFmpeg 会直接以退出码 1 报 `Option rw_timeout not found.`。
 *   - RTSP 的读超时选项在不同版本里换过名字（v1.2.7 线上事故的根因）：
 *       * FFmpeg 4.x：RTSP demuxer 的 `-timeout` 是 `listen_timeout` 的废弃别名，
 *         单位**秒**，且会把客户端切成**监听模式**去 bind 端口，连已有流时报
 *         `Unable to open RTSP for listening ... Address already in use`；
 *         客户端 socket 读超时要用 `-stimeout`（微秒）。
 *       * FFmpeg 5.0 起：`stimeout` 更名为 `timeout`（微秒），`timeout` 才是
 *         真正读超时；4.x 的那层语义已被 `listen_timeout` 取代。
 *     因此不能写死一个常量，必须按版本（或能力）分流。
 *   - 非 RTSP（HLS/HTTP 摄像头、边缘网关）继续使用 `-rw_timeout`。
 */

import { spawnSync } from 'node:child_process';

/** FFmpeg 主版本号 ≤ 4 时，RTSP 读超时用 `-stimeout`。 */
const STIMEOUT_MAX_MAJOR = 4;

let cachedMajor;
let cachedRtspOption;

/**
 * 从 `ffmpeg -version` 输出解析主版本号。
 *
 * 兼容 `4.4.2-0ubuntu0.22.04.1`、`n4.4.2`、`6.1.1-full_build` 等常见形态；
 * 解析不出（如纯 git 构建 `N-109642-g...`）时返回 null，交由能力探测兜底。
 *
 * @param {string} versionText `ffmpeg -version` 的标准输出。
 * @returns {number|null} 主版本号。
 */
export function parseFfmpegMajorVersion(versionText) {
  const matched = String(versionText ?? '').match(/ffmpeg version\s+(?:n)?(\d+)\./i);
  return matched ? Number(matched[1]) : null;
}

/**
 * 按主版本号选择 RTSP 读超时选项名。
 *
 * @param {number|null|undefined} major 主版本号。
 * @returns {'stimeout'|'timeout'|null} 无法判定时返回 null。
 */
export function rtspTimeoutOptionForMajor(major) {
  if (!Number.isFinite(major)) return null;
  return Number(major) <= STIMEOUT_MAX_MAJOR ? 'stimeout' : 'timeout';
}

function runFfmpeg(args, ffmpegPath) {
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0 ? String(result.stdout ?? '') : '';
}

/**
 * 探测一次 FFmpeg 主版本号（带缓存）。
 *
 * @param {{ffmpegPath?: string}} [options]
 * @returns {number|null}
 */
export function detectFfmpegMajorVersion({
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
} = {}) {
  if (cachedMajor !== undefined) return cachedMajor;
  cachedMajor = parseFfmpegMajorVersion(runFfmpeg(['-hide_banner', '-version'], ffmpegPath));
  return cachedMajor;
}

/**
 * 探测 RTSP 读超时该用哪个选项（带缓存）。
 *
 * 先按版本判定；版本解析不出来时退回 `ffmpeg -h demuxer=rtsp` 的能力清单：
 * 含 `stimeout` 即为 4.x 语义，否则按 5.x+ 的 `timeout` 处理。
 *
 * @param {{ffmpegPath?: string}} [options]
 * @returns {'stimeout'|'timeout'}
 */
export function detectRtspTimeoutOption({
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
} = {}) {
  if (cachedRtspOption !== undefined) return cachedRtspOption;
  const byVersion = rtspTimeoutOptionForMajor(detectFfmpegMajorVersion({ ffmpegPath }));
  if (byVersion) {
    cachedRtspOption = byVersion;
    return cachedRtspOption;
  }
  const help = runFfmpeg(['-hide_banner', '-h', 'demuxer=rtsp'], ffmpegPath);
  cachedRtspOption = /\bstimeout\b/.test(help) ? 'stimeout' : 'timeout';
  return cachedRtspOption;
}

/** 清空探测缓存（仅测试使用）。 */
export function resetFfmpegInputDetection() {
  cachedMajor = undefined;
  cachedRtspOption = undefined;
}

/**
 * 生成输入超时参数（纯函数；未显式给版本/选项时才走一次带缓存的探测）。
 *
 * @param {object} [options]
 * @param {boolean} [options.isRtsp] 是否 RTSP 输入。
 * @param {number} [options.timeoutUs] 超时微秒数。
 * @param {number|null} [options.majorVersion] 显式指定 FFmpeg 主版本（测试用）。
 * @param {'stimeout'|'timeout'} [options.rtspOption] 显式指定 RTSP 选项名（测试用）。
 * @returns {string[]} 可直接展开进 ffmpeg/ffprobe 参数数组
 */
export function inputTimeoutArgs({
  isRtsp = false,
  timeoutUs = 15_000_000,
  majorVersion,
  rtspOption,
} = {}) {
  if (!isRtsp) return ['-rw_timeout', String(timeoutUs)];
  const option =
    rtspOption ?? rtspTimeoutOptionForMajor(majorVersion) ?? detectRtspTimeoutOption();
  // 4.x 用 -stimeout（微秒）；5.x+ 用 -timeout（微秒）。
  // 任何情况下都不能回落到 -rw_timeout，也不能在 4.x 用裸 -timeout（会进监听模式）。
  return [option === 'stimeout' ? '-stimeout' : '-timeout', String(timeoutUs)];
}

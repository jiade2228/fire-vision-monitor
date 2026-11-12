/**
 * FFmpeg 输入侧参数（集中一处，避免四个调用点各写一份后再次漂移）。
 *
 * 为什么区分 RTSP：
 *   - `-rw_timeout` 是 URLContext（http/ftp 等协议）的选项，RTSP 输入不接受，
 *     FFmpeg 会直接以退出码 1 报 `Option rw_timeout not found.`，转码必然失败。
 *   - RTSP 的读超时要走 demuxer 的 `-timeout`（微秒）；本项目固定
 *     `-rtsp_transport tcp`，因此 `-timeout` 同时生效于底层 tcp。
 *   - 非 RTSP（HLS/HTTP 摄像头、边缘网关）继续使用 `-rw_timeout`。
 */

/**
 * 生成输入超时参数（纯函数）。
 * @param {{isRtsp?: boolean, timeoutUs?: number}} options
 * @returns {string[]} 可直接展开进 ffmpeg/ffprobe 参数数组
 */
export function inputTimeoutArgs({ isRtsp = false, timeoutUs = 15_000_000 } = {}) {
  return isRtsp ? ['-timeout', String(timeoutUs)] : ['-rw_timeout', String(timeoutUs)];
}

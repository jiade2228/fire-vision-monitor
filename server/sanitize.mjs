/**
 * 统一的凭据脱敏工具（单一实现，全项目共用）。
 *
 * 背景：FFmpeg / ffprobe 在打开 RTSP 失败时会把输入 URL 原样打进 stderr，
 * 例如：
 *   [rtsp @ 0x...] Opening 'rtsp://admin:Sup3rSecret@192.168.1.64:554/stream1' failed
 * 这段文本此前被存进 `lastError`，再经 `/api/detection/status`、`/api/system`
 * 等接口返回前端 —— 于是摄像头密码出现在接口响应、浏览器页面与运维工单里。
 *
 * 为什么不能各写各的正则：按 `@` 匹配的写法在密码本身含 `@` 时
 * （rtsp://us@er:pass@host）只能匹配到第一个 `@`，残余密码片段会漏出去。
 * 这里统一按 URL 结构整体替换 userinfo。
 */

/**
 * 抹除文本中所有 URL 的 userinfo（账号密码段）。
 *
 * @param {unknown} value 原始文本。
 * @returns {string} 脱敏后的文本（结构不变，仅 userinfo 变为 `***`）。
 */
export function stripUserinfo(value) {
  return String(value ?? '').replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)@/gi,
    (_match, scheme) => `${scheme}***@`,
  );
}

/**
 * 脱敏错误文本：抹除 userinfo → 压平空白 → 截断。
 *
 * @param {unknown} value 原始文本。
 * @param {number} [limit=500] 最大保留长度。
 * @returns {string} 脱敏后的文本。
 */
export function sanitizeErrorText(value, limit = 500) {
  return stripUserinfo(value).replace(/\s+/g, ' ').slice(0, limit);
}

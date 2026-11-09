/**
 * API 层 404 的唯一出口：统一响应形态为 `{ error: <文案> }` JSON，
 * 各调用点保留原有中文文案，避免逐路由各写一份 res.status(404).json(...)。
 *
 * 边界：媒体二进制端点（HLS 分片、抓图、短视频、预览图）必须保持空体或
 * 纯文本 404 —— hls.js / <img> / <video> 会把 JSON 体当作媒体数据解析失败。
 * 这类端点不使用本 helper，形态差异是协议需要而非遗漏。
 *
 * @param {import('express').Response} res
 * @param {string} [message] 业务文案
 */
export function apiNotFound(res, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

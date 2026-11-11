/**
 * 表单输入的数值/日期校验工具。
 *
 * 背景：`<input type="number">` 的 `event.target.value` 在用户清空时是空串，
 * `Number('')` 得到 **0**（不是 NaN），直接写回 state 会把 0 当成合法值提交；
 * 粘贴越界值也只靠 HTML 的 min/max 原生约束，前端逻辑层没有防线。
 * 这里提供统一的解析函数：非法输入返回 null，调用方据此拒绝写入 state。
 */

/**
 * 解析受限范围内的整数。
 *
 * @param {string|number} raw 输入值。
 * @param {number} min 下界（含）。
 * @param {number} max 上界（含）。
 * @returns {number|null} 合法整数；非法（含空串、NaN、越界）时 null。
 */
export function parseIntInRange(
  raw: string | number,
  min: number,
  max: number,
): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/**
 * 解析 TCP/UDP 端口。
 *
 * @param {string|number} raw 输入值。
 * @returns {number|null} 1-65535 的端口；非法时 null。
 */
export function parsePort(raw: string | number): number | null {
  return parseIntInRange(raw, 1, 65535);
}

/**
 * 解析 YYYY-MM-DD 日期字符串。
 *
 * @param {string} raw 输入值。
 * @returns {{year:number, month:number, day:number}|null} 合法日期分量；非法时 null。
 */
export function parseIsoDate(raw: string): {
  year: number;
  month: number;
  day: number;
} | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 用 Date 校验「日历上是否真的存在这一天」（如 2024-02-31）。
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

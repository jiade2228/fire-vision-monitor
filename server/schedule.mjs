/**
 * 点位布防时间表：按星期 + 时段决定该点位当前是否参与检测。
 *
 * 存储形态（cameras.schedule，JSON 字符串，NULL 表示 7×24 全天候布防）：
 *   { "windows": [{ "days": [0,1,2,3,4], "start": "08:00", "end": "20:00" }] }
 * days 取 0-6（0=周日）；start/end 为当日内的 HH:mm。
 * 跨零点时段（如 22:00-06:00）自动支持：end < start 时视为跨日。
 *
 * 布防语义：schedule 为空 / 解析失败 / windows 为空数组 → 全天候布防（默认行为，
 * 与既有部署保持一致）；仅当存在有效窗口且当前时间不在任何窗口内才视为撤防。
 */

/**
 * 上海时区（固定 UTC+8，无夏令时）——与告警日聚合、每日摘要、通知文案同源。
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 解析并规范化布防时间表；非法输入一律回退为「全天候布防」。
 *
 * @param {string|null|undefined} raw cameras.schedule 原始 JSON。
 * @returns {{always: true} | {always: false, windows: Array<{days: number[], start: number, end: number}>}}
 *   always=true 表示全天候布防；否则 windows 内时间已换算为当日分钟数，
 *   end < start 表示跨零点（end 加了一天的分钟数，比较时直接用数值区间）。
 */
export function parseSchedule(raw) {
  if (!raw) return { always: true };
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { always: true };
  }
  const windows = [];
  for (const item of Array.isArray(parsed?.windows) ? parsed.windows : []) {
    const days = Array.isArray(item?.days)
      ? [...new Set(item.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [0, 1, 2, 3, 4, 5, 6];
    const start = parseHHmm(item?.start);
    const end = parseHHmm(item?.end);
    if (start === null || end === null || start === end) continue;
    windows.push({
      days,
      start,
      // 跨零点：结束时间小于开始时间时加一天，数值区间比较即可覆盖跨日。
      end: end < start ? end + 24 * 60 : end,
    });
  }
  if (!windows.length) return { always: true };
  return { always: false, windows };
}

function parseHHmm(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * 序列化布防时间表为入库 JSON；空值/全天候布防存 NULL。
 *
 * 同时接受两种输入形态：
 * - 原始对象/字符串（start/end 为 "HH:mm"）
 * - parseSchedule 解析后的形态（start/end 为分钟数，跨零点 end 已加 1440）
 * 输出统一为 { windows: [{ days, start: "HH:mm", end: "HH:mm" }] }，
 * 跨零点窗口以 end < start 表达，parseSchedule 可无损回读。
 *
 * @param {object|string|null|undefined} schedule 点位对象上的 schedule。
 * @returns {string|null} JSON 字符串；无需布控时段时为 null。
 */
export function serializeSchedule(schedule) {
  if (!schedule) return null;
  if (typeof schedule === 'string') {
    return parseSchedule(schedule).always ? null : schedule;
  }
  if (schedule.always) return null;
  const windows = [];
  for (const item of Array.isArray(schedule.windows) ? schedule.windows : []) {
    const days = Array.isArray(item?.days)
      ? [...new Set(item.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    const start = typeof item?.start === 'string' ? parseHHmm(item.start) : item?.start;
    const end = typeof item?.end === 'string' ? parseHHmm(item.end) : item?.end;
    if (start === null || end === null || start === end) continue;
    const endRaw = end > 24 * 60 ? end - 24 * 60 : end;
    windows.push({
      days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
      start: minutesToHHmm(start),
      end: minutesToHHmm(endRaw),
    });
  }
  if (!windows.length) return null;
  return JSON.stringify({ windows });
}

function minutesToHHmm(minutes) {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * 把解析后的时间表转成前端形态（start/end 为 "HH:mm" 字符串）。
 *
 * 存储层（cameraRowToObject）持有的是分钟数形态，供 isArmedNow 判断；
 * 前端 input[type=time] 需要字符串形态，直接下发数字会导致编辑已有布防点位时输入框失效。
 *
 * @param {{always: true} | {always: false, windows: Array<object>} | null} schedule 解析后的时间表。
 * @returns {{windows: Array<{days: number[], start: string, end: string}>} | null}
 */
export function toClientSchedule(schedule) {
  const stored = serializeSchedule(schedule);
  return stored ? JSON.parse(stored) : null;
}

/**
 * 判断点位在指定时刻是否处于布防状态。
 *
 * 时区口径：统一按 **Asia/Shanghai（固定 +8，无夏令时）** 判定。
 * 原实现用 `Date` 的本地时区 getter，而告警日聚合、每日值守摘要、
 * 通知时间格式化三处都按 UTC+8 处理——同一进程内存在两套时区语义，
 * 容器（TZ=UTC）部署时布防窗口会整体偏移 8 小时。
 *
 * @param {{always: true} | {always: false, windows: Array<object>}} schedule parseSchedule 的返回值。
 * @param {Date} [at] 判断时刻（默认当前时间）。
 * @returns {boolean} true=布防（参与检测），false=撤防（跳过检测，播放不受影响）。
 */
export function isArmedNow(schedule, at = new Date()) {
  if (!schedule || schedule.always) return true;
  // 偏移到 UTC+8 后用 UTC getter 取「上海墙上时间」。
  const shifted = new Date(at.getTime() + SHANGHAI_OFFSET_MS);
  const day = shifted.getUTCDay();
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  for (const window of schedule.windows) {
    // 当日窗口：跨零点窗口（end > 1440）的当日部分到午夜为止。
    if (
      window.days.includes(day) &&
      minute >= window.start &&
      minute < Math.min(window.end, 24 * 60)
    ) {
      return true;
    }
    // 前一日的跨零点窗口延续到今天凌晨：如周日 22:00-06:00 覆盖周一 00:00-05:59。
    if (
      window.end > 24 * 60 &&
      minute < window.end - 24 * 60 &&
      window.days.includes((day + 6) % 7)
    ) {
      return true;
    }
  }
  return false;
}

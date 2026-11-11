/**
 * 业务时区工具：全平台统一按 **Asia/Shanghai（固定 UTC+8，无夏令时）** 计算。
 *
 * 背景：项目里「告警按天聚合」「每日值守摘要」「通知时间格式化」「布防时段判定」
 * 都要用业务时区。改造前这些地方分别用 `date(...,'+8 hours')`、
 * `Date.UTC(...) - 8h`、`Intl.DateTimeFormat('Asia/Shanghai')` 和本地时区 getter
 * 四种不同写法实现，容器（TZ=UTC）部署时口径不一致——最典型的是布防时间表
 * 比其它时间显示整体偏移 8 小时。收敛到本模块后只有一处需要改。
 */

/** 上海时区偏移（毫秒，固定 +8 小时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把 epoch 毫秒拆成上海时区的日历字段。
 *
 * @param {number} ts epoch 毫秒时间戳。
 * @returns {{y:number, m:number, d:number, hh:number, mm:number, ss:number}}
 *   y=年、m=月（1-12）、d=日、hh=时、mm=分、ss=秒。
 */
export function toShanghaiParts(ts) {
  const shifted = new Date(Number(ts) + SHANGHAI_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
  };
}

/**
 * 上海时区某日的 00:00 对应的 epoch 毫秒。
 *
 * @param {{y:number, m:number, d:number}} parts 年月日。
 * @returns {number} epoch 毫秒。
 */
export function shanghaiDayStart(parts) {
  return Date.UTC(parts.y, parts.m - 1, parts.d) - SHANGHAI_OFFSET_MS;
}

/**
 * 上海时区的「日期键」（YYYY-MM-DD），用于按天去重与分组。
 *
 * @param {number} ts epoch 毫秒时间戳。
 * @returns {string} YYYY-MM-DD。
 */
export function shanghaiDateKey(ts) {
  const parts = toShanghaiParts(ts);
  return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

/**
 * 两位补零。
 * @param {number|string} value 数值。
 * @returns {string} 补零后的字符串。
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

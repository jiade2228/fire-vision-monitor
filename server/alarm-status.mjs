/**
 * 告警状态口径转换（唯一映射点）。
 *
 * 背景（v1.2.7 验收 BUG-2）：
 *   数据库 `alarms.status` 用 `pending / confirmed / false / archived`，
 *   而对外契约（接口文档、界面标签、筛选参数）用 `pending / confirmed / closed`。
 *   此前 `archived` 同时出现在响应体与状态机目标值里，客户端 PATCH `closed` 会被拒，
 *   筛选 `closed` 又只对列表生效，两套口径并存。
 *
 * 约定：
 *   - **对外**只暴露 `pending / confirmed / closed`（`false` 继续原样返回，界面用它区分误报）；
 *   - **落库**继续用 `archived`（不改表结构与历史数据）；
 *   - 入参 `closed` 与历史别名 `archived` 都接受，统一落到 `archived`。
 */

/** 对外暴露的处置状态（筛选/文档口径）。 */
export const PUBLIC_ALARM_STATUSES = Object.freeze(['pending', 'confirmed', 'closed']);

/**
 * 关闭告警前必须完成的四步应急处置清单（顺序与界面一致）。
 *
 * 数据库没有为四步分别建列：四步统一存放在 `alarms.steps_json`
 * （布尔数组，下标 0-3，见 server/schema.mjs）。这里的字段名与下标一一对应，
 * 用于 PATCH 关闭校验在 409 响应里回传缺失项，便于前端提示。
 */
export const CLOSE_CHECKLIST_FIELDS = Object.freeze([
  'notify_fire_control',
  'start_smoke_exhaust',
  'broadcast_evacuation',
  'call_119',
]);

/**
 * 计算未完成的清单字段名（按界面顺序）。
 *
 * @param {unknown} steps 告警 steps（`steps_json` 解析后的布尔数组）。
 * @returns {string[]} 缺失字段名；空数组表示四步均已完成。
 */
export function missingCloseChecklistFields(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return CLOSE_CHECKLIST_FIELDS.filter((_, index) => list[index] !== true);
}

/**
 * 设备健康告警 / 误报归档所需的单项确认。
 *
 * 这两类告警在语义上不适用火情四步，只要求一个「已到现场确认」；
 * 复用 `steps_json` 的第 5 位（下标 4）存储，避免新增数据库列。
 */
export const CLOSE_CONFIRM_STEP_INDEX = 4;
export const CLOSE_CONFIRM_FIELD = 'close_confirmed';

/**
 * 计算关闭告警前缺失的处置项。
 *
 * @param {{status?: string, level?: string, steps?: unknown}} alarm 告警对象。
 * @returns {{error: string, missing: string[]}|null} null 表示允许关闭。
 */
export function closeAlarmBlock(alarm) {
  if (!alarm) return null;
  if (alarm.status === 'confirmed' && (alarm.level === 'fire' || alarm.level === 'smoke')) {
    const missing = missingCloseChecklistFields(alarm.steps);
    return missing.length
      ? { error: '应急处置清单未完成，无法关闭告警', missing }
      : null;
  }
  // 设备健康告警（offline / camera_abnormal）归档，以及误报 false → archived。
  if (alarm.status === 'confirmed' || alarm.status === 'false') {
    const steps = Array.isArray(alarm.steps) ? alarm.steps : [];
    return steps[CLOSE_CONFIRM_STEP_INDEX] === true
      ? null
      : { error: '处置确认未完成，无法关闭告警', missing: [CLOSE_CONFIRM_FIELD] };
  }
  return null;
}

const TO_INTERNAL = {
  pending: 'pending',
  confirmed: 'confirmed',
  false: 'false',
  closed: 'archived',
  archived: 'archived',
};

const TO_PUBLIC = {
  pending: 'pending',
  confirmed: 'confirmed',
  false: 'false',
  closed: 'closed',
  archived: 'closed',
};

/**
 * 对外状态 → 落库状态。
 *
 * @param {unknown} status 请求里传来的状态。
 * @returns {string|null} 无法识别的状态返回 null。
 */
export function toInternalAlarmStatus(status) {
  const key = String(status ?? '');
  return Object.prototype.hasOwnProperty.call(TO_INTERNAL, key) ? TO_INTERNAL[key] : null;
}

/**
 * 落库状态 → 对外状态。
 *
 * @param {unknown} status 数据库/内部状态。
 * @returns {unknown} 未知值原样返回，避免把脏数据也改写。
 */
export function toPublicAlarmStatus(status) {
  const key = String(status ?? '');
  return Object.prototype.hasOwnProperty.call(TO_PUBLIC, key) ? TO_PUBLIC[key] : status;
}

/**
 * 序列化告警对象：只转换 `status` 字段，其它字段与引用保持不变。
 *
 * @template T
 * @param {T} alarm 告警对象。
 * @returns {T} 对外告警对象。
 */
export function toPublicAlarm(alarm) {
  if (!alarm || typeof alarm !== 'object') return alarm;
  const status = toPublicAlarmStatus(alarm.status);
  return status === alarm.status ? alarm : { ...alarm, status };
}

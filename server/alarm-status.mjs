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

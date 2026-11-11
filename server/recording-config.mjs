/**
 * 持续录像保护窗口等共享配置。
 *
 * store 层（createAlarm / updateAlarm）与装配层共用同一份定义，
 * 避免「创建时保护的窗口」与「误报时解除的窗口」各算一份而漂移。
 */
/**
 * 钳制口径必须与 detection-engine.mjs 的 clipSeconds 一致（2-60 秒）：
 * 旧写法此处无钳制，ALARM_CLIP_SECONDS=9999 时实际短视频仍是 60s，
 * 但保护窗口尾部按 10059s 计算，被放大约 168 倍，配额淘汰长期失效。
 */
const rawClipSeconds = Number(process.env.ALARM_CLIP_SECONDS);
const alarmClipSeconds = Number.isFinite(rawClipSeconds) && rawClipSeconds > 0
  ? Math.min(Math.max(Math.round(rawClipSeconds), 2), 60)
  : 10;

/** 告警前 120s 至告警后「短视频时长 + 60s」的录像段免于水位淘汰。 */
export const RECORDING_PROTECT_LEAD_MS = 120_000;
export const RECORDING_PROTECT_TAIL_MS = (alarmClipSeconds + 60) * 1000;

/**
 * @param {number} createdAt 告警创建时刻（epoch ms）
 * @returns {{from: number, to: number}}
 */
export function protectionWindow(createdAt) {
  return {
    from: createdAt - RECORDING_PROTECT_LEAD_MS,
    to: createdAt + RECORDING_PROTECT_TAIL_MS,
  };
}

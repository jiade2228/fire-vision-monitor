/**
 * 持续录像保护窗口等共享配置。
 *
 * store 层（createAlarm / updateAlarm）与装配层共用同一份定义，
 * 避免「创建时保护的窗口」与「误报时解除的窗口」各算一份而漂移。
 */
const alarmClipSeconds = Number(process.env.ALARM_CLIP_SECONDS) || 10;

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

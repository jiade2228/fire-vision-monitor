import type { AlarmLevel, AlarmStatus } from '../types';

export const EMERGENCY_STEPS = [
  '通知消防中控室与值班领导',
  '远程启动排烟与喷淋设备',
  '开启应急疏散广播并清场',
  '拨打 119 并引导消防车辆',
];

/** 设备健康告警归档所需的单项确认在 steps 中的下标（0-3 为火情四步）。 */
export const CLOSE_CONFIRM_STEP_INDEX = 4;

export const STATUS_META: Record<AlarmStatus, { label: string; tone: string }> = {
  pending: { label: '待处置', tone: 'danger' },
  confirmed: { label: '处置中', tone: 'warn' },
  false: { label: '已判误报', tone: 'muted' },
  closed: { label: '已关闭', tone: 'ok' },
  archived: { label: '已归档', tone: 'ok' },
};

export const LEVEL_META: Record<AlarmLevel, { label: string; caption: string }> = {
  fire: { label: '火焰', caption: '明火识别' },
  smoke: { label: '烟雾', caption: '早期烟雾识别' },
  offline: { label: '设备离线', caption: '视频流中断' },
  camera_abnormal: { label: '画面异常', caption: '遮挡/过暗/过曝' },
};

export const LEVEL_LABELS: Record<AlarmLevel, string> = {
  fire: '火焰',
  smoke: '烟雾',
  offline: '设备离线',
  camera_abnormal: '画面异常',
};

export function levelLabel(level: AlarmLevel): string {
  return LEVEL_LABELS[level] ?? '告警';
}

/**
 * 安全取告警级别元信息。
 *
 * LEVEL_META 的键来自编译期的联合类型，但运行时值来自服务端数据库——
 * 后端新增一种等级（或库里残留迁移前的旧值）时，直接下标会取到 undefined，
 * 随后访问 `.label` 抛 TypeError 让整页白屏。这里统一兜底。
 *
 * @param {string} level 告警级别。
 * @returns {{label: string, caption: string}} 元信息（未知级别回退为原值）。
 */
export function getLevelMeta(level: string): { label: string; caption: string } {
  return (
    LEVEL_META[level as AlarmLevel] ?? { label: level || '告警', caption: '未知类型' }
  );
}

/**
 * 安全取处置状态元信息（未知状态回退为中性样式与原值）。
 *
 * @param {string} status 处置状态。
 * @returns {{label: string, tone: string}} 元信息。
 */
export function getStatusMeta(status: string): { label: string; tone: string } {
  return STATUS_META[status as AlarmStatus] ?? { label: status || '未知', tone: 'muted' };
}

export function confidenceTone(confidence: number): string {
  if (confidence >= 85) return 'high';
  if (confidence >= 70) return 'mid';
  return 'low';
}
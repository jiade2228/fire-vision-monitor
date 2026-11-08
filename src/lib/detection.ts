import type { AlarmLevel, AlarmStatus } from '../types';

export const EMERGENCY_STEPS = [
  '通知消防中控室与值班领导',
  '远程启动排烟与喷淋设备',
  '开启应急疏散广播并清场',
  '拨打 119 并引导消防车辆',
];

export const STATUS_META: Record<AlarmStatus, { label: string; tone: string }> = {
  pending: { label: '待处置', tone: 'danger' },
  confirmed: { label: '处置中', tone: 'warn' },
  false: { label: '已判误报', tone: 'muted' },
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

export function confidenceTone(confidence: number): string {
  if (confidence >= 85) return 'high';
  if (confidence >= 70) return 'mid';
  return 'low';
}
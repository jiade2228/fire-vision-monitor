import type { Alarm } from '../types';
import { LEVEL_META, STATUS_META } from './detection';

const pad = (value: number) => String(value).padStart(2, '0');

function formatExportTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function csvCell(value: string | number | undefined): string {
  let text = value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export interface AuditLogExportRow {
  createdAt: number;
  username?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string;
  ip?: string;
}

/** 审计日志导出：与告警导出同一套公式注入防护与 BOM 头。 */
export function downloadAuditCsv(
  logs: AuditLogExportRow[],
  actionLabels: Record<string, string>,
  name: string,
): void {
  const headers = ['时间', '账号', '动作', '对象类型', '对象', '详情', 'IP'];
  const rows = logs.map((log) => [
    formatExportTime(log.createdAt),
    log.username ?? '系统',
    actionLabels[log.action] ?? log.action,
    log.targetType ?? '',
    log.targetId ?? '',
    log.detail ?? '',
    log.ip ?? '',
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  anchor.href = url;
  anchor.download = `${name}-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadAlarmsCsv(alarms: Alarm[], name: string): void {
  const headers = [
    '告警编号',
    '通道编号',
    '通道名称',
    '区域',
    '识别类型',
    '置信度(%)',
    '触发时间',
    '处置状态',
    '确认时间',
    '关闭时间',
    '响应耗时(秒)',
    '应急步骤完成数',
    '值守备注',
  ];
  const rows = alarms.map((alarm) => [
    alarm.id,
    alarm.cameraId,
    alarm.cameraName,
    alarm.zone,
    LEVEL_META[alarm.level].label,
    alarm.confidence,
    formatExportTime(alarm.createdAt),
    STATUS_META[alarm.status].label,
    formatExportTime(alarm.confirmedAt),
    formatExportTime(alarm.closedAt),
    alarm.confirmedAt ? Math.round((alarm.confirmedAt - alarm.createdAt) / 1000) : '',
    `${alarm.steps.filter(Boolean).length}/${alarm.steps.length}`,
    alarm.note ?? '',
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  anchor.href = url;
  anchor.download = `${name}-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

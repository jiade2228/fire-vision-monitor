const pad = (value: number) => String(value).padStart(2, '0');

export function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function formatDate(ts: number): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${pad(rest)} 秒`;
}

export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return `${Math.round(ms / 1000)}s`;
}
/**
 * 字节数格式化（全项目唯一实现）。
 *
 * 此前 AdminPanel 与 RecordingTimeline 各有一份：一个从 `0 B` 起并做
 * NaN/负数防护，另一个从 `0 KB` 起且只到 MB、遇 NaN 会显示 `NaN KB`。
 * 同一个数字在管理面板与录像时间线显示两套单位，收敛到此处。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

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
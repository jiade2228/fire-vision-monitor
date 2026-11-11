import type { AlarmStatsDay } from '../lib/api';

/**
 * 数字兜底：服务端异常或字段缺失时（undefined/NaN/负数），
 * 旧实现会让 `max` 变 NaN，进而所有 rect 的 height="NaN"、坐标轴显示 "NaN"，
 * 整张图表直接消失。
 */
const safe = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export default function StatsChart({ days }: { days: AlarmStatsDay[] }) {
  const width = 560;
  const height = 168;
  const pad = { left: 30, right: 8, top: 10, bottom: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const rows = Array.isArray(days) ? days : [];

  // 口径对齐：柱高只由 fire/smoke/offline 三段组成，而服务端 total 还可能
  // 包含 camera_abnormal 等其它等级。若用 total 做分母，出现画面异常告警时
  // 会出现「总数 10、柱高只有 5」且 Y 轴刻度与柱高对不上。
  const stacked = (day: AlarmStatsDay) =>
    safe(day.fire) + safe(day.smoke) + safe(day.offline);
  const max = Math.max(1, ...rows.map(stacked));
  const slot = innerW / Math.max(rows.length, 1);
  const barW = Math.max(2, slot * 0.62);
  // X 轴标签最小间距 42px，避免 90 天视图下相邻标签重叠。
  const labelEvery = Math.max(1, Math.ceil(42 / Math.max(slot, 1)));

  return (
    <svg
      className="stats-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`近${rows.length}天告警趋势`}
    >
      {[0, 0.5, 1].map((ratio) => {
        const y = pad.top + innerH * (1 - ratio);
        return (
          <g key={ratio}>
            <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} className="stats-grid" />
            <text x={pad.left - 5} y={y + 3} className="stats-axis" textAnchor="end">
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}
      {rows.length === 0 && (
        <text x={width / 2} y={height / 2} className="stats-axis" textAnchor="middle">
          暂无数据
        </text>
      )}
      {rows.map((day, index) => {
        const fire = safe(day.fire);
        const smoke = safe(day.smoke);
        const offline = safe(day.offline);
        const fireH = innerH * (fire / max);
        const smokeH = innerH * (smoke / max);
        const offlineH = innerH * (offline / max);
        const x = pad.left + index * slot + (slot - barW) / 2;
        const totalH = Math.min(innerH, fireH + smokeH + offlineH);
        const yFire = pad.top + innerH - totalH;
        const ySmoke = yFire + fireH;
        const yOffline = ySmoke + smokeH;
        return (
          <g key={day.date ?? index}>
            <title>
              {`${day.date ?? ''} 共 ${safe(day.total)} 条（火焰 ${fire} · 烟雾 ${smoke} · 离线 ${offline}；其余等级只计入总数）`}
            </title>
            {offline > 0 && (
              <rect x={x} y={yOffline} width={barW} height={offlineH} rx="1" className="stats-bar stats-bar--offline" />
            )}
            {smoke > 0 && (
              <rect x={x} y={ySmoke} width={barW} height={smokeH} rx="1" className="stats-bar stats-bar--smoke" />
            )}
            {fire > 0 && (
              <rect x={x} y={yFire} width={barW} height={fireH} rx="1" className="stats-bar stats-bar--fire" />
            )}
          </g>
        );
      })}
      {rows.map((day, index) =>
        index % labelEvery === 0 || index === rows.length - 1 ? (
          <text
            key={`label-${day.date ?? index}`}
            x={pad.left + index * slot + slot / 2}
            y={height - 5}
            className="stats-axis"
            textAnchor="middle"
          >
            {String(day.date ?? '').slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

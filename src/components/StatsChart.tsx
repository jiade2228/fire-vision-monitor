import type { AlarmStatsDay } from '../lib/api';

export default function StatsChart({ days }: { days: AlarmStatsDay[] }) {
  const width = 560;
  const height = 168;
  const pad = { left: 30, right: 8, top: 10, bottom: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...days.map((day) => day.total));
  const slot = innerW / Math.max(days.length, 1);
  const barW = Math.max(2, slot * 0.62);
  return (
    <svg
      className="stats-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`近${days.length}天告警趋势`}
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
      {days.map((day, index) => {
        const fireH = innerH * (day.fire / max);
        const smokeH = innerH * (day.smoke / max);
        const offlineH = innerH * (day.offline / max);
        const x = pad.left + index * slot + (slot - barW) / 2;
        const totalH = fireH + smokeH + offlineH;
        const yFire = pad.top + innerH - totalH;
        const ySmoke = yFire + fireH;
        const yOffline = ySmoke + smokeH;
        return (
          <g key={day.date}>
            <title>{`${day.date} 共 ${day.total} 条（火焰 ${day.fire} · 烟雾 ${day.smoke} · 离线 ${day.offline}）`}</title>
            {day.offline > 0 && (
              <rect x={x} y={yOffline} width={barW} height={offlineH} rx="1" fill="rgba(148,163,184,0.72)" />
            )}
            {day.smoke > 0 && (
              <rect x={x} y={ySmoke} width={barW} height={smokeH} rx="1" fill="rgba(255,170,70,0.9)" />
            )}
            {day.fire > 0 && (
              <rect x={x} y={yFire} width={barW} height={fireH} rx="1" fill="rgba(255,75,62,0.9)" />
            )}
          </g>
        );
      })}
      {days.map((day, index) =>
        index % 5 === 0 || index === days.length - 1 ? (
          <text
            key={day.date}
            x={pad.left + index * slot + slot / 2}
            y={height - 5}
            className="stats-axis"
            textAnchor="middle"
          >
            {day.date.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

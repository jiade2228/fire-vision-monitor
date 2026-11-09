import type { AlarmStats } from '../lib/api';
import StatsChart from './StatsChart';

interface Props {
  stats: AlarmStats;
}

export default function StatsOverview({ stats }: Props) {
  return (
    <>
      <div className="stats-kpis">
        <div className="stats-kpi">
          <span>告警总数</span>
          <strong>{stats.totals.total}</strong>
        </div>
        <div className="stats-kpi">
          <span>火焰 / 烟雾</span>
          <strong>
            {stats.totals.fire} / {stats.totals.smoke}
          </strong>
        </div>
        <div className="stats-kpi">
          <span>误报率</span>
          <strong>{stats.falseRate}%</strong>
        </div>
        <div className="stats-kpi">
          <span>仍待处置</span>
          <strong>{stats.totals.pending}</strong>
        </div>
      </div>
      <StatsChart days={stats.days} />
      <div className="stats-legend">
        <span>
          <i className="legend-dot legend-fire" /> 火焰
        </span>
        <span>
          <i className="legend-dot legend-smoke" /> 烟雾
        </span>
        <span>
          <i className="legend-dot legend-offline" /> 设备离线
        </span>
        <span className="stats-legend-hint">悬停柱体查看当日明细</span>
      </div>
      {stats.bySite.length > 0 && (
        <div className="stats-site-table">
          <table>
            <thead>
              <tr>
                <th>站点</th>
                <th>总数</th>
                <th>火焰</th>
                <th>烟雾</th>
                <th>离线</th>
                <th>误报</th>
              </tr>
            </thead>
            <tbody>
              {stats.bySite.map((site) => (
                <tr key={site.siteId}>
                  <td>{site.name}</td>
                  <td>{site.total}</td>
                  <td>{site.fire}</td>
                  <td>{site.smoke}</td>
                  <td>{site.offline}</td>
                  <td>{site.false}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import type { Dispatch, SetStateAction } from 'react';
import type { AlarmStats } from '../../lib/api';
import StatsOverview from '../StatsOverview';

interface StatsTabProps {
  statsDays: number;
  setStatsDays: Dispatch<SetStateAction<number>>;
  alarmStats: AlarmStats | null;
  loadAlarmStats: (days?: number) => Promise<void>;
}

export default function StatsTab(props: StatsTabProps) {
  const {
    statsDays,
    setStatsDays,
    alarmStats,
    loadAlarmStats,
  } = props;
  return (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>告警趋势</h3>
                  <p>
                    近 {statsDays} 天 · 误报率 = 判定误报 ÷（火焰 + 烟雾告警数），设备离线不计入分母。
                  </p>
                </div>
                <div className="filter-row" role="group" aria-label="统计周期">
                  {[7, 30, 90].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip ${statsDays === value ? 'is-active' : ''}`}
                      onClick={() => {
                        setStatsDays(value);
                        void loadAlarmStats(value);
                      }}
                    >
                      {value} 天
                    </button>
                  ))}
                </div>
              </div>
              {alarmStats ? (
                <StatsOverview stats={alarmStats} />
              ) : (
                <p className="admin-empty">正在加载统计数据…</p>
              )}
            </div>
  );
}

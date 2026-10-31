import type { Alarm } from '../types';
import { useNow } from '../hooks/useNow';
import { formatSeconds } from '../lib/format';

interface Props {
  alarms: Alarm[];
  onlineCount: number;
  totalCount: number;
}

export default function StatsStrip({ alarms, onlineCount, totalCount }: Props) {
  const now = useNow(60000);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const pending = alarms.filter((a) => a.status === 'pending').length;
  const todayCount = alarms.filter((a) => a.createdAt >= dayStart.getTime()).length;
  const handled = alarms.filter((a) => a.confirmedAt !== undefined);
  const avg =
    handled.length > 0
      ? handled.reduce((sum, a) => sum + ((a.confirmedAt ?? 0) - a.createdAt), 0) / handled.length
      : NaN;

  return (
    <div className="stats">
      <div className="stat stat--info">
        <span className="stat-label">在线通道</span>
        <strong className="stat-value">
          {onlineCount}
          <span className="stat-unit">/ {totalCount}</span>
        </strong>
        <span className="stat-hint">已接入视频信号</span>
      </div>
      <div className="stat stat--flame">
        <span className="stat-label">今日告警</span>
        <strong className="stat-value">{todayCount}</strong>
        <span className="stat-hint">今日火焰 / 烟雾识别结果</span>
      </div>
      <div className={`stat ${pending > 0 ? 'stat--danger' : 'stat--ok'}`}>
        <span className="stat-label">待处置</span>
        <strong className="stat-value">{pending}</strong>
        <span className="stat-hint">{pending > 0 ? '需值班员确认' : '暂无待办告警'}</span>
      </div>
      <div className="stat stat--ok">
        <span className="stat-label">平均响应</span>
        <strong className="stat-value">{Number.isNaN(avg) ? '—' : formatSeconds(avg)}</strong>
        <span className="stat-hint">告警到确认的平均耗时</span>
      </div>
    </div>
  );
}
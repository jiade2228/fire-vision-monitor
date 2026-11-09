import type { NotificationLog } from '../../lib/api';

interface Props {
  notifyLogs: NotificationLog[];
  eventLabels: Record<string, string>;
  formatDateTime: (ts: number) => string;
}

export default function NotifyLogList({
  notifyLogs,
  eventLabels,
  formatDateTime,
}: Props) {
  const NOTIFY_EVENT_LABELS = eventLabels;
  return (
    <>
      <div className="admin-subhead">
        <h4>最近推送</h4>
        <span>最多 30 条</span>
      </div>
      {notifyLogs.length === 0 ? (
        <p className="admin-empty">暂无推送记录。</p>
      ) : (
        <div className="notify-log-list">
          {notifyLogs.map((log) => (
            <div className="notify-log" key={log.id}>
              <span className={`notify-log-status is-${log.status}`}>
                {log.status === 'sent'
                  ? '成功'
                  : log.status === 'failed'
                    ? '失败'
                    : '待发送'}
              </span>
              <span className="notify-log-event">
                {NOTIFY_EVENT_LABELS[log.event] ?? log.event}
              </span>
              <span className="notify-log-channel">
                {log.channelName ?? '已删除渠道'}
              </span>
              <span className="notify-log-time">
                {formatDateTime(log.createdAt)}
              </span>
              {log.error && <span className="notify-log-error">{log.error}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

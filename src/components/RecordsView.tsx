import type { Alarm } from '../types';
import { getLevelMeta, getStatusMeta } from '../lib/detection';
import { downloadAlarmsCsv } from '../lib/export';
import { formatDateTime, formatDuration } from '../lib/format';

interface Props {
  alarms: Alarm[];
}

export default function RecordsView({ alarms }: Props) {
  const closed = alarms
    .filter((a) => a.status === 'false' || a.status === 'archived')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

  const confirmed = alarms.filter((a) => a.confirmedAt !== undefined);
  const falseCount = alarms.filter((a) => a.status === 'false').length;
  const avgResponse =
    confirmed.length > 0
      ? confirmed.reduce((sum, a) => sum + ((a.confirmedAt ?? 0) - a.createdAt), 0) / confirmed.length
      : NaN;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>处置记录</h2>
          <p className="panel-sub">已关闭告警的处置结果、响应时效与值守备注</p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={closed.length === 0}
          onClick={() => downloadAlarmsCsv(closed, '火情处置记录')}
        >
          导出记录 CSV
        </button>
      </div>

      <div className="record-stats">
        <div className="record-stat">
          <span>已归档</span>
          <strong>{alarms.filter((a) => a.status === 'archived').length}</strong>
        </div>
        <div className="record-stat">
          <span>判定误报</span>
          <strong>{falseCount}</strong>
        </div>
        <div className="record-stat">
          <span>平均确认耗时</span>
          <strong>{Number.isNaN(avgResponse) ? '—' : formatDuration(avgResponse)}</strong>
        </div>
        <div className="record-stat">
          <span>累计告警</span>
          <strong>{alarms.length}</strong>
        </div>
      </div>

      {closed.length === 0 ? (
        <div className="empty-state">
          <strong>暂无已关闭的告警</strong>
          <span>在实时监控中确认火情或标记误报后，处置结果会记录在此。</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th>告警编号</th>
                <th>通道</th>
                <th>识别类型</th>
                <th>触发时间</th>
                <th>处置结果</th>
                <th>确认耗时</th>
                <th>关闭时间</th>
                <th>值守备注</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((alarm) => (
                <tr key={alarm.id}>
                  <td className="mono">{alarm.id}</td>
                  <td>
                    {alarm.cameraName}
                    <span className="cell-sub">{alarm.zone}</span>
                  </td>
                  <td>
                    <span className={`level-tag level-tag--${alarm.level}`}>
                      {getLevelMeta(alarm.level).label}
                    </span>
                  </td>
                  <td className="mono">{formatDateTime(alarm.createdAt)}</td>
                  <td>
                    <span className={`status-chip status-chip--${getStatusMeta(alarm.status).tone}`}>
                      {getStatusMeta(alarm.status).label}
                    </span>
                  </td>
                  <td className="mono">
                    {alarm.confirmedAt
                      ? formatDuration(alarm.confirmedAt - alarm.createdAt)
                      : '—'}
                  </td>
                  <td className="mono">
                    {alarm.closedAt ? formatDateTime(alarm.closedAt) : '—'}
                  </td>
                  <td className="note-cell" title={alarm.note || undefined}>
                    {alarm.note || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
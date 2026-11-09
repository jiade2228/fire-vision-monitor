import type { AuditLog } from '../lib/api';
import { formatDateTime } from '../lib/format';

interface Props {
  logs: AuditLog[];
  actionLabels: Record<string, string>;
}

export default function AuditLogTable({ logs, actionLabels }: Props) {
  return (
    <div className="audit-table-wrap">
      <table className="audit-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>账号</th>
            <th>动作</th>
            <th>对象</th>
            <th>详情</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="audit-time">{formatDateTime(log.createdAt)}</td>
              <td>{log.username ?? '系统'}</td>
              <td>
                <span className="audit-action">
                  {actionLabels[log.action] ?? log.action}
                </span>
              </td>
              <td className="audit-target">
                {log.targetType ? `${log.targetType}${log.targetId ? ` · ${log.targetId.slice(0, 8)}` : ''}` : '—'}
              </td>
              <td className="audit-detail">{log.detail || '—'}</td>
              <td className="audit-ip">{log.ip || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

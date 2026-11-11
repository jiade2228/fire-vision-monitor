import type { Dispatch, SetStateAction } from 'react';
import type { AuditLog } from '../../lib/api';
import { AUDIT_ACTION_GROUPS, AUDIT_ACTION_LABELS, AUDIT_RANGE_OPTIONS } from '../AdminPanel';
import { downloadAuditCsv } from '../../lib/export';
import AuditLogTable from '../AuditLogTable';
import AuditPager from './AuditPager';

type AuditFilter = { action: string; q: string; range: string };

interface AuditTabProps {
  auditTotal: number;
  auditBusy: boolean;
  auditFilter: AuditFilter;
  auditLogs: AuditLog[];
  auditOffset: number;
  AUDIT_PAGE_SIZE: number;
  /** 服务端对关键词搜索自动收敛了默认时间窗（结果可能不完整）。 */
  auditSearchWindowed: boolean;
  /** 收敛时使用的默认时间窗（天）。 */
  auditSearchWindowDays: number;
  setAuditFilter: Dispatch<SetStateAction<AuditFilter>>;
  loadAuditLogs: (overrides?: Partial<{ action: string; q: string; range: string; offset: number }>) => Promise<void>;
}

export default function AuditTab(props: AuditTabProps) {
  const {
    auditTotal,
    auditBusy,
    auditFilter,
    auditLogs,
    auditOffset,
    AUDIT_PAGE_SIZE,
    auditSearchWindowed,
    auditSearchWindowDays,
    setAuditFilter,
    loadAuditLogs,
  } = props;
  return (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>审计日志</h3>
                  <p>
                    记录所有账号的关键操作（登录、点位变更、告警处置、通知与系统操作），
                    共 {auditTotal} 条，按时间倒序。
                  </p>
                </div>
                <div className="admin-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={auditBusy || auditLogs.length === 0}
                    onClick={() =>
                      downloadAuditCsv(auditLogs, AUDIT_ACTION_LABELS, '审计日志')
                    }
                  >
                    导出当前页 CSV
                  </button>
                </div>
              </div>

              <div className="audit-filters">
                <select
                  className="settings-input"
                  aria-label="按动作类型筛选"
                  value={auditFilter.action}
                  onChange={(event) =>
                    void loadAuditLogs({ action: event.target.value, offset: 0 })
                  }
                >
                  {AUDIT_ACTION_GROUPS.map((group) => (
                    <option key={group.value} value={group.value}>
                      {group.label}
                    </option>
                  ))}
                </select>
                <select
                  className="settings-input"
                  aria-label="按时间范围筛选"
                  value={auditFilter.range}
                  onChange={(event) =>
                    void loadAuditLogs({ range: event.target.value, offset: 0 })
                  }
                >
                  {AUDIT_RANGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className="settings-input"
                  value={auditFilter.q}
                  placeholder="搜索账号 / 详情 / 对象 ID"
                  aria-label="搜索审计日志"
                  onChange={(event) => setAuditFilter((prev) => ({ ...prev, q: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void loadAuditLogs({ offset: 0 });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={auditBusy}
                  onClick={() => void loadAuditLogs({ offset: 0 })}
                >
                  {auditBusy ? '查询中…' : '查询'}
                </button>
              </div>

              {auditSearchWindowed && (
                <p className="admin-hint">
                  关键词模糊匹配无法走数据库索引，服务端已把本次搜索限制在最近
                  {auditSearchWindowDays > 0 ? ` ${auditSearchWindowDays} 天` : '一段时间'}
                  内；如需查找更早的记录，请在上方「时间范围」中指定更长的区间。
                </p>
              )}

              {auditLogs.length === 0 ? (
                <p className="admin-empty">没有符合条件的审计记录。</p>
              ) : (
                <AuditLogTable logs={auditLogs} actionLabels={AUDIT_ACTION_LABELS} />
              )}

              <AuditPager
                auditBusy={auditBusy}
                auditOffset={auditOffset}
                auditTotal={auditTotal}
                pageSize={AUDIT_PAGE_SIZE}
                loadAuditLogs={loadAuditLogs}
              />
            </div>
  );
}

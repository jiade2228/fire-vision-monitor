interface Props {
  auditBusy: boolean;
  auditOffset: number;
  auditTotal: number;
  pageSize: number;
  loadAuditLogs: (
    overrides?: Partial<{ action: string; q: string; range: string; offset: number }>,
  ) => Promise<void>;
}

export default function AuditPager({
  auditBusy,
  auditOffset,
  auditTotal,
  pageSize,
  loadAuditLogs,
}: Props) {
  const AUDIT_PAGE_SIZE = pageSize;
  return (
    <>
      {auditTotal > AUDIT_PAGE_SIZE && (
        <div className="audit-pager">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={auditBusy || auditOffset === 0}
            onClick={() =>
              void loadAuditLogs({
                offset: Math.max(0, auditOffset - AUDIT_PAGE_SIZE),
              })
            }
          >
            上一页
          </button>
          <span>
            第 {Math.floor(auditOffset / AUDIT_PAGE_SIZE) + 1} 页 / 共{' '}
            {Math.ceil(auditTotal / AUDIT_PAGE_SIZE)} 页
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={auditBusy || auditOffset + AUDIT_PAGE_SIZE >= auditTotal}
            onClick={() => void loadAuditLogs({ offset: auditOffset + AUDIT_PAGE_SIZE })}
          >
            下一页
          </button>
        </div>
      )}
    </>
  );
}

import crypto from 'node:crypto';
import { now } from '../../schema.mjs';

export const auditMethods = {
/**
 * 记录一条审计日志。
 * @param {{user?: {id?: string, username?: string}|null, action: string, targetType?: string|null, targetId?: string|null, detail?: string, ip?: string}} entry
 * @returns {void}
 */
recordAudit({ user, action, targetType = null, targetId = null, detail = '', ip = '' }) {
    this.db
      .prepare(`
        INSERT INTO audit_logs
        (id, user_id, username, action, target_type, target_id, detail, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        user?.id ?? null,
        user?.username ?? null,
        action,
        targetType,
        targetId,
        String(detail).slice(0, 1000),
        ip,
        now(),
      );
  },
/**
 * 最近审计日志（新→旧）。
 * @param {number} [limit] 返回条数上限（1-1000），默认 200。
 * @returns {import('../../types.mjs').AuditLogEntry[]}
 */
listAudit(limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit);
  },
/**
 * 审计日志筛选查询（审计界面用）。
 * action 支持前缀匹配（如 'camera' 命中 camera.create/update/delete/test/import）；
 * q 匹配 username/detail/target_id；from/to 为毫秒时间戳（含头含尾）。
 * @param {{limit?: number, offset?: number, action?: string, q?: string, from?: number|null, to?: number|null}} [query]
 * @returns {import('../../types.mjs').AuditLogEntry[]}
 */
listAuditFiltered({
    limit = 50,
    offset = 0,
    action = '',
    q = '',
    from = null,
    to = null,
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), 1_000_000);
    const where = [];
    const params = [];
    const actionKey = String(action ?? '').trim();
    if (actionKey) {
      where.push('action LIKE ?');
      params.push(`${actionKey}%`);
    }
    const keyword = String(q ?? '').trim().slice(0, 64);
    if (keyword) {
      where.push('(username LIKE ? OR detail LIKE ? OR target_id LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (Number.isFinite(from)) {
      where.push('created_at >= ?');
      params.push(Number(from));
    }
    if (Number.isFinite(to)) {
      where.push('created_at <= ?');
      params.push(Number(to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, safeOffset);
  },
/**
 * 与 listAuditFiltered 同口径的总数统计（分页用）。
 * @param {{action?: string, q?: string, from?: number|null, to?: number|null}} [query]
 * @returns {number}
 */
countAuditFiltered({ action = '', q = '', from = null, to = null } = {}) {
    const where = [];
    const params = [];
    const actionKey = String(action ?? '').trim();
    if (actionKey) {
      where.push('action LIKE ?');
      params.push(`${actionKey}%`);
    }
    const keyword = String(q ?? '').trim().slice(0, 64);
    if (keyword) {
      where.push('(username LIKE ? OR detail LIKE ? OR target_id LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (Number.isFinite(from)) {
      where.push('created_at >= ?');
      params.push(Number(from));
    }
    if (Number.isFinite(to)) {
      where.push('created_at <= ?');
      params.push(Number(to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_logs ${clause}`)
      .get(...params);
    return Number(row?.total ?? 0);
  },
/**
 * 按条数上限清理审计日志（保留最近 retain 条）。
 * @param {number} [retain] 保留条数（1000-100000），默认 20000。
 * @returns {number} 删除条数。
 */
pruneAuditLogs(retain = 20_000) {
    const safeRetain = Math.min(Math.max(Number(retain) || 20_000, 1000), 100_000);
    const result = this.db
      .prepare(`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?
        )
      `)
      .run(safeRetain);
    return Number(result.changes);
  },
/**
 * 审计日志按天数清理（与告警/推送日志的保留语义对齐）。
 * 与「按条数上限」互补：条数上限防无限膨胀，天数清理满足保留期约定。
 * @param {number} [retainDays] 保留天数（1-3650），默认 180。
 * @returns {number} 删除条数。
 */
pruneAuditLogsByAge(retainDays = 180) {
    const safeDays = Math.min(Math.max(Number(retainDays) || 180, 1), 3650);
    const cutoff = now() - safeDays * 24 * 60 * 60 * 1000;
    return Number(
      this.db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff).changes,
    );
  },
};

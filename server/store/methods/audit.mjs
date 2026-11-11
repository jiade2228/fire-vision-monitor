import crypto from 'node:crypto';
import { now } from '../../schema.mjs';

/**
 * 关键词模糊搜索的默认时间窗（天）。
 *
 * 关键词搜索命中的是 `username/detail/target_id LIKE '%kw%'`，
 * 前导通配符无法走 B-tree 索引，只能全表扫描：
 * 50 万条审计日志时实测单次查询 3.4 秒，端点上会长时间无响应。
 * 因此在没有显式指定起始时间时，把扫描范围收敛到最近 N 天
 * （与审计日志保留期默认 180 天一致），把最坏情况压回可接受区间。
 *
 * 该行为对外可见：接口会返回 searchWindowed 标记，
 * 前端据此提示「结果可能不完整，可指定时间范围」。
 */
export const AUDIT_KEYWORD_WINDOW_DAYS = 180;

/**
 * LIKE 模式转义。
 *
 * 参数化查询本身是安全的，但用户输入里的 `%` / `_` 会被当作通配符：
 * 搜索 `%` 会匹配全部审计记录（配合分页仍能放大扫描范围），
 * 搜索 `a_b` 会误匹配 `axb`。这里转义通配符并显式声明 ESCAPE。
 *
 * @param {string} value 原始关键字。
 * @returns {string} 转义后的模式片段（不含两侧 %）。
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 列表与分页总数共用同一套筛选条件，避免两处口径漂移。 */
function buildAuditFilter({
  action = '',
  q = '',
  from = null,
  to = null,
  keywordWindowDays = AUDIT_KEYWORD_WINDOW_DAYS,
} = {}) {
  const where = [];
  const params = [];
  const actionKey = String(action ?? '').trim();
  if (actionKey) {
    where.push("action LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(actionKey)}%`);
  }
  const keyword = String(q ?? '').trim().slice(0, 64);
  let windowed = false;
  if (keyword) {
    where.push(
      "(username LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${escapeLike(keyword)}%`;
    params.push(pattern, pattern, pattern);
    // PERF-2：关键词搜索必然全表扫描；用户没给起始时间时强制加时间窗收敛扫描范围。
    if (!Number.isFinite(from) && Number.isFinite(keywordWindowDays)) {
      const windowMs = Math.max(Number(keywordWindowDays), 1) * 24 * 60 * 60 * 1000;
      where.push('created_at >= ?');
      params.push(now() - windowMs);
      windowed = true;
    }
  }
  if (Number.isFinite(from)) {
    where.push('created_at >= ?');
    params.push(Number(from));
  }
  if (Number.isFinite(to)) {
    where.push('created_at <= ?');
    params.push(Number(to));
  }
  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    windowed,
  };
}

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
    const { clause, params } = buildAuditFilter({ action, q, from, to });
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
    const { clause, params } = buildAuditFilter({ action, q, from, to });
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_logs ${clause}`)
      .get(...params);
    return Number(row?.total ?? 0);
  },
  /**
   * 本次关键词搜索是否被默认时间窗收敛（结果可能不完整）。
   * 供接口层透出给前端提示，避免用户误以为搜不到就是没有记录。
   * @param {{q?: string, from?: number|null}} [query]
   * @returns {boolean}
   */
  auditSearchWindowed({ q = '', from = null } = {}) {
    const keyword = String(q ?? '').trim().slice(0, 64);
    if (!keyword) return false;
    return !Number.isFinite(from);
  },
  /**
   * 按条数上限清理审计日志（保留最新 retain 条）。
   *
   * PERF-2：旧写法 `id IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?)`
   * 会把「要删的全部 ID」物化成子查询再回表匹配，50 万行时实测 1.1 秒。
   * 改为「先定位保留窗口的时间边界 → 再按时间阈值删除」，删除走 created_at 索引范围扫描。
   *
   * 同一毫秒内的多条记录时间戳相同，单靠时间阈值无法精确切分，
   * 因此第二段按 rowid 倒序补删多余记录（保留先写入的），保证恰好保留 retain 条。
   *
   * @param {number} [retain] 保留条数（1000-100000），默认 20000。
   * @returns {number} 删除条数。
   */
  pruneAuditLogs(retain = 20_000) {
    const safeRetain = Math.min(Math.max(Number(retain) || 20_000, 1000), 100_000);
    // 第 retain 条（1 基）即「保留窗口」里最旧的一条，它的时间戳就是删除阈值。
    const boundary = this.db
      .prepare(
        'SELECT created_at FROM audit_logs ORDER BY created_at DESC LIMIT 1 OFFSET ?',
      )
      .get(safeRetain - 1);
    if (!boundary) return 0; // 总条数不足 retain，无需清理
    const cutoff = Number(boundary.created_at);
    // 第一段：删除严格早于阈值的记录（走 created_at 索引范围扫描）。
    let removed = Number(
      this.db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff).changes,
    );
    // 第二段：阈值所在「同毫秒桶」可能多于应保留条数，按 rowid 倒序补删。
    const greater = Number(
      this.db
        .prepare('SELECT COUNT(*) AS total FROM audit_logs WHERE created_at > ?')
        .get(cutoff)?.total ?? 0,
    );
    const bucketCount = Number(
      this.db
        .prepare('SELECT COUNT(*) AS total FROM audit_logs WHERE created_at = ?')
        .get(cutoff)?.total ?? 0,
    );
    const keepInBucket = safeRetain - greater;
    const extra = bucketCount - keepInBucket;
    if (extra > 0) {
      removed += Number(
        this.db
          .prepare(
            `DELETE FROM audit_logs WHERE rowid IN (
               SELECT rowid FROM audit_logs WHERE created_at = ? ORDER BY rowid DESC LIMIT ?
             )`,
          )
          .run(cutoff, extra).changes,
      );
    }
    return removed;
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

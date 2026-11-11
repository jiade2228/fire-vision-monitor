import { now } from '../../schema.mjs';
import { userRowToObject } from '../helpers.mjs';

export const userMethods = {
/**
 * 全部用户列表（按创建时间升序）。
 * @returns {import('../../types.mjs').User[]}
 */
listUsers() {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all()
      .map(userRowToObject);
  },
/**
 * @param {string} id 用户 ID。
 * @returns {import('../../types.mjs').User|null}
 */
getUser(id) {
    return userRowToObject(
      this.db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    );
  },
/**
 * @param {string} username 登录名。
 * @returns {import('../../types.mjs').User|null}
 */
getUserByUsername(username) {
    return userRowToObject(
      this.db
        .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
        .get(username),
    );
  },
/**
 * 未停用的超级管理员数量（防止删停最后一个可用超管）。
 * @returns {number}
 */
countActiveAdmins() {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
        )
        .get().count,
    );
  },
/**
 * 新建用户（调用方先完成用户名/密码校验与哈希）。
 * @param {import('../../types.mjs').User} user 完整用户对象（含 id/salt/passwordHash）。
 * @returns {import('../../types.mjs').User}
 */
createUser(user) {
    this.db
      .prepare(`
        INSERT INTO users
        (id, username, display_name, role, is_site_admin, salt, password_hash,
         disabled, token_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        user.id,
        user.username,
        user.displayName,
        user.role,
        user.siteAdmin ? 1 : 0,
        user.salt,
        user.passwordHash,
        user.disabled ? 1 : 0,
        Number(user.tokenVersion) || 0,
        user.createdAt ?? now(),
      );
    this.bumpAuthRevision();
    return this.getUser(user.id);
  },
/**
 * 更新用户资料/角色/停用状态/凭据（仅处理传入的字段）。
 * @param {string} id 用户 ID。
 * @param {Partial<import('../../types.mjs').User>} changes 变更字段。
 * @returns {import('../../types.mjs').User|null}
 */
updateUser(id, changes) {
    const user = this.getUser(id);
    if (!user) return null;
    const sets = [];
    const values = [];
    if (changes.displayName !== undefined) {
      sets.push('display_name = ?');
      values.push(changes.displayName);
    }
    if (changes.role !== undefined) {
      sets.push('role = ?');
      values.push(changes.role);
    }
    if (changes.disabled !== undefined) {
      sets.push('disabled = ?');
      values.push(changes.disabled ? 1 : 0);
    }
    if (changes.siteAdmin !== undefined) {
      sets.push('is_site_admin = ?');
      values.push(changes.siteAdmin ? 1 : 0);
    }
    if (changes.passwordHash !== undefined && changes.salt !== undefined) {
      sets.push('password_hash = ?', 'salt = ?', 'token_version = token_version + 1');
      values.push(changes.passwordHash, changes.salt);
    } else if (
      changes.role !== undefined ||
      changes.disabled === true ||
      changes.siteAdmin !== undefined
    ) {
      sets.push('token_version = token_version + 1');
    }
    if (!sets.length) return user;
    values.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.bumpAuthRevision();
    return this.getUser(id);
  },
  /**
   * 递增会话版本，使该账号其它标签页已签发的 token 立即失效（登出时使用）。
   * @param {string} id 用户 ID。
   * @returns {number} 受影响行数。
   */
  bumpTokenVersion(id) {
    this.bumpAuthRevision();
    return this.db
      .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?')
      .run(id).changes;
  },
  /**
   * 事务内执行「可用管理员计数 + 用户更新」。
   *
   * 计数与写入放在同一个 BEGIN IMMEDIATE 事务里：两个管理员并发互相降级时，
   * 只有一个能通过校验，不会把可用管理员降到 0（否则系统将失去管理入口）。
   *
   * @param {string} id 用户 ID。
   * @param {Partial<import('../../types.mjs').User>} changes 变更字段。
   * @returns {{ok: boolean, error?: string, user: import('../../types.mjs').User|null}}
   */
  updateUserWithAdminGuard(id, changes) {
    return this.transaction(() => {
      const user = this.getUser(id);
      if (!user) return { ok: false, error: '账号不存在', user: null };
      const wasActiveAdmin = user.role === 'admin' && !user.disabled;
      const remainsActiveAdmin =
        wasActiveAdmin &&
        (changes.role === undefined || changes.role === 'admin') &&
        changes.disabled !== true;
      if (wasActiveAdmin && !remainsActiveAdmin && this.countActiveAdmins() <= 1) {
        return { ok: false, error: '必须保留至少一个可用管理员', user: null };
      }
      return { ok: true, user: this.updateUser(id, changes) };
    });
  },
  /**
   * 事务内执行「可用管理员计数 + 用户删除」。
   * @param {string} id 用户 ID。
   * @returns {{ok: boolean, error?: string}}
   */
  deleteUserWithAdminGuard(id) {
    return this.transaction(() => {
      const user = this.getUser(id);
      if (!user) return { ok: false, error: '账号不存在' };
      if (user.role === 'admin' && this.countActiveAdmins() <= 1) {
        return { ok: false, error: '必须保留至少一个管理员' };
      }
      this.deleteUser(id);
      return { ok: true };
    });
  },
  /**
   * 删除用户及其站点归属记录，并清理指向该用户的孤儿行。
   *
   * audit_logs.user_id / alarm_events.user_id 没有外键约束（schema 里未声明
   * FOREIGN KEY），直接删用户会留下指向不存在用户的记录。这里显式清理：
   * 审计与事件流水中的 user_id 置空（保留留痕，只是不再指向已删账号）。
   *
   * @param {string} id 用户 ID。
   * @returns {boolean} 是否删除成功。
   */
  deleteUser(id) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(id);
      this.db.prepare('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?').run(id);
      this.db.prepare('UPDATE alarm_events SET user_id = NULL WHERE user_id = ?').run(id);
      this.db.prepare('UPDATE alarms SET created_by = NULL WHERE created_by = ?').run(id);
      this.db.prepare('UPDATE alarms SET updated_by = NULL WHERE updated_by = ?').run(id);
      // 该账号的全部会话一并失效，避免删号后旧令牌仍可用。
      this.db
        .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now(), id);
      const removed = this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
      this.bumpAuthRevision();
      return removed;
    });
  },

  /* ── 会话登记（V10） ─────────────────────────────────────────────
   *
   * 目的：登出只撤销「当前会话」，而不是像改造前那样递增 users.token_version
   * 把该账号所有设备/标签页的令牌一起作废。
   *
   * 兼容设计：
   *   - auth_sessions 表是**纯新增**，老库里不存在时相关方法安全降级
   *     （方法内部检测表是否存在），不影响升级。
   *   - 令牌载荷里的 sid 为可选字段；无 sid 的旧令牌仍然可用。
   */

  /**
   * 该表是否存在（用于老库降级）。
   * @returns {boolean}
   */
  hasAuthSessionsTable() {
    return Boolean(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'")
        .get(),
    );
  },

  /**
   * 登记一个会话。
   *
   * @param {string} userId 用户 ID。
   * @param {string} sid 会话 ID。
   * @param {{userAgent?: string, ip?: string, expiresAt?: number}} [meta] 附加信息。
   * @returns {boolean} 是否登记成功。
   */
  registerSession(userId, sid, meta = {}) {
    if (!this.hasAuthSessionsTable()) return false;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO auth_sessions (sid, user_id, created_at, expires_at, revoked_at, user_agent, ip)
         VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           expires_at = excluded.expires_at,
           revoked_at = NULL,
           user_agent = excluded.user_agent,
           ip = excluded.ip`,
      )
      .run(
        sid,
        userId,
        timestamp,
        Number(meta.expiresAt) || timestamp + 7 * 24 * 60 * 60 * 1000,
        String(meta.userAgent ?? '').slice(0, 200),
        String(meta.ip ?? '').slice(0, 128),
      );
    return true;
  },

  /**
   * 会话是否已被撤销。
   *
   * 未登记过的 sid 视为**有效**（兼容升级前的旧令牌，它们没有 sid 记录）。
   *
   * @param {string} userId 用户 ID。
   * @param {string} sid 会话 ID。
   * @returns {boolean}
   */
  isSessionRevoked(userId, sid) {
    if (!this.hasAuthSessionsTable()) return false;
    const row = this.db
      .prepare('SELECT revoked_at, expires_at FROM auth_sessions WHERE sid = ? AND user_id = ?')
      .get(sid, userId);
    if (!row) return false;
    if (row.revoked_at) return true;
    // 过期也视为失效。
    return Number(row.expires_at) < Date.now();
  },

  /**
   * 撤销单个会话（登出当前标签页）。
   *
   * @param {string} userId 用户 ID。
   * @param {string} sid 会话 ID。
   * @returns {boolean} 是否撤销成功。
   */
  revokeSession(userId, sid) {
    if (!this.hasAuthSessionsTable()) return false;
    return (
      this.db
        .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE sid = ? AND user_id = ? AND revoked_at IS NULL')
        .run(now(), sid, userId).changes > 0
    );
  },

  /**
   * 撤销该用户的全部会话（「全端下线」）。
   *
   * @param {string} userId 用户 ID。
   * @returns {number} 受影响会话数。
   */
  revokeUserSessions(userId) {
    if (!this.hasAuthSessionsTable()) return 0;
    return this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now(), userId).changes;
  },

  /**
   * 列出某用户的活跃会话（用于「我的登录设备」）。
   *
   * @param {string} userId 用户 ID。
   * @returns {Array<{sid: string, createdAt: number, expiresAt: number, userAgent: string, ip: string}>}
   */
  listUserSessions(userId) {
    if (!this.hasAuthSessionsTable()) return [];
    return this.db
      .prepare(
        `SELECT sid, created_at, expires_at, user_agent, ip
         FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(userId, now())
      .map((row) => ({
        sid: row.sid,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent ?? '',
        ip: row.ip ?? '',
      }));
  },

  /**
   * 清理过期会话记录。
   *
   * @param {number} [olderThanMs] 清理早于该毫秒数前的记录，默认 7 天。
   * @returns {number} 删除条数。
   */
  pruneAuthSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    if (!this.hasAuthSessionsTable()) return 0;
    return this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at < ?')
      .run(now() - olderThanMs).changes;
  },
};

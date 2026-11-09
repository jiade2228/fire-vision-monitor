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
    return this.getUser(id);
  },
  /**
   * 递增会话版本，使该账号其它标签页已签发的 token 立即失效（登出时使用）。
   * @param {string} id 用户 ID。
   * @returns {number} 受影响行数。
   */
  bumpTokenVersion(id) {
    return this.db
      .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?')
      .run(id).changes;
  },
/**
 * 删除用户及其站点归属记录。
 * @param {string} id 用户 ID。
 * @returns {boolean} 是否删除成功。
 */
deleteUser(id) {
    this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(id);
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  },
};

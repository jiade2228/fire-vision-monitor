import { now } from '../../schema.mjs';
import { userRowToObject } from '../helpers.mjs';

export const userMethods = {
listUsers() {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all()
      .map(userRowToObject);
  },
getUser(id) {
    return userRowToObject(
      this.db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    );
  },
getUserByUsername(username) {
    return userRowToObject(
      this.db
        .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
        .get(username),
    );
  },
countActiveAdmins() {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
        )
        .get().count,
    );
  },
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
deleteUser(id) {
    this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(id);
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  },
};

import crypto from 'node:crypto';
import { now } from '../../schema.mjs';

export const siteMethods = {
/**
 * 全部站点列表（按创建时间升序）。
 * @returns {import('../../types.mjs').Site[]}
 */
listSites() {
    return this.db
      .prepare('SELECT * FROM sites ORDER BY created_at ASC')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        createdAt: row.created_at,
      }));
  },
/**
 * @param {string} id 站点 ID。
 * @returns {import('../../types.mjs').Site|null}
 */
getSite(id) {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, name: row.name, code: row.code, createdAt: row.created_at };
  },
/**
 * 新建站点（编码唯一）。
 * @param {{id: string, name: string, code: string, createdAt: number}} site
 * @returns {import('../../types.mjs').Site}
 */
createSite({ id, name, code, createdAt }) {
    // sites.id 是 TEXT 主键，last_insert_rowid() 对它无效；统一用同一个 ID 插入并回读。
    const siteId = id ?? crypto.randomUUID();
    this.db
      .prepare('INSERT INTO sites (id, name, code, created_at) VALUES (?, ?, ?, ?)')
      .run(siteId, name, code, createdAt ?? now());
    return this.getSite(siteId);
  },
/**
 * 重命名站点。
 * @param {string} id 站点 ID。
 * @param {{name?: string}} [changes]
 * @returns {import('../../types.mjs').Site|null}
 */
updateSite(id, { name } = {}) {
    if (name !== undefined) {
      this.db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id);
    }
    return this.getSite(id);
  },
/**
 * 站点下的点位数量（删除站点前检查）。
 * @param {string} siteId 站点 ID。
 * @returns {number}
 */
countCamerasBySite(siteId) {
    return Number(
      this.db.prepare('SELECT COUNT(*) AS count FROM cameras WHERE site_id = ?').get(siteId)
        .count,
    );
  },
/**
 * 删除站点；默认站点或仍有点位的站点会被拒绝。
 * @param {string} id 站点 ID。
 * @returns {boolean} 是否删除成功。
 */
deleteSite(id) {
    if (id === this.defaultSiteId) {
      const error = new Error('默认站点不可删除');
      error.code = 'SITE_DEFAULT';
      throw error;
    }
    if (this.countCamerasBySite(id) > 0) {
      const error = new Error('请先将站点下的点位移动到其他站点或默认站点');
      error.code = 'SITE_HAS_CAMERAS';
      throw error;
    }
    return this.transaction(() => {
      this.db.prepare('DELETE FROM site_members WHERE site_id = ?').run(id);
      return this.db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
    });
  },
/**
 * 用户被授权访问的站点 ID 列表。
 * @param {string} userId 用户 ID。
 * @returns {string[]}
 */
siteMemberSiteIds(userId) {
    return this.db
      .prepare('SELECT site_id FROM site_members WHERE user_id = ?')
      .all(userId)
      .map((row) => row.site_id);
  },
/**
 * 站点管理员可管理的站点；普通用户返回空数组。
 * @param {import('../../types.mjs').User|null} user
 * @returns {string[]}
 */
adminSiteIds(userId) {
    const user = this.getUser(userId);
    if (!user?.siteAdmin) return [];
    return this.siteMemberSiteIds(userId);
  },
/**
 * 整体替换用户的站点授权集合。
 * @param {string} userId 用户 ID。
 * @param {string[]} siteIds 全量站点 ID。
 * @returns {void}
 */
setUserSites(userId, siteIds) {
    const unique = [...new Set(siteIds.map(String).filter(Boolean))];
    this.transaction(() => {
      this.db.prepare('DELETE FROM site_members WHERE user_id = ?').run(userId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO site_members (user_id, site_id) VALUES (?, ?)',
      );
      for (const siteId of unique) insert.run(userId, siteId);
    });
    return this.siteMemberSiteIds(userId);
  },
};

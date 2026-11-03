import crypto from 'node:crypto';
import { now } from '../../schema.mjs';

export const siteMethods = {
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
getSite(id) {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, name: row.name, code: row.code, createdAt: row.created_at };
  },
createSite({ id, name, code, createdAt }) {
    this.db
      .prepare('INSERT INTO sites (id, name, code, created_at) VALUES (?, ?, ?, ?)')
      .run(id ?? crypto.randomUUID(), name, code, createdAt ?? now());
    return this.getSite(id ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  },
updateSite(id, { name } = {}) {
    if (name !== undefined) {
      this.db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id);
    }
    return this.getSite(id);
  },
countCamerasBySite(siteId) {
    return Number(
      this.db.prepare('SELECT COUNT(*) AS count FROM cameras WHERE site_id = ?').get(siteId)
        .count,
    );
  },
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
siteMemberSiteIds(userId) {
    return this.db
      .prepare('SELECT site_id FROM site_members WHERE user_id = ?')
      .all(userId)
      .map((row) => row.site_id);
  },
adminSiteIds(userId) {
    const user = this.getUser(userId);
    if (!user?.siteAdmin) return [];
    return this.siteMemberSiteIds(userId);
  },
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

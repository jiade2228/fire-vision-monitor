import crypto from 'node:crypto';
import { now, sourceFingerprint } from '../../schema.mjs';
import { serializeSchedule } from '../../schedule.mjs';
import { serializeRoi, cameraRowToObject } from '../helpers.mjs';

export const cameraMethods = {
/**
 * 点位列表（按创建时间升序），支持按站点/可见站点集合过滤。
 * @param {{siteId?: string|null, allowedSiteIds?: string[]|null}} [query]
 * @returns {import('../../types.mjs').Camera[]}
 */
listCameras({ siteId = null, allowedSiteIds = null } = {}) {
    const clauses = [];
    const values = [];
    if (allowedSiteIds !== null) {
      if (allowedSiteIds.length === 0) {
        return [];
      }
      clauses.push(`site_id IN (${allowedSiteIds.map(() => '?').join(',')})`);
      values.push(...allowedSiteIds);
    }
    if (siteId) {
      clauses.push('site_id = ?');
      values.push(siteId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM cameras ${where} ORDER BY created_at ASC`)
      .all(...values)
      .map((row) => cameraRowToObject(row, this.secretBox));
  },
/**
 * @param {string} id 点位 ID。
 * @returns {import('../../types.mjs').Camera|null}
 */
getCamera(id) {
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id),
      this.secretBox,
    );
  },
/**
 * 按源指纹查点位（同源去重）。
 * @param {string|null} sourceKey 源指纹。
 * @returns {import('../../types.mjs').Camera|null}
 */
cameraBySourceKey(sourceKey) {
    if (!sourceKey) return null;
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE source_key = ?').get(sourceKey),
      this.secretBox,
    );
  },
/**
 * 生成下一个可用点位编码（CAM-xxx 递增）。
 * @returns {string}
 */
nextCameraCode() {
    const codes = this.db.prepare('SELECT code FROM cameras').all();
    const numeric = codes
      .map((row) => Number(String(row.code).replace(/\D/g, '')))
      .filter((value) => Number.isFinite(value));
    return `CAM-${String((numeric.length ? Math.max(...numeric) : 0) + 1).padStart(2, '0')}`;
  },
/**
 * 直接插入点位记录（不做同源唯一性检查，导入场景内部使用）。
 * @param {import('../../types.mjs').Camera} camera
 * @returns {import('../../types.mjs').Camera}
 */
insertCamera(camera) {
    const storedUrl =
      camera.protocol === 'rtsp' && camera.sourceUrl
        ? this.secretBox.encrypt(camera.sourceUrl)
        : camera.sourceUrl;
    const key = sourceFingerprint(camera.protocol, camera.sourceUrl);
    const timestamp = camera.createdAt ?? now();
    const siteId = camera.siteId || this.defaultSiteId;
    this.db
      .prepare(`
        INSERT INTO cameras
        (id, code, name, zone, protocol, source_url, source_key, site_id,
         detect_enabled, detect_sensitivity, detect_roi, schedule, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        camera.id,
        camera.code,
        camera.name,
        camera.zone,
        camera.protocol,
        storedUrl,
        key,
        siteId,
        camera.detectEnabled === false ? 0 : 1,
        camera.detectSensitivity ?? null,
        serializeRoi(camera.detectRoi ?? null),
        serializeSchedule(camera.schedule),
        camera.enabled === false ? 0 : 1,
        timestamp,
        camera.updatedAt ?? timestamp,
      );
    return this.getCamera(camera.id);
  },
/**
 * 新建点位；同源指纹已存在时抛错。
 * @param {import('../../types.mjs').Camera} camera
 * @returns {import('../../types.mjs').Camera}
 * @throws {Error} 同源点位已存在。
 */
createCamera(camera) {
    const key = sourceFingerprint(camera.protocol, camera.sourceUrl);
    if (key && this.cameraBySourceKey(key)) {
      const error = new Error('相同视频流地址的点位已存在');
      error.code = 'DUPLICATE_SOURCE';
      throw error;
    }
    return this.transaction(() =>
      this.insertCamera({
        ...camera,
        id: camera.id ?? crypto.randomUUID(),
        code: camera.code ?? this.nextCameraCode(),
      }),
    );
  },
/**
 * 更新点位（源地址变更会重算指纹并做同源冲突检查）。
 * @param {string} id 点位 ID。
 * @param {Partial<import('../../types.mjs').Camera>} changes 变更字段。
 * @returns {import('../../types.mjs').Camera|null}
 */
updateCamera(id, changes) {
    const current = this.getCamera(id);
    if (!current) return null;
    const next = {
      ...current,
      ...changes,
      updatedAt: now(),
    };
    const key = sourceFingerprint(next.protocol, next.sourceUrl);
    if (key) {
      const duplicate = this.cameraBySourceKey(key);
      if (duplicate && duplicate.id !== id) {
        const error = new Error('相同视频流地址的点位已存在');
        error.code = 'DUPLICATE_SOURCE';
        throw error;
      }
    }
    const storedUrl =
      next.protocol === 'rtsp' && next.sourceUrl
        ? this.secretBox.encrypt(next.sourceUrl)
        : next.sourceUrl;
    const siteId = next.siteId || this.defaultSiteId;
    this.db
      .prepare(`
        UPDATE cameras SET
          name = ?, zone = ?, protocol = ?, source_url = ?, source_key = ?,
          site_id = ?, detect_enabled = ?, detect_sensitivity = ?, detect_roi = ?,
          schedule = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.zone,
        next.protocol,
        storedUrl,
        key,
        siteId,
        next.detectEnabled === false ? 0 : 1,
        next.detectSensitivity ?? null,
        serializeRoi(next.detectRoi ?? null),
        serializeSchedule(next.schedule),
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return this.getCamera(id);
  },
/**
 * @param {string} id 点位 ID。
 * @returns {boolean} 是否删除成功。
 */
deleteCamera(id) {
    return this.db.prepare('DELETE FROM cameras WHERE id = ?').run(id).changes > 0;
  },
/**
 * 批量导入点位（事务内逐条处理，同源重复跳过）。
 * @param {Array<Partial<import('../../types.mjs').Camera>>} items
 * @returns {Promise<{created: import('../../types.mjs').Camera[], skipped: number}>}
 */
importCameras(items) {
    return this.transaction(() => {
      const created = [];
      let skipped = 0;
      // 编码基准在事务内只取一次：原实现逐条全表取 max，批量导入为 O(N²)。
      let nextCode = Number(this.nextCameraCode().replace(/\D/g, ''));
      for (const item of items) {
        const key = sourceFingerprint(item.protocol, item.sourceUrl);
        if (key && this.cameraBySourceKey(key)) {
          skipped += 1;
          continue;
        }
        const camera = this.insertCamera({
          ...item,
          id: crypto.randomUUID(),
          code: `CAM-${String(nextCode++).padStart(2, '0')}`,
          createdAt: now(),
          updatedAt: now(),
        });
        created.push(camera);
      }
      return { created, skipped };
    });
  },
};

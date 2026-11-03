import crypto from 'node:crypto';
import { now, sourceFingerprint } from '../../schema.mjs';
import { serializeRoi, cameraRowToObject } from '../helpers.mjs';

export const cameraMethods = {
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
getCamera(id) {
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id),
      this.secretBox,
    );
  },
cameraBySourceKey(sourceKey) {
    if (!sourceKey) return null;
    return cameraRowToObject(
      this.db.prepare('SELECT * FROM cameras WHERE source_key = ?').get(sourceKey),
      this.secretBox,
    );
  },
nextCameraCode() {
    const codes = this.db.prepare('SELECT code FROM cameras').all();
    const numeric = codes
      .map((row) => Number(String(row.code).replace(/\D/g, '')))
      .filter((value) => Number.isFinite(value));
    return `CAM-${String((numeric.length ? Math.max(...numeric) : 0) + 1).padStart(2, '0')}`;
  },
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
         detect_enabled, detect_sensitivity, detect_roi, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        camera.enabled === false ? 0 : 1,
        timestamp,
        camera.updatedAt ?? timestamp,
      );
    return this.getCamera(camera.id);
  },
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
          enabled = ?, updated_at = ?
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
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return this.getCamera(id);
  },
deleteCamera(id) {
    return this.db.prepare('DELETE FROM cameras WHERE id = ?').run(id).changes > 0;
  },
importCameras(items) {
    return this.transaction(() => {
      const created = [];
      let skipped = 0;
      for (const item of items) {
        const key = sourceFingerprint(item.protocol, item.sourceUrl);
        if (key && this.cameraBySourceKey(key)) {
          skipped += 1;
          continue;
        }
        const camera = this.insertCamera({
          ...item,
          id: crypto.randomUUID(),
          code: this.nextCameraCode(),
          createdAt: now(),
          updatedAt: now(),
        });
        created.push(camera);
      }
      return { created, skipped };
    });
  },
};

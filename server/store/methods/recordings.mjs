import { now } from '../../schema.mjs';

/**
 * 持续录像分段索引的 Store 方法（schema V8）。
 * 约定：文件系统是事实源，本表只是查询缓存；删除只动索引行，
 * 实际文件由调用方（水位清理）负责，避免数据层做磁盘 IO。
 */
export const recordingsMethods = {
  /**
   * 批量补录/校准录像段，返回新增与更新条数。
   * @param {Array<{id?:string, cameraId:string, file:string, startedAt:number,
   *   endedAt:number, bytes:number, protected?:boolean}>} segments
   * @returns {{inserted:number, updated:number}}
   */
  upsertRecordingSegments(segments = []) {
    if (!segments.length) return { inserted: 0, updated: 0 };
    const find = this.db.prepare(
      'SELECT bytes, ended_at, camera_id, started_at FROM recording_segments WHERE file = ?',
    );
    const insert = this.db.prepare(`
      INSERT INTO recording_segments
        (id, camera_id, file, started_at, ended_at, bytes, protected)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const update = this.db.prepare(`
      UPDATE recording_segments
      SET camera_id = ?, started_at = ?, ended_at = ?, bytes = ?
      WHERE file = ?
    `);
    let inserted = 0;
    let updated = 0;
    this.transaction(() => {
      for (const segment of segments) {
        const existing = find.get(segment.file);
        if (!existing) {
          insert.run(
            segment.id ?? segment.file,
            segment.cameraId,
            segment.file,
            segment.startedAt,
            segment.endedAt,
            segment.bytes,
            segment.protected ? 1 : 0,
          );
          inserted += 1;
        } else if (
          existing.bytes !== segment.bytes ||
          existing.ended_at !== segment.endedAt ||
          existing.started_at !== segment.startedAt ||
          existing.camera_id !== segment.cameraId
        ) {
          update.run(
            segment.cameraId,
            segment.startedAt,
            segment.endedAt,
            segment.bytes,
            segment.file,
          );
          updated += 1;
        }
      }
    });
    return { inserted, updated };
  },

  /**
   * 按相机与时间窗查询录像段（半开区间重叠即返回）。
   * @param {{cameraId?:string, from?:number, to?:number, limit?:number}} [options]
   * @returns {Array<{id:string, cameraId:string, file:string, startedAt:number,
   *   endedAt:number, bytes:number, protected:boolean}>}
   */
  listRecordingSegments({ cameraId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 5000 } = {}) {
    const rows = cameraId
      ? this.db
          .prepare(`
            SELECT id, camera_id, file, started_at, ended_at, bytes, protected
            FROM recording_segments
            WHERE camera_id = ? AND started_at < ? AND ended_at > ?
            ORDER BY started_at ASC LIMIT ?
          `)
          .all(cameraId, to, from, limit)
      : this.db
          .prepare(`
            SELECT id, camera_id, file, started_at, ended_at, bytes, protected
            FROM recording_segments
            WHERE started_at < ? AND ended_at > ?
            ORDER BY started_at ASC LIMIT ?
          `)
          .all(to, from, limit);
    return rows.map((row) => ({
      id: row.id,
      cameraId: row.camera_id,
      file: row.file,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      bytes: row.bytes,
      protected: Boolean(row.protected),
    }));
  },

  /** @returns {string[]} 索引内全部相对文件路径（对账用）。 */
  allRecordingSegmentFiles() {
    return this.db
      .prepare('SELECT file FROM recording_segments')
      .all()
      .map((row) => row.file);
  },

  /**
   * 删除索引孤儿记录。
   * @param {string[]} files 相对路径列表。
   * @returns {number} 实际删除条数。
   */
  deleteRecordingSegments(files = []) {
    if (!files.length) return 0;
    const remove = this.db.prepare('DELETE FROM recording_segments WHERE file = ?');
    let deleted = 0;
    this.transaction(() => {
      for (const file of files) deleted += remove.run(file).changes;
    });
    return deleted;
  },

  /**
   * 标记/解除告警保护段。
   * @param {string[]} files 相对路径列表。
   * @param {boolean} protectedFlag 是否保护。
   * @returns {number} 更新条数。
   */
  setRecordingSegmentsProtected(files = [], protectedFlag = true) {
    if (!files.length) return 0;
    const placeholders = files.map(() => '?').join(',');
    return this.db
      .prepare(
        `UPDATE recording_segments SET protected = ? WHERE file IN (${placeholders})`,
      )
      .run(protectedFlag ? 1 : 0, ...files).changes;
  },

  /**
   * 选出可淘汰的最旧非保护段，删除索引行并返回文件路径供调用方删文件。
   * @param {{before?:number, limit?:number}} [options]
   * @returns {string[]} 待删除的相对路径。
   */
  pruneRecordingSegments({ before = now(), limit = 500 } = {}) {
    const rows = this.db
      .prepare(`
        SELECT file FROM recording_segments
        WHERE protected = 0 AND ended_at < ?
        ORDER BY started_at ASC LIMIT ?
      `)
      .all(before, limit);
    const files = rows.map((row) => row.file);
    this.deleteRecordingSegments(files);
    return files;
  },
};

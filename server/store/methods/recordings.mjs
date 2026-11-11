import { now } from '../../schema.mjs';

/**
 * 限量参数夹取。
 *
 * SQLite 中 `LIMIT -1` 表示「不限制」——直接透传会把整表载入内存
 * （listRecordingSegments）或触发一次无确认的全量淘汰（pruneRecordingSegments）。
 * 非法值（NaN / ≤0）回退到默认上限。
 *
 * @param {number|string} limit 原始限量。
 * @param {number} fallback 默认值。
 * @param {number} max 最大值。
 * @returns {number} 合法限量。
 */
function clampLimit(limit, fallback, max) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

/**
 * 持续录像分段索引的 Store 方法（schema V8）。
 * 约定：文件系统是事实源，本表只是查询缓存；删除只动索引行，
 * 实际文件由调用方（水位清理）负责，避免数据层做磁盘 IO。
 */
export const recordingsMethods = {
  /**
   * 批量补录/校准录像段，返回新增与更新条数。
   *
   * 实现要点：
   * - 用单条 `INSERT ... ON CONFLICT(file) DO UPDATE` 完成 upsert，
   *   避免「先查后写」的 N+1 次同步查询；
   * - 分批提交（每批 200 段一个事务），大批量对账时不会长时间独占写锁
   *   并冻结事件循环（node:sqlite 是同步驱动）。
   *
   * @param {Array<{id?:string, cameraId:string, file:string, startedAt:number,
   *   endedAt:number, bytes:number, protected?:boolean}>} segments
   * @returns {{inserted:number, updated:number}}
   */
  upsertRecordingSegments(segments = []) {
    if (!segments.length) return { inserted: 0, updated: 0 };
    const upsert = this.db.prepare(`
      INSERT INTO recording_segments
        (id, camera_id, file, started_at, ended_at, bytes, protected)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file) DO UPDATE SET
        camera_id = excluded.camera_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        bytes = excluded.bytes
    `);
    const exists = this.db.prepare(
      'SELECT bytes, ended_at, camera_id, started_at FROM recording_segments WHERE file = ?',
    );
    let inserted = 0;
    let updated = 0;
    const batchSize = 200;
    for (let offset = 0; offset < segments.length; offset += batchSize) {
      const batch = segments.slice(offset, offset + batchSize);
      this.transaction(() => {
        for (const segment of batch) {
          const existing = exists.get(segment.file);
          upsert.run(
            segment.id ?? segment.file,
            segment.cameraId,
            segment.file,
            segment.startedAt,
            segment.endedAt,
            segment.bytes,
            segment.protected ? 1 : 0,
          );
          if (!existing) {
            inserted += 1;
          } else if (
            existing.bytes !== segment.bytes ||
            existing.ended_at !== segment.endedAt ||
            existing.started_at !== segment.startedAt ||
            existing.camera_id !== segment.cameraId
          ) {
            updated += 1;
          }
        }
      });
    }
    return { inserted, updated };
  },

  /**
   * 按相机与时间窗查询录像段（半开区间重叠即返回）。
   * @param {{cameraId?:string, from?:number, to?:number, limit?:number}} [options]
   * @returns {Array<{id:string, cameraId:string, file:string, startedAt:number,
   *   endedAt:number, bytes:number, protected:boolean}>}
   */
  listRecordingSegments({ cameraId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 5000 } = {}) {
    // LIMIT 在 SQLite 中传 -1 表示「不限制」，会把整表载入内存；
    // 这里统一夹取到 1..10000，与其它 store 方法的防御口径一致。
    const safeLimit = clampLimit(limit, 5000, 10_000);
    const rows = cameraId
      ? this.db
          .prepare(`
            SELECT id, camera_id, file, started_at, ended_at, bytes, protected
            FROM recording_segments
            WHERE camera_id = ? AND started_at < ? AND ended_at > ?
            ORDER BY started_at ASC LIMIT ?
          `)
          .all(cameraId, to, from, safeLimit)
      : this.db
          .prepare(`
            SELECT id, camera_id, file, started_at, ended_at, bytes, protected
            FROM recording_segments
            WHERE started_at < ? AND ended_at > ?
            ORDER BY started_at ASC LIMIT ?
          `)
          .all(to, from, safeLimit);
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
   * 对账用的索引快照：返回每段的对比键，供 reconcile 只处理变化段。
   *
   * 背景：每 5 分钟的对账原本把**全部**扫描段无差别交给
   * upsertRecordingSegments（逐条 SELECT + INSERT ON CONFLICT），
   * 5 万段实测冻结事件循环约 3.3 秒。绝大多数段两轮之间完全没变化，
   * 全量写入是纯粹的浪费。
   *
   * @returns {Map<string, {bytes:number, endedAt:number, startedAt:number, cameraId:string}>}
   */
  allRecordingSegmentSnapshot() {
    const rows = this.db
      .prepare('SELECT file, bytes, ended_at, started_at, camera_id FROM recording_segments')
      .all();
    return new Map(
      rows.map((row) => [
        row.file,
        {
          bytes: row.bytes,
          endedAt: row.ended_at,
          startedAt: row.started_at,
          cameraId: row.camera_id,
        },
      ]),
    );
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
   * 删除某点位的全部录像索引（点位被删除时调用）。
   *
   * 旧实现删除点位只删 `streams/<id>`，`continuous/<id>` 目录与索引行会一直
   * 留到按天保留策略（默认 14 天）自然淘汰 —— 属于有界的磁盘泄漏。
   * 这里提供按 camera_id 精确清理的入口。
   *
   * @param {string} cameraId 点位 ID。
   * @returns {{files: string[], deleted: number}} 被删索引对应的文件（相对路径）与条数。
   */
  deleteRecordingSegmentsByCamera(cameraId) {
    if (!cameraId) return { files: [], deleted: 0 };
    const files = this.db
      .prepare('SELECT file FROM recording_segments WHERE camera_id = ?')
      .all(cameraId)
      .map((row) => row.file);
    const deleted = this.db
      .prepare('DELETE FROM recording_segments WHERE camera_id = ?')
      .run(cameraId).changes;
    return { files, deleted };
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
   * 选出可淘汰的最旧段，删除索引行并返回文件路径供调用方删文件。
   *
   * 默认只淘汰**非保护**段（保护段是告警取证证据，默认不动）。
   * `includeProtected: true` 用于**磁盘超配额**时的兜底：此时连保护段也要淘汰，
   * 否则 `recordingMaxBytes` 这道保险对「有过告警的摄像头」完全失效——
   * 而那恰恰是段数量最多、占用最大的点位。
   *
   * @param {{before?:number, limit?:number, includeProtected?:boolean}} [options]
   * @returns {string[]} 待删除的相对路径。
   */
  pruneRecordingSegments({ before = now(), limit = 500, includeProtected = false } = {}) {
    // 淘汰上限同样夹取：limit=-1 会把全部非保护段一次性取出并全部删除索引行，
    // 属于一次无确认的全量淘汰。
    const safeLimit = clampLimit(limit, 500, 10_000);
    const rows = this.db
      .prepare(`
        SELECT file FROM recording_segments
        WHERE ${includeProtected ? '1 = 1' : 'protected = 0'} AND ended_at < ?
        ORDER BY started_at ASC LIMIT ?
      `)
      .all(before, safeLimit);
    const files = rows.map((row) => row.file);
    this.deleteRecordingSegments(files);
    return files;
  },

  /**
   * 告警保护段联动：把告警时刻前后窗口内与该点位重叠的段标记为 protected。
   * @param {{cameraId?:string, from:number, to:number}} options
   * @returns {number} 新受保护的段数。
   */
  protectSegmentsAround({ cameraId, from, to }) {
    if (!cameraId || !(to > from)) return 0;
    return this.db
      .prepare(`
        UPDATE recording_segments SET protected = 1
        WHERE camera_id = ? AND protected = 0 AND started_at < ? AND ended_at > ?
      `)
      .run(cameraId, to, from).changes;
  },

  /**
   * 解除超过保留期的保护（归档告警的录像在保护期后重新可被水位淘汰）。
   * @param {number} before epoch ms
   * @returns {number} 解除条数。
   */
  unprotectExpiredSegments(before = now()) {
    return this.db
      .prepare('UPDATE recording_segments SET protected = 0 WHERE protected = 1 AND ended_at < ?')
      .run(before).changes;
  },

  /** @returns {{files:number, bytes:number, protectedFiles:number}} 索引用量快照。 */
  recordingUsage() {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes,
               COALESCE(SUM(CASE WHEN protected = 1 THEN 1 ELSE 0 END), 0) AS protected_files
        FROM recording_segments
      `)
      .get();
    return {
      files: row.files,
      bytes: row.bytes,
      protectedFiles: row.protected_files,
    };
  },
};

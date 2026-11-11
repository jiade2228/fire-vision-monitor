import { now } from '../../schema.mjs';

/**
 * SQLite 单条语句的绑定变量上限（默认 32766）。
 * 批量删除时按此上限分片，避免 "too many SQL variables" 直接打断清理任务。
 */
const MAX_SQL_VARIABLES = 30_000;

/**
 * 把 ID 列表按分片大小切分。
 * @param {string[]} ids ID 列表。
 * @param {number} size 每片大小。
 * @returns {string[][]} 分片后的 ID 列表。
 */
function chunkIds(ids, size = MAX_SQL_VARIABLES) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export const maintenanceMethods = {
  /**
   * 采集查询统计信息（sqlite_stat1）。
   *
   * 统计信息决定 SQLite 的查询计划：没有它时，部分索引（idx_alarm_media_old）
   * 会被规划器忽略，退回「全表扫描 + 临时排序」。
   * 数据量增长后统计信息会失真，需要定期刷新。
   *
   * @returns {boolean} 是否成功刷新（失败不抛异常，由调用方决定是否告警）。
   */
  analyze() {
    try {
      this.db.exec('ANALYZE');
      return true;
    } catch {
      // 统计信息只影响性能，失败不应中断维护流程。
      return false;
    }
  },
  /**
   * 清理超期的已关闭告警，返回需要删除的媒体文件名。
   * @param {{retainDays?: number, at?: number}} [options]
   * @returns {{deleted: number, snapshots: string[], clips: string[], events: number, notifications: number}}
   */
pruneAlarms({ retainDays = 180, at = now() } = {}) {
    const cutoff = at - retainDays * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(`
        SELECT id, snapshot_file, clip_file FROM alarms
        WHERE created_at < ? AND status IN ('archived','false')
        LIMIT 5000
      `)
      .all(cutoff);
    if (!rows.length) return { deleted: 0, snapshots: [], clips: [], events: 0, notifications: 0 };
    const alarmIds = rows.map((row) => row.id);
    // 告警删除必须级联清理事件与推送日志，否则这些表会留下指向已删告警的孤儿记录。
    // 分片执行：一次 IN (...) 的绑定变量过多会触发 "too many SQL variables"。
    let events = 0;
    let notifications = 0;
    for (const chunk of chunkIds(alarmIds)) {
      const placeholders = chunk.map(() => '?').join(',');
      const remove = this.db.prepare('DELETE FROM alarms WHERE id = ?');
      const removeEvents = this.db.prepare(
        `DELETE FROM alarm_events WHERE alarm_id IN (${placeholders})`,
      );
      const removeNotifications = this.db.prepare(
        `DELETE FROM notification_logs WHERE alarm_id IN (${placeholders})`,
      );
      this.transaction(() => {
        events += removeEvents.run(...chunk).changes;
        notifications += removeNotifications.run(...chunk).changes;
        for (const id of chunk) remove.run(id);
      });
    }
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
      events,
      notifications,
    };
  },
/**
 * 演示数据清理：删除演示点位产生的告警及其事件、推送日志与媒体文件引用。
 * 口径为「camera_id 命中历史演示点位」或「camera_name 等于演示点位名」双取，
 * 避免演示点位删除后（camera_id 变孤儿）漏清；真实告警不受影响。
 * 审计日志保留（操作留痕不因清理而消失）。调用方负责删物理媒体文件。
 * @param {{cameraIds?: string[], cameraName?: string}} [options]
 * @returns {{deleted: number, snapshots: string[], clips: string[], events: number, notifications: number}}
 */
purgeDemoAlarms({ cameraIds = [], cameraName = '' } = {}) {
    const ids = [...new Set(cameraIds.filter((id) => typeof id === 'string' && id))];
    const where = [];
    const params = [];
    if (ids.length) {
      where.push(`camera_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (cameraName) {
      where.push('camera_name = ?');
      params.push(cameraName);
    }
    if (!where.length) return { deleted: 0, snapshots: [], clips: [], notifications: 0, events: 0 };
    // 分页读取：演示告警量可能很大，一次性 SELECT 全部 ID 会让 IN(...) 的
    // 绑定变量超过 SQLite 上限（too many SQL variables）而中断清理。
    const rows = [];
    const pageSize = 2000;
    for (;;) {
      const page = this.db
        .prepare(
          `SELECT id, snapshot_file, clip_file FROM alarms WHERE ${where.join(' OR ')}
           ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, rows.length);
      if (!page.length) break;
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    if (!rows.length) {
      return { deleted: 0, snapshots: [], clips: [], notifications: 0, events: 0 };
    }
    const alarmIds = rows.map((row) => row.id);
    let events = 0;
    let notifications = 0;
    for (const chunk of chunkIds(alarmIds)) {
      const placeholders = chunk.map(() => '?').join(',');
      const removeAlarm = this.db.prepare('DELETE FROM alarms WHERE id = ?');
      const removeEvents = this.db.prepare(
        `DELETE FROM alarm_events WHERE alarm_id IN (${placeholders})`,
      );
      const removeNotifications = this.db.prepare(
        `DELETE FROM notification_logs WHERE alarm_id IN (${placeholders})`,
      );
      this.transaction(() => {
        events += removeEvents.run(...chunk).changes;
        notifications += removeNotifications.run(...chunk).changes;
        for (const id of chunk) removeAlarm.run(id);
      });
    }
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
      notifications,
      events,
    };
  },
/**
 * 统计演示告警数量与媒体文件数，供前端按钮展示「将清除什么」。
 * @param {{cameraIds?: string[], cameraName?: string}} [options]
 * @returns {{alarms: number, snapshots: number, clips: number}}
 */
countDemoAlarms({ cameraIds = [], cameraName = '' } = {}) {
    const ids = [...new Set(cameraIds.filter((id) => typeof id === 'string' && id))];
    const where = [];
    const params = [];
    if (ids.length) {
      where.push(`camera_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (cameraName) {
      where.push('camera_name = ?');
      params.push(cameraName);
    }
    if (!where.length) return { alarms: 0, snapshots: 0, clips: 0 };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS alarms,
                SUM(CASE WHEN snapshot_file IS NOT NULL THEN 1 ELSE 0 END) AS snapshots,
                SUM(CASE WHEN clip_file IS NOT NULL THEN 1 ELSE 0 END) AS clips
         FROM alarms WHERE ${where.join(' OR ')}`,
      )
      .get(...params);
    return {
      alarms: Number(row?.alarms ?? 0),
      snapshots: Number(row?.snapshots ?? 0),
      clips: Number(row?.clips ?? 0),
    };
  },
  /**
   * 磁盘水位：从最老的已关闭告警开始清掉媒体文件（保留告警记录本身），
   * 返回被清空的文件名，调用方负责删除物理文件。
   *
   * PERF-3：改为「一次 SELECT + 一条批量 UPDATE」。
   * 原实现逐行 UPDATE，一轮 100 条就是 100 次语句往返；
   * 调用方还要循环 20 轮，合计 2000 次 UPDATE，把磁盘水位清理拖到十几秒。
   * 现在一次取一批 ID，用 `id IN (...)` 一条语句批量置空。
   *
   * @param {number} [limit] 单次清理上限（1-1000），默认 100。
   * @returns {{alarms: number, files: string[]}}
   */
  clearOldestAlarmMedia(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const rows = this.db
      .prepare(`
        SELECT id, snapshot_file, clip_file FROM alarms
        WHERE status IN ('archived','false')
          AND (snapshot_file IS NOT NULL OR clip_file IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(safeLimit);
    if (!rows.length) return { alarms: 0, files: [] };
    const timestamp = now();
    const files = [];
    for (const row of rows) {
      if (row.snapshot_file) files.push(row.snapshot_file);
      if (row.clip_file) files.push(row.clip_file);
    }
    // 分片执行：一次 IN (...) 的绑定变量过多会触发 "too many SQL variables"。
    this.transaction(() => {
      for (const chunk of chunkIds(rows.map((row) => row.id))) {
        const placeholders = chunk.map(() => '?').join(',');
        this.db
          .prepare(
            `UPDATE alarms SET snapshot_file = NULL, clip_file = NULL, updated_at = ?
             WHERE id IN (${placeholders})`,
          )
          .run(timestamp, ...chunk);
      }
    });
    return { alarms: rows.length, files };
  },
};

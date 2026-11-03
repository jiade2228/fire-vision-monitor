import { now } from '../../schema.mjs';

export const maintenanceMethods = {
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
    const placeholders = alarmIds.map(() => '?').join(',');
    const remove = this.db.prepare('DELETE FROM alarms WHERE id = ?');
    const removeEvents = this.db.prepare(
      `DELETE FROM alarm_events WHERE alarm_id IN (${placeholders})`,
    );
    const removeNotifications = this.db.prepare(
      `DELETE FROM notification_logs WHERE alarm_id IN (${placeholders})`,
    );
    let events = 0;
    let notifications = 0;
    this.transaction(() => {
      // 告警删除必须级联清理事件与推送日志，否则这些表会留下指向已删告警的孤儿记录。
      events = removeEvents.run(...alarmIds).changes;
      notifications = removeNotifications.run(...alarmIds).changes;
      for (const id of alarmIds) remove.run(id);
    });
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
      events,
      notifications,
    };
  },
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
    const rows = this.db
      .prepare(
        `SELECT id, snapshot_file, clip_file FROM alarms WHERE ${where.join(' OR ')}`,
      )
      .all(...params);
    if (!rows.length) {
      return { deleted: 0, snapshots: [], clips: [], notifications: 0, events: 0 };
    }
    const alarmIds = rows.map((row) => row.id);
    const placeholders = alarmIds.map(() => '?').join(',');
    const removeAlarm = this.db.prepare('DELETE FROM alarms WHERE id = ?');
    const removeEvents = this.db.prepare(
      `DELETE FROM alarm_events WHERE alarm_id IN (${placeholders})`,
    );
    const removeNotifications = this.db.prepare(
      `DELETE FROM notification_logs WHERE alarm_id IN (${placeholders})`,
    );
    let events = 0;
    let notifications = 0;
    this.transaction(() => {
      events = removeEvents.run(...alarmIds).changes;
      notifications = removeNotifications.run(...alarmIds).changes;
      for (const id of alarmIds) removeAlarm.run(id);
    });
    return {
      deleted: rows.length,
      snapshots: rows.map((row) => row.snapshot_file).filter(Boolean),
      clips: rows.map((row) => row.clip_file).filter(Boolean),
      notifications,
      events,
    };
  },
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
    const clear = this.db.prepare(
      'UPDATE alarms SET snapshot_file = NULL, clip_file = NULL, updated_at = ? WHERE id = ?',
    );
    const files = [];
    this.transaction(() => {
      for (const row of rows) {
        clear.run(timestamp, row.id);
        if (row.snapshot_file) files.push(row.snapshot_file);
        if (row.clip_file) files.push(row.clip_file);
      }
    });
    return { alarms: rows.length, files };
  },
};

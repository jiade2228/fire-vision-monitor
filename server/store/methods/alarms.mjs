import crypto from 'node:crypto';
import { now } from '../../schema.mjs';
import { alarmRowToObject } from '../helpers.mjs';

export const alarmMethods = {
listAlarms(limit = 300, { allowedSiteIds = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    if (allowedSiteIds !== null && allowedSiteIds.length === 0) {
      return [];
    }
    // 直接按告警自身的 site_id 过滤：删除点位后历史告警仍可见，也不再依赖 JOIN。
    const where = allowedSiteIds
      ? 'WHERE a.site_id IN (' + allowedSiteIds.map(() => '?').join(',') + ')'
      : '';
    const params = allowedSiteIds ? [...allowedSiteIds, safeLimit] : [safeLimit];
    return this.db
      .prepare(
        `SELECT a.* FROM alarms a ${where} ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...params)
      .map(alarmRowToObject);
  },
getAlarm(id) {
    return alarmRowToObject(
      this.db.prepare('SELECT * FROM alarms WHERE id = ?').get(id),
    );
  },
activeAlarmForCamera(cameraId) {
    return alarmRowToObject(
      this.db
        .prepare(
          "SELECT * FROM alarms WHERE camera_id = ? AND status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 1",
        )
        .get(cameraId),
    );
  },
listPendingAlarmsOlderThan(cutoff, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return this.db
      .prepare(
        "SELECT * FROM alarms WHERE status = 'pending' AND created_at <= ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(cutoff, safeLimit)
      .map(alarmRowToObject);
  },
hasAlarmEvent(alarmId, action) {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS ok FROM alarm_events WHERE alarm_id = ? AND action = ? LIMIT 1',
        )
        .get(alarmId, action),
    );
  },
alarmStatsBetween(start, end) {
    return this.db
      .prepare(`
        SELECT site_id AS siteId, level, status, COUNT(*) AS count
        FROM alarms
        WHERE created_at >= ? AND created_at < ?
        GROUP BY site_id, level, status
      `)
      .all(start, end);
  },
alarmStatsByDay({ days = 30, siteIds = null, endAt = now() } = {}) {
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 366);
    const endShanghai = new Date(endAt + 8 * 3600 * 1000);
    const lastDayUtc = Date.UTC(
      endShanghai.getUTCFullYear(),
      endShanghai.getUTCMonth(),
      endShanghai.getUTCDate(),
    );
    const firstDayUtc = lastDayUtc - (safeDays - 1) * 86_400_000;
    const start = firstDayUtc - 8 * 3600 * 1000;
    const end = lastDayUtc + 86_400_000 - 8 * 3600 * 1000;
    const clauses = ['created_at >= ?', 'created_at < ?'];
    const values = [start, end];
    if (siteIds !== null) {
      if (!siteIds.length) return [];
      const placeholders = siteIds.map(() => '?').join(',');
      clauses.push(`COALESCE(site_id, ?) IN (${placeholders})`);
      values.push(this.defaultSiteId, ...siteIds);
    }
    return this.db
      .prepare(`
        SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day,
               COALESCE(site_id, ?) AS siteId, level, status, COUNT(*) AS count
        FROM alarms
        WHERE ${clauses.join(' AND ')}
        GROUP BY day, siteId, level, status
        ORDER BY day ASC
      `)
      .all(this.defaultSiteId, ...values);
  },
createAlarm(alarm) {
    const timestamp = alarm.createdAt ?? now();
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO alarms
          (id, camera_id, camera_name, zone, site_id, level, confidence, hotspot_x, hotspot_y,
           snapshot_file, clip_file, status, note, steps_json, created_at, updated_at,
           created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?, ?)
        `)
        .run(
          alarm.id,
          alarm.cameraId,
          alarm.cameraName,
          alarm.zone,
          alarm.siteId ?? null,
          alarm.level,
          alarm.confidence,
          alarm.hotspot.x,
          alarm.hotspot.y,
          alarm.snapshotFile ?? null,
          alarm.clipFile ?? null,
          JSON.stringify(alarm.steps ?? [false, false, false, false]),
          timestamp,
          timestamp,
          alarm.actor?.id ?? null,
          alarm.actor?.id ?? null,
        );
      this.addAlarmEvent(
        alarm.id,
        alarm.actor,
        'created',
        alarm.eventDetail ?? '识别引擎生成告警',
      );
    });
    return this.getAlarm(alarm.id);
  },
updateAlarm(id, changes, actor) {
    const current = this.getAlarm(id);
    if (!current) return null;
    const fields = ['updated_at = ?'];
    const values = [now()];
    if (changes.status !== undefined) {
      fields.push('status = ?');
      values.push(changes.status);
    }
    if (changes.note !== undefined) {
      fields.push('note = ?');
      values.push(changes.note);
    }
    if (changes.steps !== undefined) {
      fields.push('steps_json = ?');
      values.push(JSON.stringify(changes.steps));
    }
    if (changes.confirmedAt !== undefined) {
      fields.push('confirmed_at = ?');
      values.push(changes.confirmedAt);
    }
    if (changes.falseAt !== undefined) {
      fields.push('false_at = ?');
      values.push(changes.falseAt);
    }
    if (changes.archivedAt !== undefined) {
      fields.push('archived_at = ?');
      values.push(changes.archivedAt);
    }
    fields.push('updated_by = ?');
    values.push(actor?.id ?? null);
    values.push(id);
    this.db
      .prepare(`UPDATE alarms SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
    return this.getAlarm(id);
  },
setAlarmClip(id, clipFile) {
    this.db
      .prepare('UPDATE alarms SET clip_file = ?, updated_at = ? WHERE id = ?')
      .run(clipFile ?? null, now(), id);
    return this.getAlarm(id);
  },
addAlarmEvent(alarmId, actor, action, detail = '') {
    this.db
      .prepare(`
        INSERT INTO alarm_events (id, alarm_id, user_id, username, action, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        alarmId,
        actor?.id ?? null,
        actor?.username ?? null,
        action,
        String(detail).slice(0, 500),
        now(),
      );
  },
listAlarmEvents(alarmId) {
    return this.db
      .prepare(
        'SELECT * FROM alarm_events WHERE alarm_id = ? ORDER BY created_at ASC',
      )
      .all(alarmId);
  },
};

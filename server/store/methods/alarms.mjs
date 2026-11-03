import crypto from 'node:crypto';
import { now } from '../../schema.mjs';
import { alarmRowToObject } from '../helpers.mjs';

export const alarmMethods = {
/**
 * 告警列表（新→旧），支持按可见站点集合过滤。
 * @param {number} [limit] 返回条数上限，默认 300。
 * @param {{allowedSiteIds?: string[]|null}} [query]
 * @returns {import('../../types.mjs').Alarm[]}
 */
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
/**
 * @param {string} id 告警 ID。
 * @returns {import('../../types.mjs').Alarm|null}
 */
getAlarm(id) {
    return alarmRowToObject(
      this.db.prepare('SELECT * FROM alarms WHERE id = ?').get(id),
    );
  },
/**
 * 同一点位当前未处置的告警（生成新告警前查重）。
 * @param {string} cameraId 点位 ID。
 * @returns {import('../../types.mjs').Alarm|null}
 */
activeAlarmForCamera(cameraId) {
    return alarmRowToObject(
      this.db
        .prepare(
          "SELECT * FROM alarms WHERE camera_id = ? AND status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 1",
        )
        .get(cameraId),
    );
  },
/**
 * 超过指定时间仍未确认的告警，用于升级提醒。
 * @param {number} cutoff 毫秒时间戳。
 * @param {number} [limit] 返回条数上限，默认 200。
 * @returns {import('../../types.mjs').Alarm[]}
 */
listPendingAlarmsOlderThan(cutoff, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return this.db
      .prepare(
        "SELECT * FROM alarms WHERE status = 'pending' AND created_at <= ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(cutoff, safeLimit)
      .map(alarmRowToObject);
  },
/**
 * 某告警是否已发生过指定动作（升级去重用）。
 * @param {string} alarmId 告警 ID。
 * @param {string} action 动作名。
 * @returns {boolean}
 */
hasAlarmEvent(alarmId, action) {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS ok FROM alarm_events WHERE alarm_id = ? AND action = ? LIMIT 1',
        )
        .get(alarmId, action),
    );
  },
/**
 * 按站点/级别/状态聚合时间段内的告警数量，供每日摘要使用。
 * @param {number} start 起始毫秒时间戳（含）。
 * @param {number} end 结束毫秒时间戳（不含）。
 * @returns {Array<{siteId: string|null, level: string, status: string, count: number}>}
 */
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
/**
 * 按上海时区按天聚合告警（含空缺的日期无行），供趋势看板使用。
 * @param {{days?: number, siteIds?: string[]|null, endAt?: number}} [options]
 * @returns {Array<{date: string, siteId: string, level: string, status: string, count: number}>}
 */
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
/**
 * 落库一条新告警并写入 created 事件（事务）。
 * @param {object} alarm 生成参数（含 id/cameraId/level/hotspot 等）。
 * @returns {import('../../types.mjs').Alarm}
 */
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
/**
 * 处置告警（状态/备注/四步勾选/时间戳），并记录 updated_by。
 * @param {string} id 告警 ID。
 * @param {Partial<import('../../types.mjs').Alarm>} changes 变更字段。
 * @param {{id?: string}|null} [actor] 操作人。
 * @returns {import('../../types.mjs').Alarm|null}
 */
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
/**
 * 命中后补录完成时回填短视频文件名。
 * @param {string} id 告警 ID。
 * @param {string|null} clipFile 文件名。
 * @returns {import('../../types.mjs').Alarm|null}
 */
setAlarmClip(id, clipFile) {
    this.db
      .prepare('UPDATE alarms SET clip_file = ?, updated_at = ? WHERE id = ?')
      .run(clipFile ?? null, now(), id);
    return this.getAlarm(id);
  },
/**
 * 追加告警事件流水。
 * @param {string} alarmId 告警 ID。
 * @param {{id?: string, username?: string}|null} actor 操作人。
 * @param {string} action 动作名。
 * @param {string} [detail] 描述（最长 500 字）。
 * @returns {void}
 */
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
/**
 * 告警事件流水（旧→新）。
 * @param {string} alarmId 告警 ID。
 * @returns {import('../../types.mjs').AlarmEvent[]}
 */
listAlarmEvents(alarmId) {
    return this.db
      .prepare(
        'SELECT * FROM alarm_events WHERE alarm_id = ? ORDER BY created_at ASC',
      )
      .all(alarmId);
  },
};

import crypto from 'node:crypto';
import { now, bool } from '../../schema.mjs';

export const notifyMethods = {
notifyChannelRowToObject(row) {
    if (!row) return null;
    const decode = (value) => {
      if (!value) return '';
      if (!value.startsWith('enc:v1:')) return value;
      try {
        return this.secretBox.decrypt(value);
      } catch {
        return '';
      }
    };
    return {
      id: row.id,
      siteId: row.site_id ?? null,
      kind: row.kind,
      name: row.name,
      url: decode(row.url),
      secret: row.secret ? decode(row.secret) : '',
      enabled: bool(row.enabled),
      templateId: row.template_id ?? null,
      templateBody: row.template_id ? this.getNotificationTemplateBody(row.template_id) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
listNotifyChannels() {
    return this.db
      .prepare('SELECT * FROM notify_channels ORDER BY created_at ASC')
      .all()
      .map((row) => this.notifyChannelRowToObject(row));
  },
getNotifyChannel(id) {
    return this.notifyChannelRowToObject(
      this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id),
    );
  },
createNotifyChannel(channel) {
    const id = channel.id ?? crypto.randomUUID();
    const timestamp = channel.createdAt ?? now();
    this.db
      .prepare(`
        INSERT INTO notify_channels
        (id, site_id, kind, name, url, secret, enabled, template_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        channel.siteId || null,
        channel.kind,
        channel.name,
        this.secretBox.encrypt(channel.url),
        channel.secret ? this.secretBox.encrypt(channel.secret) : null,
        channel.enabled === false ? 0 : 1,
        channel.templateId || null,
        timestamp,
        timestamp,
      );
    return this.getNotifyChannel(id);
  },
updateNotifyChannel(id, changes = {}) {
    const current = this.getNotifyChannel(id);
    if (!current) return null;
    const sets = ['updated_at = ?'];
    const values = [now()];
    if (changes.name !== undefined) {
      sets.push('name = ?');
      values.push(changes.name);
    }
    if (changes.kind !== undefined) {
      sets.push('kind = ?');
      values.push(changes.kind);
    }
    if (changes.siteId !== undefined) {
      sets.push('site_id = ?');
      values.push(changes.siteId || null);
    }
    if (changes.url !== undefined) {
      sets.push('url = ?');
      values.push(this.secretBox.encrypt(changes.url));
    }
    if (changes.secret !== undefined) {
      sets.push('secret = ?');
      values.push(changes.secret ? this.secretBox.encrypt(changes.secret) : null);
    }
    if (changes.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(changes.enabled ? 1 : 0);
    }
    if (changes.templateId !== undefined) {
      sets.push('template_id = ?');
      values.push(changes.templateId || null);
    }
    values.push(id);
    this.db.prepare(`UPDATE notify_channels SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getNotifyChannel(id);
  },
deleteNotifyChannel(id) {
    this.db.prepare('DELETE FROM notification_logs WHERE channel_id = ?').run(id);
    return this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes > 0;
  },
getNotificationTemplateBody(id) {
    const row = this.db
      .prepare('SELECT body FROM notification_templates WHERE id = ?')
      .get(id);
    return row ? row.body : null;
  },
listNotificationTemplates() {
    return this.db
      .prepare(
        'SELECT * FROM notification_templates ORDER BY builtin DESC, created_at ASC',
      )
      .all()
      .map((row) => this.notificationTemplateRowToObject(row));
  },
getNotificationTemplate(id) {
    const row = this.db
      .prepare('SELECT * FROM notification_templates WHERE id = ?')
      .get(id);
    return row ? this.notificationTemplateRowToObject(row) : null;
  },
createNotificationTemplate({ name, body }) {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO notification_templates
         (id, name, body, builtin, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, body, timestamp, timestamp);
    return this.getNotificationTemplate(id);
  },
updateNotificationTemplate(id, { name, body } = {}) {
    const current = this.getNotificationTemplate(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE notification_templates SET name = ?, body = ?, updated_at = ? WHERE id = ?`,
      )
      .run(name ?? current.name, body ?? current.body, now(), id);
    return this.getNotificationTemplate(id);
  },
deleteNotificationTemplate(id) {
    const current = this.getNotificationTemplate(id);
    if (!current) return false;
    // 删除模板后，引用它的渠道回退到默认文案（template_id 置空）。
    this.db
      .prepare('UPDATE notify_channels SET template_id = NULL WHERE template_id = ?')
      .run(id);
    return (
      this.db.prepare('DELETE FROM notification_templates WHERE id = ?').run(id).changes > 0
    );
  },
notificationTemplateRowToObject(row) {
    return {
      id: row.id,
      name: row.name,
      body: row.body,
      builtin: bool(row.builtin),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
channelsForSite(siteId) {
    const rows = siteId
      ? this.db
          .prepare(
            'SELECT * FROM notify_channels WHERE enabled = 1 AND (site_id = ? OR site_id IS NULL) ORDER BY created_at ASC',
          )
          .all(siteId)
      : this.db
          .prepare('SELECT * FROM notify_channels WHERE enabled = 1 AND site_id IS NULL ORDER BY created_at ASC')
          .all();
    return rows.map((row) => this.notifyChannelRowToObject(row));
  },
claimNotification(alarmId, channelId, event) {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO notification_logs
        (id, alarm_id, channel_id, event, status, error, created_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?)
      `)
      .run(crypto.randomUUID(), alarmId, channelId, event, now());
    return result.changes > 0;
  },
finishNotification(alarmId, channelId, event, { status, error = null }) {
    this.db
      .prepare(`
        UPDATE notification_logs SET status = ?, error = ?
        WHERE alarm_id = ? AND channel_id = ? AND event = ?
      `)
      .run(status, error ? String(error).slice(0, 500) : null, alarmId, channelId, event);
  },
consecutiveFailures(channelId, sinceTs = 0, limit = 32) {
    const rows = this.db
      .prepare(`
        SELECT status FROM notification_logs
        WHERE channel_id = ? AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(channelId, sinceTs, limit);
    let count = 0;
    for (const row of rows) {
      if (row.status !== 'failed') break;
      count += 1;
    }
    return count;
  },
listNotificationLogs(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return this.db
      .prepare(`
        SELECT l.*, c.name AS channel_name, c.kind AS channel_kind
        FROM notification_logs l
        LEFT JOIN notify_channels c ON c.id = l.channel_id
        ORDER BY l.created_at DESC LIMIT ?
      `)
      .all(safeLimit)
      .map((row) => ({
        id: row.id,
        alarmId: row.alarm_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelKind: row.channel_kind,
        event: row.event,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
      }));
  },
pruneNotificationLogs(retainDays = 30) {
    const cutoff = now() - retainDays * 24 * 60 * 60 * 1000;
    return Number(
      this.db.prepare('DELETE FROM notification_logs WHERE created_at < ?').run(cutoff)
        .changes,
    );
  },
};

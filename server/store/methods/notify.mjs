import crypto from 'node:crypto';
import { now, bool } from '../../schema.mjs';

export const notifyMethods = {
  /**
   * 行对象 → 渠道对象（解密 url/secret，内联模板正文）。
   *
   * 解密失败（密钥轮换、数据库局部损坏）**不再**静默降级为空字符串：
   * 那样推送会带着空地址被跳过，运维只能看到「没收到告警」却找不到根因。
   * 这里显式记录 credentialError，由调用方记录日志并跳过该渠道。
   *
   * @param {object|null} row notify_channels 行。
   * @returns {import('../../types.mjs').NotifyChannel|null}
   */
  notifyChannelRowToObject(row) {
    if (!row) return null;
    let credentialError = '';
    const decode = (value, label) => {
      if (!value) return '';
      if (!value.startsWith('enc:v1:')) return value;
      try {
        return this.secretBox.decrypt(value);
      } catch {
        credentialError = `${label}解密失败（密钥可能已更换或数据损坏）`;
        return '';
      }
    };
    const url = decode(row.url, '推送地址');
    const secret = row.secret ? decode(row.secret, '签名密钥') : '';
    return {
      id: row.id,
      siteId: row.site_id ?? null,
      kind: row.kind,
      name: row.name,
      url,
      secret,
      enabled: bool(row.enabled),
      templateId: row.template_id ?? null,
      templateBody: row.template_id ? this.getNotificationTemplateBody(row.template_id) : null,
      credentialError,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
/**
 * 全部通知渠道（按创建时间升序）。
 * @returns {import('../../types.mjs').NotifyChannel[]}
 */
listNotifyChannels() {
    return this.db
      .prepare('SELECT * FROM notify_channels ORDER BY created_at ASC')
      .all()
      .map((row) => this.notifyChannelRowToObject(row));
  },
/**
 * @param {string} id 渠道 ID。
 * @returns {import('../../types.mjs').NotifyChannel|null}
 */
getNotifyChannel(id) {
    return this.notifyChannelRowToObject(
      this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id),
    );
  },
/**
 * 新建通知渠道（url/secret 加密存储）。
 * @param {Partial<import('../../types.mjs').NotifyChannel>} channel
 * @returns {import('../../types.mjs').NotifyChannel}
 */
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
/**
 * 更新通知渠道（仅处理传入字段；url/secret 变更重新加密）。
 * @param {string} id 渠道 ID。
 * @param {Partial<import('../../types.mjs').NotifyChannel>} [changes]
 * @returns {import('../../types.mjs').NotifyChannel|null}
 */
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
/**
 * 删除渠道及其推送日志记录。
 * @param {string} id 渠道 ID。
 * @returns {boolean} 是否删除成功。
 */
deleteNotifyChannel(id) {
    this.db.prepare('DELETE FROM notification_logs WHERE channel_id = ?').run(id);
    return this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes > 0;
  },
/**
 * 仅取模板正文（供渠道对象内联解析）。
 * @param {string} id 模板 ID。
 * @returns {string|null}
 */
getNotificationTemplateBody(id) {
    const row = this.db
      .prepare('SELECT body FROM notification_templates WHERE id = ?')
      .get(id);
    return row ? row.body : null;
  },
/**
 * 全部文案模板（内置在前，按创建时间升序）。
 * @returns {import('../../types.mjs').NotificationTemplate[]}
 */
listNotificationTemplates() {
    return this.db
      .prepare(
        'SELECT * FROM notification_templates ORDER BY builtin DESC, created_at ASC',
      )
      .all()
      .map((row) => this.notificationTemplateRowToObject(row));
  },
/**
 * @param {string} id 模板 ID。
 * @returns {import('../../types.mjs').NotificationTemplate|null}
 */
getNotificationTemplate(id) {
    const row = this.db
      .prepare('SELECT * FROM notification_templates WHERE id = ?')
      .get(id);
    return row ? this.notificationTemplateRowToObject(row) : null;
  },
/**
 * 新建自定义文案模板。
 * @param {{name: string, body: string}} template
 * @returns {import('../../types.mjs').NotificationTemplate}
 */
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
/**
 * 更新模板（仅处理传入字段；内置模板同样可改文案）。
 * @param {string} id 模板 ID。
 * @param {{name?: string, body?: string}} [changes]
 * @returns {import('../../types.mjs').NotificationTemplate|null}
 */
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
/**
 * 删除模板并让引用它的渠道回退默认文案。
 * @param {string} id 模板 ID。
 * @returns {boolean} 是否删除成功（内置模板拒绝）。
 */
  deleteNotificationTemplate(id) {
    const current = this.getNotificationTemplate(id);
    // 内置模板由 V6 迁移播种，且迁移不会重跑 —— 删除后永久丢失，无法恢复。
    if (!current || current.builtin) return false;
    // 删除模板后，引用它的渠道回退到默认文案（template_id 置空）。
    this.db
      .prepare('UPDATE notify_channels SET template_id = NULL WHERE template_id = ?')
      .run(id);
    return (
      this.db.prepare('DELETE FROM notification_templates WHERE id = ?').run(id).changes > 0
    );
  },
/**
 * 行对象 → 模板对象。
 * @param {object} row notification_templates 行。
 * @returns {import('../../types.mjs').NotificationTemplate}
 */
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
/**
 * 站点渠道 + 全局渠道（site_id IS NULL）。
 * @param {string|null} siteId 站点 ID（null 时只取全局渠道）。
 * @returns {import('../../types.mjs').NotifyChannel[]}
 */
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
/**
 * 抢占一次推送（唯一索引去重）：返回 true 表示本次应发送。
 * @param {string} alarmId 告警 ID。
 * @param {string} channelId 渠道 ID。
 * @param {string} event 事件名（created/escalated/daily-summary…）。
 * @returns {boolean}
 */
claimNotification(alarmId, channelId, event) {
    // 先尝试新插入；唯一键冲突时检查既有记录。
    // - status='sent'：已完成投递，跳过（幂等语义不变）。
    // - status='failed'：允许重试，重置为 pending 并刷新时间 —— 告警升级失败后
    //   下一轮巡检可再次投递，避免「显示已升级但实际未送达且永不重试」。
    const inserted = this.db
      .prepare(`
        INSERT OR IGNORE INTO notification_logs
        (id, alarm_id, channel_id, event, status, error, created_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?)
      `)
      .run(crypto.randomUUID(), alarmId, channelId, event, now()).changes > 0;
    if (inserted) return true;
    return this.db
      .prepare(`
        UPDATE notification_logs
        SET status = 'pending', error = NULL, created_at = ?
        WHERE alarm_id = ? AND channel_id = ? AND event = ? AND status = 'failed'
      `)
      .run(now(), alarmId, channelId, event).changes > 0;
  },
/**
 * 回写推送结果。
 * @param {string} alarmId 告警 ID。
 * @param {string} channelId 渠道 ID。
 * @param {string} event 事件名。
 * @param {{status: 'sent'|'failed', error?: string|null}} result
 * @returns {void}
 */
finishNotification(alarmId, channelId, event, { status, error = null }) {
    this.db
      .prepare(`
        UPDATE notification_logs SET status = ?, error = ?
        WHERE alarm_id = ? AND channel_id = ? AND event = ?
      `)
      .run(status, error ? String(error).slice(0, 500) : null, alarmId, channelId, event);
  },
/**
 * 某渠道自 sinceTs 以来连续失败的次数（遇到一次成功即停止计数）。
 * @param {string} channelId 渠道 ID。
 * @param {number} [sinceTs] 统计起点毫秒时间戳，默认 0。
 * @param {number} [limit] 抽样条数上限，默认 32。
 * @returns {number}
 */
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
/**
 * 推送日志（新→旧，带渠道名/类型）。
 * @param {number} [limit] 返回条数上限（1-500），默认 50。
 * @returns {Array<object>}
 */
listNotificationLogs(limit = 50, channelIds = null) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const params = [];
    let where = '';
    // 站点过滤必须在 LIMIT 之前完成，否则全局日志会先截断，站点管理员看不到自己的旧记录。
    if (Array.isArray(channelIds)) {
      if (channelIds.length === 0) return [];
      where = `WHERE l.channel_id IN (${channelIds.map(() => '?').join(',')})`;
      params.push(...channelIds);
    }
    return this.db
      .prepare(`
        SELECT l.*, c.name AS channel_name, c.kind AS channel_kind
        FROM notification_logs l
        LEFT JOIN notify_channels c ON c.id = l.channel_id
        ${where}
        ORDER BY l.created_at DESC LIMIT ?
      `)
      .all(...params, safeLimit)
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
/**
 * 清理超期推送日志。
 * @param {number} [retainDays] 保留天数，默认 30。
 * @returns {number} 删除条数。
 */
pruneNotificationLogs(retainDays = 30) {
    const cutoff = now() - retainDays * 24 * 60 * 60 * 1000;
    return Number(
      this.db.prepare('DELETE FROM notification_logs WHERE created_at < ?').run(cutoff)
        .changes,
    );
  },
};

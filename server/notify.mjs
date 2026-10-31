import crypto from 'node:crypto';

/**
 * 告警推送：企业微信群机器人 / 钉钉机器人 / 通用 Webhook。
 *
 * - 按站点选择渠道（站点渠道 + 全局渠道），同一条告警同一种事件对每个渠道只推一次；
 * - Webhook 支持 HMAC-SHA256 签名，便于接收方校验来源；
 * - 失败重试一次，结果写入 notification_logs 供管理端排查。
 */

const KIND_LABELS = {
  webhook: 'Webhook',
  wecom: '企业微信',
  dingtalk: '钉钉',
};

const LEVEL_LABELS = {
  fire: '火情告警',
  smoke: '烟雾告警',
  offline: '设备离线',
};

function levelLabelFor(level) {
  return LEVEL_LABELS[level] ?? '告警';
}

const EVENT_LABELS = {
  created: '检测到异常',
  confirmed: '告警已确认',
  false: '告警已判误报',
  recovered: '设备已恢复',
  escalated: '告警升级（超时未确认）',
};

export function formatTime(timestamp) {
  const value = Number(timestamp) || Date.now();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

/** 生成 markdown 文本；同一份内容同时用于企业微信/钉钉/Webhook 的 message 字段。 */
export function buildAlarmMessage(alarm, event = 'created', extra = {}) {
  const levelLabel = LEVEL_LABELS[alarm.level] ?? '告警';
  const lines = [];
  if (event === 'recovered') {
    lines.push(`### ${EVENT_LABELS.recovered}`);
    lines.push(`> 点位：${alarm.cameraName}（${alarm.zone}）`);
    lines.push(`> 视频流已恢复正常，离线告警自动归档。`);
    lines.push(`> 时间：${formatTime(Date.now())}`);
    return lines.join('\n');
  }
  if (event === 'escalated') {
    lines.push(`### ${EVENT_LABELS.escalated}`);
    if (extra.siteName) lines.push(`> 站点：${extra.siteName}`);
    lines.push(`> 点位：${alarm.cameraName}（${alarm.zone}）`);
    lines.push(`> 类型：${levelLabelFor(alarm.level)}`);
    lines.push(`> 产生时间：${formatTime(alarm.createdAt)}`);
    lines.push(
      `> 已超过 ${extra.minutes ?? 5} 分钟未确认处置，请立即跟进或安排人员核实。`,
    );
    return lines.join('\n');
  }

  if (event === 'confirmed' || event === 'false') {
    lines.push(`### ${EVENT_LABELS[event]}`);
    lines.push(`> 点位：${alarm.cameraName}（${alarm.zone}）`);
    lines.push(`> 原告警：${levelLabel} · 置信度 ${Math.round(alarm.confidence)}%`);
    if (extra.actorName) lines.push(`> 处置人：${extra.actorName}`);
    if (alarm.note) lines.push(`> 备注：${alarm.note}`);
    lines.push(`> 时间：${formatTime(Date.now())}`);
    return lines.join('\n');
  }

  lines.push(`### ${levelLabel}`);
  if (extra.siteName) lines.push(`> 站点：${extra.siteName}`);
  lines.push(`> 点位：${alarm.cameraName}（${alarm.zone}）`);
  if (alarm.level === 'offline') {
    lines.push(`> 现象：视频流超时未收到画面，请检查电源、网络与设备状态。`);
  } else {
    lines.push(
      `> 识别：${alarm.level === 'fire' ? '明火' : '烟雾'} · 置信度 ${Math.round(alarm.confidence)}%`,
    );
    lines.push(`> 热区：${Math.round(alarm.hotspot.x)}% / ${Math.round(alarm.hotspot.y)}%`);
  }
  lines.push(`> 时间：${formatTime(alarm.createdAt)}`);
  lines.push(`> 请立即登录平台核实处置。`);
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class Notifier {
  constructor({
    store,
    logger = console,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    maxFailures = Number(process.env.NOTIFY_MAX_FAILURES) || 5,
  } = {}) {
    this.store = store;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxFailures = Math.max(Number(maxFailures) || 0, 0);
  }

  channelLabel(channel) {
    return `${channel.name}（${KIND_LABELS[channel.kind] ?? channel.kind}）`;
  }

  async post(url, body, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${String(text).slice(0, 180)}`);
      }
      if (text) {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        if (data && typeof data === 'object' && data.errcode && data.errcode !== 0) {
          throw new Error(`errcode ${data.errcode}：${data.errmsg ?? ''}`);
        }
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async postWithRetry(url, body, headers = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.post(url, body, headers);
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(600);
      }
    }
    throw lastError;
  }

  buildBody(channel, alarm, event, extra = {}) {
    const message = buildAlarmMessage(alarm, event, extra);
    if (channel.kind === 'wecom') {
      return {
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: message } }),
        headers: {},
      };
    }
    if (channel.kind === 'dingtalk') {
      return {
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title: `${LEVEL_LABELS[alarm.level] ?? '告警'}`, text: message },
        }),
        headers: {},
      };
    }
    const payload = {
      event: `alarm.${event}`,
      message,
      alarm,
      camera: extra.camera ?? null,
      site: extra.siteName ? { name: extra.siteName } : null,
      sentAt: Date.now(),
    };
    const body = JSON.stringify(payload);
    const headers = {};
    if (channel.secret) {
      headers['X-Fire-Signature'] = `sha256=${crypto
        .createHmac('sha256', channel.secret)
        .update(body)
        .digest('hex')}`;
      headers['X-Fire-Event'] = `alarm.${event}`;
    }
    return { body, headers };
  }

  /** 推送一条告警事件；返回 { sent, failed, skipped }。 */
  async notifyAlarm(alarm, event = 'created', extra = {}) {
    if (!alarm?.id) return { sent: 0, failed: 0, skipped: 0 };
    const siteId = alarm.siteId || this.store.defaultSiteId;
    let channels = [];
    try {
      channels = this.store.channelsForSite(siteId);
    } catch (error) {
      this.logger?.warn?.(`[notify] 读取通知渠道失败：${error.message}`);
      return { sent: 0, failed: 0, skipped: 0 };
    }
    if (!channels.length) return { sent: 0, failed: 0, skipped: 0 };

    const site = (() => {
      try {
        return this.store.getSite(siteId);
      } catch {
        return null;
      }
    })();
    const context = { ...extra, siteName: site?.name ?? '' };
    const results = await Promise.all(
      channels.map((channel) => this.deliver(channel, alarm, event, context)),
    );
    return results.reduce(
      (acc, item) => ({
        sent: acc.sent + (item === 'sent' ? 1 : 0),
        failed: acc.failed + (item === 'failed' ? 1 : 0),
        skipped: acc.skipped + (item === 'skipped' ? 1 : 0),
      }),
      { sent: 0, failed: 0, skipped: 0 },
    );
  }

  async deliver(channel, alarm, event, context) {
    if (!channel?.url) return 'skipped';
    if (!this.store.claimNotification(alarm.id, channel.id, event)) return 'skipped';
    try {
      const { body, headers } = this.buildBody(channel, alarm, event, context);
      await this.postWithRetry(channel.url, body, headers);
      this.store.finishNotification(alarm.id, channel.id, event, { status: 'sent' });
      return 'sent';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.finishNotification(alarm.id, channel.id, event, {
        status: 'failed',
        error: message,
      });
      this.logger?.warn?.(`[notify] ${this.channelLabel(channel)} 推送失败：${message}`);
      await this.maybeDisableChannel(channel);
      return 'failed';
    }
  }

  /** 连续失败超过阈值时自动停用渠道，并提醒其余启用渠道。 */
  async maybeDisableChannel(channel) {
    if (!this.maxFailures || !this.store) return;
    try {
      const fresh = this.store.getNotifyChannel(channel.id) ?? channel;
      if (!fresh.enabled) return;
      const failures = this.store.consecutiveFailures(
        channel.id,
        Number(fresh.updatedAt) || 0,
      );
      if (failures < this.maxFailures) return;
      this.store.updateNotifyChannel(channel.id, { enabled: false });
      this.logger?.warn?.(
        `[notify] 渠道「${channel.name}」连续 ${failures} 次推送失败，已自动停用`,
      );
      const others = this.store
        .listNotifyChannels()
        .filter((item) => item.enabled && item.id !== channel.id);
      if (!others.length) return;
      const dayKey = new Date().toISOString().slice(0, 10);
      await this.notifyBroadcast(
        'channel.disabled',
        {
          key: `channel-disabled-${channel.id}-${dayKey}`,
          message:
            `### 通知渠道已自动停用\n` +
            `> 渠道：${channel.name}（${this.channelLabel(channel)}）\n` +
            `> 原因：连续 ${failures} 次推送失败\n` +
            `> 请检查地址与网络后重新启用。`,
          data: { channelId: channel.id, channelName: channel.name, failures },
        },
        others,
      );
    } catch (error) {
      this.logger?.warn?.(
        `[notify] 渠道自愈失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 广播非告警消息（如每日值守摘要）：key 用于按天去重。 */
  async notifyBroadcast(event, { key, message, data = {} }, channels) {
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const channel of channels) {
      if (!channel?.url) {
        skipped += 1;
        continue;
      }
      if (!this.store.claimNotification(key, channel.id, event)) {
        skipped += 1;
        continue;
      }
      try {
        let body;
        const headers = {};
        if (channel.kind === 'wecom') {
          body = JSON.stringify({ msgtype: 'markdown', markdown: { content: message } });
        } else if (channel.kind === 'dingtalk') {
          body = JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: '值守摘要', text: message },
          });
        } else {
          const payload = { event, message, ...data, sentAt: Date.now() };
          body = JSON.stringify(payload);
          if (channel.secret) {
            headers['X-Fire-Signature'] = `sha256=${crypto
              .createHmac('sha256', channel.secret)
              .update(body)
              .digest('hex')}`;
          }
        }
        await this.postWithRetry(channel.url, body, headers);
        this.store.finishNotification(key, channel.id, event, { status: 'sent' });
        sent += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.store.finishNotification(key, channel.id, event, {
          status: 'failed',
          error: errorMessage,
        });
        this.logger?.warn?.(`[notify] ${this.channelLabel(channel)} 推送失败：${errorMessage}`);
        await this.maybeDisableChannel(channel);
        failed += 1;
      }
    }
    return { sent, failed, skipped };
  }

  /** 管理端“测试发送”，不写告警去重记录。 */
  async testChannel(channel) {
    if (!channel?.url) throw new Error('渠道地址为空');
    const message = [
      '### 火情监控测试消息',
      `> 渠道：${this.channelLabel(channel)}`,
      `> 时间：${formatTime(Date.now())}`,
      '> 收到本条消息说明推送配置正常。',
    ].join('\n');
    let body;
    let headers = {};
    if (channel.kind === 'wecom') {
      body = JSON.stringify({ msgtype: 'markdown', markdown: { content: message } });
    } else if (channel.kind === 'dingtalk') {
      body = JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '火情监控测试', text: message },
      });
    } else {
      const payload = { event: 'test', message, sentAt: Date.now() };
      body = JSON.stringify(payload);
      if (channel.secret) {
        headers['X-Fire-Signature'] = `sha256=${crypto
          .createHmac('sha256', channel.secret)
          .update(body)
          .digest('hex')}`;
      }
    }
    await this.postWithRetry(channel.url, body, headers);
    return true;
  }
}

export { KIND_LABELS };

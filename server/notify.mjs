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
  camera_abnormal: '画面异常',
};

/** Webhook 请求体签名：三类推送共用同一算法，头字段差异仍由各调用点自行决定。 */
function signWebhookBody(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function levelLabelFor(level) {
  return LEVEL_LABELS[level] ?? '告警';
}

/**
 * 按渠道类型构造 JSON 请求体与请求头：企微/钉钉为 markdown 消息，
 * Webhook 为结构化载荷（带可选 HMAC-SHA256 签名头与事件头）。
 * 告警推送 / 广播 / 测试三个入口共用此分支，差异经参数传入以逐字保留：
 * 钉钉标题、Webhook 附加字段顺序、以及仅告警下发的 X-Fire-Event 头。
 *
 * @param {import('./types.mjs').NotifyChannel} channel 渠道。
 * @param {string} message markdown 正文。
 * @param {object} options 差异参数。
 * @param {string} options.event Webhook 载荷的 event 字段（同时用作 X-Fire-Event 值）。
 * @param {string} options.dingtalkTitle 钉钉 markdown 标题（告警级别 / 值守摘要 / 火情监控测试）。
 * @param {object} [options.webhookExtra] Webhook 载荷在 message 与 sentAt 之间的附加字段。
 * @param {boolean} [options.includeFireEvent] 是否额外下发 X-Fire-Event 头（仅告警推送）。
 * @returns {{body: string, headers: Record<string, string>}}
 */
function buildChannelBody(channel, message, {
  event,
  dingtalkTitle,
  webhookExtra = {},
  includeFireEvent = false,
}) {
  const headers = {};
  let body;
  if (channel.kind === 'wecom') {
    body = JSON.stringify({ msgtype: 'markdown', markdown: { content: message } });
  } else if (channel.kind === 'dingtalk') {
    body = JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: dingtalkTitle, text: message },
    });
  } else {
    const payload = { event, message, ...webhookExtra, sentAt: Date.now() };
    body = JSON.stringify(payload);
    if (channel.secret) {
      headers['X-Fire-Signature'] = signWebhookBody(channel.secret, body);
      if (includeFireEvent) headers['X-Fire-Event'] = event;
    }
  }
  return { body, headers };
}

const EVENT_LABELS = {
  created: '检测到异常',
  confirmed: '告警已确认',
  false: '告警已判误报',
  recovered: '设备已恢复',
  escalated: '告警升级（超时未确认）',
};

/**
 * 上海时区（Asia/Shanghai）的「YYYY/MM/DD HH:mm:ss」时间文案；非法时间戳
 * 回退当前时间，Intl 不可用时回退 ISO 字符串。
 *
 * @param {number|string} timestamp 毫秒时间戳。
 * @returns {string}
 */
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

/**
 * 按模板渲染告警文案。变量：{site} {camera} {zone} {level} {confidence}
 * {time} {hotspot} {link}。未识别的占位符原样保留，便于排查。
 * 模板仅在「告警产生（created）」事件生效；确认/误报/恢复/升级等事件
 * 沿用内置文案，避免不同语义下变量缺失造成歧义。
 *
 * @param {string} template 模板正文（支持 {占位符}）。
 * @param {import('./types.mjs').Alarm} alarm 告警对象。
 * @param {{siteName?: string, link?: string}} [extra] 渲染上下文。
 * @returns {string} 渲染后的 markdown 文本。
 */
export function renderTemplate(template, alarm, extra = {}) {
  const levelLabel = levelLabelFor(alarm.level);
  const link = extra.link || '监控平台告警页';
  const vars = {
    site: extra.siteName || '',
    camera: alarm.cameraName,
    zone: alarm.zone,
    level: levelLabel,
    confidence: String(Math.round(alarm.confidence ?? 0)),
    time: formatTime(alarm.createdAt),
    hotspot: `${Math.round(alarm.hotspot?.x ?? 0)}% / ${Math.round(alarm.hotspot?.y ?? 0)}%`,
    link,
  };
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * 生成告警事件的 markdown 推送文案：created 优先用绑定模板，其余事件
 * （recovered/escalated/confirmed/false）用内置结构化文案。
 *
 * @param {import('./types.mjs').Alarm} alarm 告警对象。
 * @param {'created'|'recovered'|'escalated'|'confirmed'|'false'} [event] 事件类型，默认 'created'。
 * @param {{template?: string, siteName?: string, actorName?: string, minutes?: number, link?: string}} [extra] 上下文。
 * @returns {string} markdown 文案。
 */
export function buildAlarmMessage(alarm, event = 'created', extra = {}) {
  if (extra.template && event === 'created') {
    return renderTemplate(extra.template, alarm, extra);
  }
  const levelLabel = levelLabelFor(alarm.level);
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

/**
 * 告警通知器：按站点聚合渠道，推送企微/钉钉/Webhook 消息，
 * 并维护推送去重、重试与连续失败自动停用。
 *
 * @typedef {object} NotifierOptions
 * @property {import('./store.mjs').Store} store 数据存储（读渠道/模板，写推送日志）。
 * @property {Console} [logger] 日志对象。
 * @property {typeof fetch} [fetchImpl] HTTP 实现（测试注入用）。
 * @property {number} [timeoutMs] 单次推送超时毫秒数（默认 8000）。
 * @property {number} [maxFailures] 连续失败自动停用阈值（0 表示不停用，默认取 NOTIFY_MAX_FAILURES）。
 */
export class Notifier {
  /**
   * @param {NotifierOptions} [options]
   */
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

  /**
   * 渠道展示名：「名称（类型标签）」。
   *
   * @param {import('./types.mjs').NotifyChannel} channel
   * @returns {string}
   */
  channelLabel(channel) {
    return `${channel.name}（${KIND_LABELS[channel.kind] ?? channel.kind}）`;
  }

  /** 处置链接：由 PUBLIC_BASE_URL 拼出告警页，未配置则回退为提示文案。 */
  resolveLink() {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    return base ? `${base}/alarms` : '监控平台告警页';
  }

  /**
   * 单次 JSON POST：非 2xx 或业务 errcode 非零都视为失败抛错。
   *
   * @param {string} url 推送地址。
   * @param {string} body JSON 字符串请求体。
   * @param {Record<string, string>} [headers] 附加请求头（如签名）。
   * @returns {Promise<string>} 上游响应文本。
   */
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

  /**
   * 带一次重试的推送（首次失败后等 600ms 重试一次，仍失败抛最后错误）。
   *
   * @param {string} url 推送地址。
   * @param {string} body JSON 字符串请求体。
   * @param {Record<string, string>} [headers] 附加请求头。
   * @returns {Promise<string>} 上游响应文本。
   */
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

  /**
   * 按渠道类型构造请求体与请求头：企微/钉钉为 markdown 消息，
   * Webhook 为结构化载荷（带 HMAC-SHA256 签名头）。
   *
   * @param {import('./types.mjs').NotifyChannel} channel 渠道。
   * @param {import('./types.mjs').Alarm} alarm 告警。
   * @param {string} event 事件名。
   * @param {{camera?: object|null, siteName?: string}} [extra] 上下文。
   * @returns {{body: string, headers: Record<string, string>}}
   */
  buildBody(channel, alarm, event, extra = {}) {
    const enriched = { ...extra, link: this.resolveLink() };
    const message = buildAlarmMessage(alarm, event, enriched);
    return buildChannelBody(channel, message, {
      event: `alarm.${event}`,
      dingtalkTitle: levelLabelFor(alarm.level),
      webhookExtra: {
        alarm,
        camera: extra.camera ?? null,
        site: extra.siteName ? { name: extra.siteName } : null,
      },
      includeFireEvent: true,
    });
  }

  /**
   * 推送一条告警事件到站点渠道集合（含全局渠道），返回计数汇总。
   *
   * @param {import('./types.mjs').Alarm} alarm 告警对象。
   * @param {string} [event] 事件名，默认 'created'。
   * @param {{camera?: object|null, siteName?: string, template?: string}} [extra] 上下文。
   * @returns {Promise<{sent: number, failed: number, skipped: number}>}
   */
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

  /**
   * 向单个渠道推送（去重抢占 → 构造请求 → 重试 → 回写结果）。
   *
   * @param {import('./types.mjs').NotifyChannel} channel 渠道。
   * @param {import('./types.mjs').Alarm} alarm 告警。
   * @param {string} event 事件名。
   * @param {{siteName?: string, camera?: object|null}} context 上下文。
   * @returns {Promise<'sent'|'failed'|'skipped'>} 单渠道投递结果。
   */
  async deliver(channel, alarm, event, context) {
    if (!channel?.url) return 'skipped';
    if (!this.store.claimNotification(alarm.id, channel.id, event)) return 'skipped';
    try {
      // 渠道自带模板优先于全局默认正文。
      const enrichedContext = {
        ...context,
        template: channel.templateBody ?? context.template,
      };
      const { body, headers } = this.buildBody(channel, alarm, event, enrichedContext);
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

  /**
   * 连续失败超过阈值时自动停用渠道，并提醒其余启用渠道。
   *
   * @param {import('./types.mjs').NotifyChannel} channel 渠道。
   * @returns {Promise<void>}
   */
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

  /**
   * 广播非告警消息（如每日值守摘要）：key 用于按天去重。
   *
   * @param {string} event 事件名（如 daily-summary）。
   * @param {{key: string, message: string, data?: object}} payload 消息载荷（同 key 只投递一次）。
   * @param {import('./types.mjs').NotifyChannel[]} channels 目标渠道列表。
   * @returns {Promise<{sent: number, failed: number, skipped: number}>}
   */
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
        const { body, headers } = buildChannelBody(channel, message, {
          event,
          dingtalkTitle: '值守摘要',
          webhookExtra: data,
        });
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

  /**
   * 管理端「测试发送」：不写告警去重记录，直接推送一条测试消息。
   *
   * @param {import('./types.mjs').NotifyChannel} channel 渠道。
   * @returns {Promise<boolean>} 推送成功返回 true，失败抛错。
   */
  async testChannel(channel) {
    if (!channel?.url) throw new Error('渠道地址为空');
    const message = [
      '### 火情监控测试消息',
      `> 渠道：${this.channelLabel(channel)}`,
      `> 时间：${formatTime(Date.now())}`,
      '> 收到本条消息说明推送配置正常。',
    ].join('\n');
    const { body, headers } = buildChannelBody(channel, message, {
      event: 'test',
      dingtalkTitle: '火情监控测试',
    });
    await this.postWithRetry(channel.url, body, headers);
    return true;
  }
}

export { KIND_LABELS };

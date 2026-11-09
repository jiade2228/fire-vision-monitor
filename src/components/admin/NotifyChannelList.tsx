import type { NotifyChannel, NotifyKind, NotifyTemplate } from '../../lib/api';

interface Props {
  notifyChannels: NotifyChannel[];
  notifyTemplates: NotifyTemplate[];
  testingChannel: string | null;
  kindLabels: Record<NotifyKind, string>;
  testNotifyChannel: (channel: NotifyChannel) => Promise<void>;
  toggleNotifyChannel: (channel: NotifyChannel) => Promise<void>;
  removeNotifyChannel: (channel: NotifyChannel) => Promise<void>;
}

export default function NotifyChannelList({
  notifyChannels,
  notifyTemplates,
  testingChannel,
  kindLabels,
  testNotifyChannel,
  toggleNotifyChannel,
  removeNotifyChannel,
}: Props) {
  const NOTIFY_KIND_LABELS = kindLabels;
  return (
    <>
      {notifyChannels.length === 0 ? (
        <p className="admin-empty">
          还没有通知渠道。创建后，告警会按站点自动推送，不再依赖有人盯屏。
        </p>
      ) : (
        <div className="site-list">
          {notifyChannels.map((channel) => (
            <div className="site-row" key={channel.id}>
              <div className="site-main">
                <strong>{channel.name}</strong>
                <span>
                  {NOTIFY_KIND_LABELS[channel.kind]} ·{' '}
                  {channel.siteName ?? '全部站点'} · {channel.urlHint}
                  {channel.hasSecret ? ' · 已配置签名' : ''}
                  {channel.templateId
                    ? ` · 模板：${notifyTemplates.find((t) => t.id === channel.templateId)?.name ?? '已删除'}`
                    : ''}
                </span>
              </div>
              <div className="point-actions">
                <span className={`point-state ${channel.enabled ? 'is-on' : ''}`}>
                  {channel.enabled ? '启用' : '停用'}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={testingChannel === channel.id}
                  onClick={() => void testNotifyChannel(channel)}
                >
                  {testingChannel === channel.id ? '发送中…' : '测试'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void toggleNotifyChannel(channel)}
                >
                  {channel.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void removeNotifyChannel(channel)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

import type { Dispatch, SetStateAction, FormEvent } from 'react';
import type {
  NotifyChannel,
  NotifyKind,
  NotifyTemplate,
  NotificationLog,
  Site,
} from '../../lib/api';
import { NOTIFY_EVENT_LABELS, NOTIFY_KIND_LABELS } from '../AdminPanel';
import { formatDateTime } from '../../lib/format';
import NotifyTemplateList from './NotifyTemplateList';
import NotifyChannelList from './NotifyChannelList';
import NotifyLogList from './NotifyLogList';

type NotifyForm = {
  name: string;
  kind: NotifyKind;
  url: string;
  secret: string;
  siteId: string;
  enabled: boolean;
  templateId: string;
};

type TemplateDraft = { name: string; body: string };

interface NotifyTabProps {
  isSuperAdmin: boolean;
  sites: Site[];
  notifyTemplates: NotifyTemplate[];
  showTemplateEditor: boolean;
  templateDraft: TemplateDraft;
  templateBusy: boolean;
  notifyForm: NotifyForm;
  notifyBusy: boolean;
  notifyChannels: NotifyChannel[];
  testingChannel: string | null;
  notifyLogs: NotificationLog[];
  setTemplateDraft: Dispatch<SetStateAction<TemplateDraft>>;
  setNotifyForm: Dispatch<SetStateAction<NotifyForm>>;
  loadNotifyLogs: () => Promise<void>;
  openTemplateEditor: (tpl?: NotifyTemplate) => void;
  insertTemplateVar: (v: string) => void;
  saveTemplate: () => Promise<void>;
  closeTemplateEditor: () => void;
  removeTemplate: (tpl: NotifyTemplate) => Promise<void>;
  submitNotify: (event: FormEvent) => Promise<void>;
  testNotifyChannel: (channel: NotifyChannel) => Promise<void>;
  toggleNotifyChannel: (channel: NotifyChannel) => Promise<void>;
  removeNotifyChannel: (channel: NotifyChannel) => Promise<void>;
}

export default function NotifyTab(props: NotifyTabProps) {
  const {
    isSuperAdmin,
    sites,
    notifyTemplates,
    showTemplateEditor,
    templateDraft,
    templateBusy,
    notifyForm,
    notifyBusy,
    notifyChannels,
    testingChannel,
    notifyLogs,
    setTemplateDraft,
    setNotifyForm,
    loadNotifyLogs,
    openTemplateEditor,
    insertTemplateVar,
    saveTemplate,
    closeTemplateEditor,
    removeTemplate,
    submitNotify,
    testNotifyChannel,
    toggleNotifyChannel,
    removeNotifyChannel,
  } = props;
  return (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>告警通知</h3>
                  <p>
                    告警产生、确认、判定误报或设备离线时，按站点推送到企业微信、钉钉或自建
                    Webhook。
                  </p>
                </div>
                <div className="admin-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void loadNotifyLogs()}
                  >
                    刷新推送记录
                  </button>
                </div>
              </div>

              <div className="template-card">
                <div className="admin-subhead">
                  <h4>告警通知文案模板</h4>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openTemplateEditor()}
                    >
                      新建模板
                    </button>
                  )}
                </div>
                <p className="admin-form-hint">
                  可用变量：{'{site}'} 站点 · {'{camera}'} 点位 · {'{zone}'} 区域 · {'{level}'} 类型 ·
                  {'{confidence}'} 置信度 · {'{time}'} 时间 · {'{hotspot}'} 热区 · {'{link}'} 处置入口。
                  仅作用于「告警产生」通知，其余事件沿用内置文案。
                </p>
                {!isSuperAdmin && (
                  <p className="admin-form-hint">
                    提示：文案模板为全平台共享资源，仅全局管理员可新建、修改或删除；
                    站点管理员可查看并在渠道中引用。
                  </p>
                )}
                {showTemplateEditor && (
                  <div className="template-editor">
                    <input
                      className="settings-input"
                      placeholder="模板名称"
                      value={templateDraft.name}
                      maxLength={32}
                      onChange={(event) =>
                        setTemplateDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                    <textarea
                      className="settings-input template-body"
                      rows={3}
                      placeholder="例如：{time} {site}/{camera} 触发{level}（{confidence}%），请核实：{link}"
                      value={templateDraft.body}
                      onChange={(event) =>
                        setTemplateDraft((prev) => ({ ...prev, body: event.target.value }))
                      }
                    />
                    <div className="template-var-row">
                      {[
                        'site',
                        'camera',
                        'zone',
                        'level',
                        'confidence',
                        'time',
                        'hotspot',
                        'link',
                      ].map((variable) => (
                        <button
                          type="button"
                          key={variable}
                          className="chip"
                          onClick={() => insertTemplateVar(variable)}
                        >
                          {`{${variable}}`}
                        </button>
                      ))}
                    </div>
                    <div className="admin-form-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={templateBusy}
                        onClick={() => void saveTemplate()}
                      >
                        {templateBusy ? '保存中…' : '保存模板'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={closeTemplateEditor}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                <NotifyTemplateList
                  notifyTemplates={notifyTemplates}
                  showTemplateEditor={showTemplateEditor}
                  isSuperAdmin={isSuperAdmin}
                  openTemplateEditor={openTemplateEditor}
                  removeTemplate={removeTemplate}
                />
              </div>

              <form className="admin-form admin-notify-form" onSubmit={submitNotify}>
                <div className="admin-form-title">
                  <h4>新增通知渠道</h4>
                </div>
                <div className="admin-nvr-grid">
                  <label>
                    <span>渠道名称</span>
                    <input
                      className="settings-input"
                      value={notifyForm.name}
                      placeholder="例如：消防值班群"
                      maxLength={32}
                      required
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>类型</span>
                    <select
                      className="settings-input"
                      value={notifyForm.kind}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({
                          ...prev,
                          kind: event.target.value as NotifyKind,
                        }))
                      }
                    >
                      <option value="wecom">企业微信机器人</option>
                      <option value="dingtalk">钉钉机器人</option>
                      <option value="webhook">通用 Webhook</option>
                    </select>
                  </label>
                  <label>
                    <span>生效站点</span>
                    <select
                      className="settings-input"
                      value={notifyForm.siteId}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, siteId: event.target.value }))
                      }
                    >
                      {isSuperAdmin && <option value="">全部站点（全局）</option>}
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>消息模板</span>
                    <select
                      className="settings-input"
                      value={notifyForm.templateId}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, templateId: event.target.value }))
                      }
                    >
                      <option value="">默认文案</option>
                      {notifyTemplates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="admin-nvr-template">
                    <span>推送地址</span>
                    <input
                      className="settings-input"
                      value={notifyForm.url}
                      placeholder="企业微信/钉钉机器人 Webhook 地址，或自建接收地址"
                      maxLength={2048}
                      required
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, url: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>签名密钥（Webhook 可选）</span>
                    <input
                      type="password"
                      className="settings-input"
                      value={notifyForm.secret}
                      autoComplete="new-password"
                      placeholder="配置后请求头带 X-Fire-Signature"
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, secret: event.target.value }))
                      }
                    />
                  </label>
                  <label className="admin-notify-enable">
                    <span>启用</span>
                    <input
                      type="checkbox"
                      checked={notifyForm.enabled}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({
                          ...prev,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="admin-form-actions">
                  <button type="submit" className="btn btn-sm btn-danger" disabled={notifyBusy}>
                    {notifyBusy ? '保存中…' : '新增渠道'}
                  </button>
                </div>
              </form>

              <NotifyChannelList
                notifyChannels={notifyChannels}
                notifyTemplates={notifyTemplates}
                testingChannel={testingChannel}
                kindLabels={NOTIFY_KIND_LABELS}
                testNotifyChannel={testNotifyChannel}
                toggleNotifyChannel={toggleNotifyChannel}
                removeNotifyChannel={removeNotifyChannel}
              />

              <NotifyLogList
                notifyLogs={notifyLogs}
                eventLabels={NOTIFY_EVENT_LABELS}
                formatDateTime={formatDateTime}
              />
            </div>
  );
}

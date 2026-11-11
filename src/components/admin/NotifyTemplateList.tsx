import type { NotifyTemplate } from '../../lib/api';

interface Props {
  notifyTemplates: NotifyTemplate[];
  showTemplateEditor: boolean;
  /** 是否为全局管理员（模板为全平台共享资源，仅全局管理员可写）。 */
  isSuperAdmin: boolean;
  openTemplateEditor: (tpl?: NotifyTemplate) => void;
  removeTemplate: (tpl: NotifyTemplate) => Promise<void>;
}

export default function NotifyTemplateList({
  notifyTemplates,
  showTemplateEditor,
  isSuperAdmin,
  openTemplateEditor,
  removeTemplate,
}: Props) {
  return (
    <div className="template-list">
      {!showTemplateEditor && notifyTemplates.length === 0 && (
        <p className="admin-empty">暂无模板，使用默认文案。可新建可复用模板。</p>
      )}
      {notifyTemplates.map((tpl) => (
        <div className="template-item" key={tpl.id}>
          <div className="template-meta">
            <strong>{tpl.name}</strong>
            {tpl.builtin && <span className="chip chip--mini">内置</span>}
          </div>
          <code className="template-preview">{tpl.body}</code>
          {/* 写操作仅全局管理员可见：服务端对模板的新增/修改/删除
              已收紧为 requireRole('admin')，避免站点管理员影响其它站点。 */}
          {isSuperAdmin && (
            <div className="template-item-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => openTemplateEditor(tpl)}
              >
                编辑
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void removeTemplate(tpl)}
              >
                删除
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

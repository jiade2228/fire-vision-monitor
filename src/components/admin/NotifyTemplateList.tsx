import type { NotifyTemplate } from '../../lib/api';

interface Props {
  notifyTemplates: NotifyTemplate[];
  showTemplateEditor: boolean;
  openTemplateEditor: (tpl?: NotifyTemplate) => void;
  removeTemplate: (tpl: NotifyTemplate) => Promise<void>;
}

export default function NotifyTemplateList({
  notifyTemplates,
  showTemplateEditor,
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
        </div>
      ))}
    </div>
  );
}

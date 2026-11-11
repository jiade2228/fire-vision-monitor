import type { Dispatch, SetStateAction, FormEvent } from 'react';
import type { ManagedCamera, SessionUser, Site } from '../../lib/api';

type SiteForm = { name: string; code: string };

interface SitesTabProps {
  isSuperAdmin: boolean;
  sites: Site[];
  cameras: ManagedCamera[];
  siteForm: SiteForm;
  siteBusy: boolean;
  editingSiteId: string | null;
  editingSiteName: string;
  defaultSiteId: string;
  assigningUser: SessionUser | null;
  assignBusy: boolean;
  assignSiteIds: string[];
  setSiteForm: Dispatch<SetStateAction<SiteForm>>;
  setEditingSiteName: Dispatch<SetStateAction<string>>;
  setAssigningUser: Dispatch<SetStateAction<SessionUser | null>>;
  siteKey: (id: string | null | undefined) => string;
  submitSite: (event: FormEvent) => Promise<void>;
  saveEditSite: (site: Site) => Promise<void>;
  cancelEditSite: () => void;
  startEditSite: (site: Site) => void;
  removeSite: (site: Site) => Promise<void>;
  toggleAssignSite: (siteId: string) => void;
  saveAssignUser: () => Promise<void>;
}

export default function SitesTab(props: SitesTabProps) {
  const {
    isSuperAdmin,
    sites,
    cameras,
    siteForm,
    siteBusy,
    editingSiteId,
    editingSiteName,
    defaultSiteId,
    assigningUser,
    assignBusy,
    assignSiteIds,
    setSiteForm,
    setEditingSiteName,
    setAssigningUser,
    siteKey,
    submitSite,
    saveEditSite,
    cancelEditSite,
    startEditSite,
    removeSite,
    toggleAssignSite,
    saveAssignUser,
  } = props;
  return (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>站点与分组</h3>
                  <p>将摄像头按园区、楼宇或客户分组，并为值班员 / 只读账号分配可见站点。</p>
                </div>
              </div>

              {isSuperAdmin && (
                <form className="admin-site-form" onSubmit={submitSite}>
                  <input
                    className="settings-input"
                    value={siteForm.name}
                    placeholder="新站点名称（如：园区 A 区）"
                    maxLength={48}
                    required
                    aria-label="新站点名称"
                    onChange={(event) =>
                      setSiteForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                  />
                  <input
                    className="settings-input"
                    value={siteForm.code}
                    placeholder="编码（可选，如 A1）"
                    maxLength={24}
                    aria-label="新站点编码"
                    onChange={(event) =>
                      setSiteForm((prev) => ({ ...prev, code: event.target.value }))
                    }
                  />
                  <button type="submit" className="btn btn-sm btn-danger" disabled={siteBusy}>
                    {siteBusy ? '创建中…' : '新增站点'}
                  </button>
                </form>
              )}

              {sites.length === 0 ? (
                <p className="admin-empty">
                  还没有自定义站点，系统已有一个默认站点用于归类未分配的点位。
                </p>
              ) : (
                <div className="site-list">
                  {sites.map((site) => {
                    const count = cameras.filter(
                      (camera) => siteKey(camera.siteId) === site.id,
                    ).length;
                    const isDefault = site.id === defaultSiteId;
                    return (
                      <div className="site-row" key={site.id}>
                        <div className="site-main">
                          {editingSiteId === site.id ? (
                            <input
                              className="settings-input"
                              value={editingSiteName}
                              maxLength={48}
                              aria-label="编辑站点名称"
                              onChange={(event) => setEditingSiteName(event.target.value)}
                            />
                          ) : (
                            <strong>{site.name}</strong>
                          )}
                          <span>
                            {site.code}
                            {isDefault && ' · 默认站点'}
                            {` · ${count} 个点位`}
                          </span>
                        </div>
                        <div className="point-actions">
                          {editingSiteId === site.id ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={siteBusy}
                                onClick={() => void saveEditSite(site)}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={cancelEditSite}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => startEditSite(site)}
                              >
                                改名
                              </button>
                              {isSuperAdmin && !isDefault && (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => void removeSite(site)}
                                >
                                  删除
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {assigningUser && (
                <div className="user-site-assign">
                  <div className="admin-form-title">
                    <h4>{`为「${assigningUser.displayName}」分配可见站点`}</h4>
                    <button
                      type="button"
                      className="admin-form-close"
                      onClick={() => setAssigningUser(null)}
                    >
                      关闭
                    </button>
                  </div>
                  <p className="admin-form-hint">
                    未勾选任何站点时，该账号将看不到任何点位；管理员默认可见全部站点。
                  </p>
                  {assignBusy ? (
                    <p className="admin-empty">正在加载授权…</p>
                  ) : (
                    <div className="assign-sites">
                      {sites.map((site) => (
                        <label key={site.id} className="assign-site">
                          <input
                            type="checkbox"
                            checked={assignSiteIds.includes(site.id)}
                            onChange={() => toggleAssignSite(site.id)}
                          />
                          <span>{site.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="admin-form-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={assignBusy}
                      onClick={() => void saveAssignUser()}
                    >
                      保存授权
                    </button>
                  </div>
                </div>
              )}
            </div>
  );
}

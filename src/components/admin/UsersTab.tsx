import type { Dispatch, SetStateAction, FormEvent } from 'react';
import type { SessionUser, UserRole } from '../../lib/api';
import UserList from './UserList';

type UserForm = {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
  siteAdmin: boolean;
};

interface UsersTabProps {
  currentUser: SessionUser;
  userForm: UserForm;
  userBusy: boolean;
  users: SessionUser[];
  usersLoading: boolean;
  setUserForm: Dispatch<SetStateAction<UserForm>>;
  submitUser: (event: FormEvent) => Promise<void>;
  updateUser: (user: SessionUser, patch: Partial<Pick<SessionUser, 'displayName' | 'role' | 'disabled' | 'siteAdmin'>>) => Promise<void>;
  openAssignUser: (user: SessionUser) => Promise<void>;
  resetPassword: (user: SessionUser) => void;
  deleteUser: (user: SessionUser) => Promise<void>;
}

export default function UsersTab(props: UsersTabProps) {
  const {
    currentUser,
    userForm,
    userBusy,
    users,
    usersLoading,
    setUserForm,
    submitUser,
    updateUser,
    openAssignUser,
    resetPassword,
    deleteUser,
  } = props;
  return (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>访问账号</h3>
                  <p>管理员可配置点位；值班员可处置告警；只读账号仅查看。</p>
                </div>
              </div>

              <form className="admin-user-form" onSubmit={submitUser}>
                <input
                  className="settings-input"
                  value={userForm.username}
                  placeholder="用户名"
                  required
                  aria-label="新账号用户名"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                />
                <input
                  className="settings-input"
                  value={userForm.displayName}
                  placeholder="显示名称"
                  aria-label="新账号显示名称"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, displayName: event.target.value }))
                  }
                />
                <select
                  className="settings-input"
                  value={userForm.role}
                  aria-label="新账号角色"
                  onChange={(event) =>
                    setUserForm((prev) => ({
                      ...prev,
                      role: event.target.value as UserRole,
                      siteAdmin:
                        event.target.value === 'admin' ? false : prev.siteAdmin,
                    }))
                  }
                >
                  <option value="operator">值班员</option>
                  <option value="viewer">只读</option>
                  <option value="admin">管理员</option>
                </select>
                <input
                  type="password"
                  className="settings-input"
                  value={userForm.password}
                  placeholder="初始密码（至少 8 位）"
                  minLength={8}
                  required
                  aria-label="新账号初始密码"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                />
                <label className="admin-check admin-user-siteadmin">
                  <input
                    type="checkbox"
                    checked={userForm.siteAdmin}
                    disabled={userForm.role === 'admin'}
                    onChange={(event) =>
                      setUserForm((prev) => ({
                        ...prev,
                        siteAdmin: event.target.checked,
                      }))
                    }
                  />
                  站点管理员（仅管理被授权站点）
                </label>
                <button type="submit" className="btn btn-sm btn-danger" disabled={userBusy}>
                  {userBusy ? '创建中…' : '新增账号'}
                </button>
              </form>

              <UserList
                users={users}
                usersLoading={usersLoading}
                currentUser={currentUser}
                updateUser={updateUser}
                openAssignUser={openAssignUser}
                resetPassword={resetPassword}
                deleteUser={deleteUser}
              />
            </div>
  );
}

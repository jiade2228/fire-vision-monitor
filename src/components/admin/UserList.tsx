import type { SessionUser, UserRole } from '../../lib/api';

type UserPatch = Partial<
  Pick<SessionUser, 'displayName' | 'role' | 'disabled' | 'siteAdmin'>
>;

interface Props {
  users: SessionUser[];
  usersLoading: boolean;
  currentUser: SessionUser;
  updateUser: (user: SessionUser, patch: UserPatch) => Promise<void>;
  openAssignUser: (user: SessionUser) => Promise<void>;
  resetPassword: (user: SessionUser) => Promise<void>;
  deleteUser: (user: SessionUser) => Promise<void>;
}

export default function UserList({
  users,
  usersLoading,
  currentUser,
  updateUser,
  openAssignUser,
  resetPassword,
  deleteUser,
}: Props) {
  return (
    <div className="user-list">
      {usersLoading && users.length === 0 ? (
        <p className="admin-empty">正在加载账号…</p>
      ) : (
        users.map((user) => (
          <div className="user-row" key={user.id}>
            <div className="user-main">
              <strong>{user.displayName}</strong>
              <span>
                @{user.username}
                {user.siteAdmin ? ' · 站点管理员' : ''}
                {user.id === currentUser.id ? ' · 当前账号' : ''}
              </span>
            </div>
            <select
              className="settings-input user-role-select"
              value={user.role}
              disabled={user.id === currentUser.id}
              aria-label={`${user.displayName} 角色`}
              onChange={(event) =>
                void updateUser(user, { role: event.target.value as UserRole })
              }
            >
              <option value="admin">管理员</option>
              <option value="operator">值班员</option>
              <option value="viewer">只读</option>
            </select>
            <span className={`point-state ${user.disabled ? '' : 'is-on'}`}>
              {user.disabled ? '已停用' : '正常'}
            </span>
            <div className="point-actions">
              {user.role !== 'admin' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() =>
                    void updateUser(user, { siteAdmin: !user.siteAdmin })
                  }
                >
                  {user.siteAdmin ? '取消站点管理员' : '设为站点管理员'}
                </button>
              )}
              {user.role !== 'admin' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void openAssignUser(user)}
                >
                  管理可见站点
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void resetPassword(user)}>
                重置密码
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={user.id === currentUser.id}
                onClick={() => void updateUser(user, { disabled: !user.disabled })}
              >
                {user.disabled ? '启用' : '停用'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={user.id === currentUser.id}
                onClick={() => void deleteUser(user)}
              >
                删除
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

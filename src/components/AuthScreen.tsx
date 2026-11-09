import { useState } from 'react';
import type { FormEvent } from 'react';

type Mode = 'login' | 'setup' | 'error';

interface Props {
  mode: Mode;
  error: string;
  submitting: boolean;
  onRetry: () => void;
  onLogin: (username: string, password: string) => void;
  onSetup: (username: string, displayName: string, password: string) => void;
}

export default function AuthScreen({
  mode,
  error,
  submitting,
  onRetry,
  onLogin,
  onSetup,
}: Props) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError('');
    if (mode === 'setup') {
      if (password.length < 8) {
        setLocalError('管理员密码至少需要 8 位');
        return;
      }
      if (password !== confirmPassword) {
        setLocalError('两次输入的密码不一致');
        return;
      }
      onSetup(username.trim(), displayName.trim(), password);
      return;
    }
    if (!username.trim() || !password) {
      setLocalError('请输入用户名和密码');
      return;
    }
    onLogin(username.trim(), password);
  };

  return (
    <div className="auth-page">
      <div className="auth-atmosphere" aria-hidden="true" />
      <main className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
              <path
                d="M12 2.6c2.6 3 1.2 5.1 3 6.7 1 .9 2.4 1.2 2.8 3.1.5 2.4-1 4.1-1 4.1.5-2.6-1.1-3.9-2.1-4.6.3 2.3-.8 3.2-1.6 4.1-.8.9-1.4 1.9-1 3.4-1.9-.9-3-2.6-3-4.7 0-2.2 1.6-3.4 1.5-5.4-.1-1.2-.7-2.2-.7-2.2s-.7 1.1-.9 2.6c-.9-1.3-1-2.9-.4-4.3C9.5 4.4 11 3.3 12 2.6Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <div>
            <h1>火情视频识别监控平台</h1>
            <p>FLAME VISION · 远程值守中心</p>
          </div>
        </div>

        {mode === 'error' ? (
          <div className="auth-error-state">
            <h2>无法连接监控服务</h2>
            <p>{error}</p>
            <p className="auth-hint">
              请确认服务端已启动，并通过同一地址访问网页和接口。首次部署先运行
              <code>npm run build</code>，再运行 <code>npm start</code>。
            </p>
            <button type="button" className="btn btn-danger auth-submit" onClick={onRetry}>
              重新连接
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-form-head">
              <h2>{mode === 'setup' ? '创建初始管理员' : '登录值守中心'}</h2>
              <p>
                {mode === 'setup'
                  ? '首次启动需要创建管理员，之后可添加值班员和只读账号。'
                  : '使用管理员分配的账号登录，可远程查看各点位监控。'}
              </p>
            </div>

            <label className="auth-field">
              <span>用户名</span>
              <input
                value={username}
                autoComplete="username"
                autoFocus
                required
                placeholder="请输入用户名"
                data-testid="login-username"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            {mode === 'setup' && (
              <label className="auth-field">
                <span>显示名称</span>
                <input
                  value={displayName}
                  autoComplete="name"
                  maxLength={32}
                  placeholder="例如：消防中控室"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            )}

            <label className="auth-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'setup' ? 8 : undefined}
                placeholder={mode === 'setup' ? '至少 8 位' : '请输入密码'}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {mode === 'setup' && (
              <label className="auth-field">
                <span>确认密码</span>
                <input
                  type="password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  placeholder="再次输入密码"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
            )}

            {(localError || error) && (
              <p className="auth-message" role="alert">
                {localError || error}
              </p>
            )}

            <button type="submit" className="btn btn-danger auth-submit" disabled={submitting} data-testid="login-submit">
              {submitting ? '请稍候…' : mode === 'setup' ? '创建并进入系统' : '登录'}
            </button>

            <p className="auth-footnote">
              系统数据保存在您自己部署的服务器中，浏览器不会保存监控密码。
            </p>
          </form>
        )}
      </main>
    </div>
  );
}

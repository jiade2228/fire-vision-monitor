import { useState } from 'react';
import type { ViewKey } from '../types';
import { ROLE_LABELS } from '../lib/api';
import type { SessionUser } from '../lib/api';
import { formatDate, formatTime } from '../lib/format';
import { useNow } from '../hooks/useNow';
import { applyTheme, loadTheme, toggleTheme, type Theme } from '../lib/theme';

interface Props {
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
  pendingCount: number;
  onlineCount: number;
  totalCount: number;
  platformName: string;
  user: SessionUser;
  onManage: () => void;
  onLogout: () => void;
}

const TABS: { key: ViewKey; label: string }[] = [
  { key: 'monitor', label: '实时监控' },
  { key: 'alarms', label: '告警中心' },
  { key: 'records', label: '处置记录' },
];

function Clock() {
  const now = useNow(1000);
  return (
    <div className="topbar-clock">
      <strong>{formatTime(now)}</strong>
      <span>{formatDate(now)}</span>
    </div>
  );
}

export default function TopBar({
  view,
  onViewChange,
  pendingCount,
  onlineCount,
  totalCount,
  platformName,
  user,
  onManage,
  onLogout,
}: Props) {
  const live = onlineCount > 0;
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const onToggleTheme = () => {
    const next = toggleTheme(theme);
    setTheme(next);
    applyTheme(next);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path
              d="M12 2.6c2.6 3 1.2 5.1 3 6.7 1 .9 2.4 1.2 2.8 3.1.5 2.4-1 4.1-1 4.1.5-2.6-1.1-3.9-2.1-4.6.3 2.3-.8 3.2-1.6 4.1-.8.9-1.4 1.9-1 3.4-1.9-.9-3-2.6-3-4.7 0-2.2 1.6-3.4 1.5-5.4-.1-1.2-.7-2.2-.7-2.2s-.7 1.1-.9 2.6c-.9-1.3-1-2.9-.4-4.3C9.5 4.4 11 3.3 12 2.6Z"
              fill="currentColor"
            />
            <path
              d="M12 21.4c-3 0-5.4-2.2-5.4-5 0-1.9 1-3.3 1.9-4.4.1 1.5.8 2.4 1.6 3 .9.7 1.6 1.4 1.6 2.6 0 .5-.1.9-.3 1.3.8-.2 1.4-.8 1.8-1.5.3.6.4 1.2.4 1.8 0 1.2-.6 2-.6 2Z"
              fill="currentColor"
              opacity="0.55"
            />
          </svg>
        </span>
        <div className="brand-text">
          <h1 title={platformName}>{platformName}</h1>
          <p>FLAME VISION · 智慧消防值守中心</p>
        </div>
      </div>

      <div className="topbar-status">
        <span className={`pill ${live ? 'pill--live' : ''}`}>
          <i className={`live-dot ${live ? '' : 'is-idle'}`} aria-hidden="true" />
          {live ? '识别引擎运行中' : '等待视频源接入'}
        </span>
        <span className="pill">
          在线通道 {onlineCount}/{totalCount}
        </span>
        <button
          type="button"
          className={`pill pill-button ${pendingCount > 0 ? 'pill--danger' : 'pill--ok'}`}
          onClick={() => onViewChange('alarms')}
          title="打开告警中心"
        >
          待处置 {pendingCount}
        </button>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="topbar-settings topbar-theme"
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-pressed={theme === 'light'}
        >
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
        {(user.role === 'admin' || user.siteAdmin) && (
          <button
            type="button"
            className="topbar-settings"
            onClick={onManage}
            title="管理远程点位、视频流和访问账号"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none">
              <path
                d="M2.5 4.5h11M2.5 11.5h11M5.5 2v5M10.5 9v5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            系统管理
          </button>
        )}
        <span className="topbar-user" title={`@${user.username}`}>
          <strong>{user.displayName}</strong>
          <span>{ROLE_LABELS[user.role]}</span>
        </span>
        <button type="button" className="topbar-logout" onClick={onLogout}>
          退出
        </button>
        <Clock />
      </div>

      <nav className="nav-tabs" aria-label="主导航">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`nav-tab ${view === tab.key ? 'is-active' : ''}`}
            onClick={() => onViewChange(tab.key)}
            aria-current={view === tab.key ? 'page' : undefined}
          >
            {tab.label}
            {tab.key === 'alarms' && pendingCount > 0 && (
              <span className="nav-badge">{pendingCount}</span>
            )}
          </button>
        ))}
        <span className="nav-hint">接入视频源后自动识别 · 不使用模拟数据</span>
      </nav>
    </header>
  );
}
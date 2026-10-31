import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { SessionUser } from '../lib/api';
import AuthScreen from '../components/AuthScreen';

interface AuthContextValue {
  user: SessionUser;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setServerError('');
    try {
      const status = await api.authStatus();
      setNeedsSetup(status.needsSetup);
      setUser(status.user);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setServerError('');
      } else {
        setServerError(
          error instanceof ApiError ? error.message : '无法读取登录状态，请稍后重试',
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
      setNeedsSetup(false);
      setServerError('');
      setFormError('登录状态已失效，请重新登录');
    };
    window.addEventListener('flame-vision:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('flame-vision:unauthorized', handleUnauthorized);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setSubmitting(true);
    setFormError('');
    try {
      const result = await api.login({ username, password });
      setUser(result.user);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const setup = useCallback(
    async (username: string, displayName: string, password: string) => {
      setSubmitting(true);
      setFormError('');
      try {
        const result = await api.setup({ username, displayName, password });
        setUser(result.user);
        setNeedsSetup(false);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : '初始化失败');
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 本地仍退出，避免会话状态卡死。
    }
    setUser(null);
    setNeedsSetup(false);
    setFormError('');
  }, []);

  const contextValue = useMemo(
    () => (user ? { user, logout } : null),
    [user, logout],
  );

  if (loading) {
    return (
      <div className="auth-page auth-page--loading">
        <div className="auth-loading">
          <span className="auth-flame" aria-hidden="true" />
          <strong>正在连接监控服务…</strong>
        </div>
      </div>
    );
  }

  if (serverError) {
    return (
      <AuthScreen
        mode="error"
        error={serverError}
        submitting={false}
        onRetry={() => {
          void loadStatus();
        }}
        onLogin={() => undefined}
        onSetup={() => undefined}
      />
    );
  }

  if (!user) {
    return (
      <AuthScreen
        mode={needsSetup ? 'setup' : 'login'}
        error={formError}
        submitting={submitting}
        onRetry={() => {
          void loadStatus();
        }}
        onLogin={(username, password) => {
          void login(username, password);
        }}
        onSetup={(username, displayName, password) => {
          void setup(username, displayName, password);
        }}
      />
    );
  }

  return (
    <AuthContext.Provider value={contextValue as AuthContextValue}>
      {children}
    </AuthContext.Provider>
  );
}

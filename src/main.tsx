import { createRoot } from 'react-dom/client';
import App from './App';
import AuthProvider from './context/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyTheme, loadTheme } from './lib/theme';
import './styles/app.css';

// 在挂载前应用已保存的主题，避免刷新时先闪一下深色。
applyTheme(loadTheme());

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <ErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ErrorBoundary>,
  );
}
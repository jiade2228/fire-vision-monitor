/** 界面主题：默认沿用既有深色外观，切换结果持久化到 localStorage。 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'flame-vision.theme.v1';
const META_SELECTOR = 'meta[name="theme-color"]';

export const THEME_COLORS: Record<Theme, string> = {
  dark: '#070c14',
  light: '#f2f5f9',
};

export function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // 隐私模式或存储被禁用时回退到默认深色。
    return 'dark';
  }
}

/** 应用并保存主题；同时同步浏览器 UI 配色与表单控件的 color-scheme。 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector(META_SELECTOR);
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 保存失败不影响本次切换。
  }
}

export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

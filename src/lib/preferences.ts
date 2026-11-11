import type { DetectionSensitivity } from '../types';

export const DEFAULT_PLATFORM_NAME = '火情视频识别监控平台';

export type LocalDetectionMode = 'auto' | 'on' | 'off';

export interface AppPreferences {
  soundEnabled: boolean;
  sensitivity: DetectionSensitivity;
  platformName: string;
  localDetection: LocalDetectionMode;
}

const STORAGE_KEY = 'flame-vision.preferences.v1';
const MAX_PLATFORM_NAME = 28;

const DEFAULTS: AppPreferences = {
  soundEnabled: true,
  sensitivity: 'standard',
  platformName: DEFAULT_PLATFORM_NAME,
  localDetection: 'auto',
};

function cleanText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

/**
 * 返回一份新的默认对象。
 *
 * 原实现直接返回模块级的 `DEFAULTS` 引用：任何调用方原地修改返回值，
 * 都会污染全局默认值，并被后续所有 `loadPreferences()` 观察到。
 *
 * @returns {AppPreferences} 独立的偏好副本。
 */
function defaultPreferences(): AppPreferences {
  return { ...DEFAULTS };
}

export function loadPreferences(): AppPreferences {
  if (typeof window === 'undefined') return defaultPreferences();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultPreferences();
    }
    const value = parsed as Record<string, unknown>;
    return {
      soundEnabled:
        typeof value.soundEnabled === 'boolean'
          ? value.soundEnabled
          : DEFAULTS.soundEnabled,
      sensitivity:
        value.sensitivity === 'low' ||
        value.sensitivity === 'standard' ||
        value.sensitivity === 'high'
          ? value.sensitivity
          : DEFAULTS.sensitivity,
      platformName:
        typeof value.platformName === 'string' && cleanText(value.platformName, MAX_PLATFORM_NAME)
          ? cleanText(value.platformName, MAX_PLATFORM_NAME)
          : DEFAULTS.platformName,
      localDetection:
        value.localDetection === 'on' ||
        value.localDetection === 'off' ||
        value.localDetection === 'auto'
          ? value.localDetection
          : DEFAULTS.localDetection,
    };
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(preferences: AppPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 设置保存失败不影响监控主流程。
  }
}


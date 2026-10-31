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

export function loadPreferences(): AppPreferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULTS;
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
    return DEFAULTS;
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


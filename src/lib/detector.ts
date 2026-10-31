import type { DetectionResult, DetectionSensitivity } from '../types';

export type FrameAnalysis = DetectionResult;

interface SensitivityProfile {
  fireRatio: number;
  smokeRatio: number;
  fireFrames: number;
  smokeFrames: number;
}

const PROFILES: Record<DetectionSensitivity, SensitivityProfile> = {
  low: { fireRatio: 0.02, smokeRatio: 0.032, fireFrames: 4, smokeFrames: 5 },
  standard: { fireRatio: 0.012, smokeRatio: 0.022, fireFrames: 3, smokeFrames: 4 },
  high: { fireRatio: 0.007, smokeRatio: 0.014, fireFrames: 2, smokeFrames: 3 },
};

export const SENSITIVITY_META: Record<
  DetectionSensitivity,
  { label: string; hint: string }
> = {
  low: { label: '稳健', hint: '减少误报，适合灯光变化较多的场景' },
  standard: { label: '标准', hint: '平衡检出速度与误报率' },
  high: { label: '灵敏', hint: '更早发现异常，但误报概率会增加' },
};

const MAX_SMOKE_FRAME_RATIO = 0.15;
const SHIFT_WINDOW = 4;
const MAX_RECENT_SHIFT = 6;
const SHIFT_SAMPLE_STEP = 2;
const SHIFT_SEARCH_RADIUS = 6;

const clampPercent = (value: number) => Math.min(97, Math.max(3, value));

/**
 * 使用降采样灰度的块匹配估计全局镜头位移（以采样图像素为单位）。
 * 固定机位近似为 0；镜头平移时用于把烟雾检测和背景运动区分开。
 */
function estimateGlobalShift(
  prevGray: Uint8Array,
  gray: Uint8Array,
  width: number,
  height: number,
): { dx: number; dy: number } {
  const smallWidth = Math.floor(width / SHIFT_SAMPLE_STEP);
  const smallHeight = Math.floor(height / SHIFT_SAMPLE_STEP);
  if (smallWidth <= SHIFT_SEARCH_RADIUS * 2 || smallHeight <= SHIFT_SEARCH_RADIUS * 2) {
    return { dx: 0, dy: 0 };
  }

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let dy = -SHIFT_SEARCH_RADIUS; dy <= SHIFT_SEARCH_RADIUS; dy += 1) {
    for (let dx = -SHIFT_SEARCH_RADIUS; dx <= SHIFT_SEARCH_RADIUS; dx += 1) {
      let sum = 0;
      let count = 0;
      for (let y = SHIFT_SEARCH_RADIUS; y < smallHeight - SHIFT_SEARCH_RADIUS; y += 1) {
        for (let x = SHIFT_SEARCH_RADIUS; x < smallWidth - SHIFT_SEARCH_RADIUS; x += 1) {
          const current = gray[(y * SHIFT_SAMPLE_STEP) * width + x * SHIFT_SAMPLE_STEP];
          const previous =
            prevGray[
              ((y + dy) * SHIFT_SAMPLE_STEP) * width + (x + dx) * SHIFT_SAMPLE_STEP
            ];
          sum += Math.abs(current - previous);
          count += 1;
        }
      }
      const score = count > 0 ? sum / count : Number.POSITIVE_INFINITY;
      if (score < bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return {
    dx: bestDx * SHIFT_SAMPLE_STEP,
    dy: bestDy * SHIFT_SAMPLE_STEP,
  };
}

/**
 * 基于真实视频帧的火焰 / 烟雾特征分析。
 * 不使用任何随机数或预设数据，全部结果来自传入的像素。
 */
export class FlameDetector {
  private prevGray: Uint8Array | null = null;
  private shiftHistory: number[] = [];
  private fireStreak = 0;
  private smokeStreak = 0;
  private lastEmitAt = 0;
  private readonly cooldownMs: number;
  private readonly profile: SensitivityProfile;

  constructor(sensitivity: DetectionSensitivity = 'standard', cooldownMs = 12000) {
    this.cooldownMs = cooldownMs;
    this.profile = PROFILES[sensitivity];
  }

  analyze(data: Uint8ClampedArray, width: number, height: number): FrameAnalysis | null {
    if (!width || !height) return null;
    const total = width * height;
    if (data.length < total * 4) return null;

    const gray = new Uint8Array(total);
    const prev = this.prevGray;

    for (let p = 0; p < total; p += 1) {
      const i = p * 4;
      gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }

    const shift = prev ? estimateGlobalShift(prev, gray, width, height) : { dx: 0, dy: 0 };
    this.shiftHistory = [
      ...this.shiftHistory.slice(-(SHIFT_WINDOW - 1)),
      Math.abs(shift.dx) + Math.abs(shift.dy),
    ];
    const recentShift = this.shiftHistory.reduce((sum, value) => sum + value, 0);
    const cameraStable =
      this.shiftHistory.length >= SHIFT_WINDOW && recentShift <= MAX_RECENT_SHIFT;

    let fireCount = 0;
    let fireX = 0;
    let fireY = 0;
    let smokeCount = 0;
    let smokeX = 0;
    let smokeY = 0;

    for (let y = 0; y < height; y += 1) {
      const prevY = Math.min(height - 1, Math.max(0, y + shift.dy));
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (!prev) continue;
        const prevX = Math.min(width - 1, Math.max(0, x + shift.dx));
        const motion = Math.abs(gray[p] - prev[prevY * width + prevX]);
        if (motion < 6) continue;

        const i = p * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = gray[p];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;

        if (luma > 100 && r > 145 && r - b > 45 && sat > 0.38 && g < r) {
          fireCount += 1;
          fireX += x;
          fireY += y;
          continue;
        }

        if (luma > 55 && luma < 205 && sat < 0.13 && motion > 8) {
          smokeCount += 1;
          smokeX += x;
          smokeY += y;
        }
      }
    }

    this.prevGray = gray;

    const fireRatio = fireCount / total;
    const smokeRatio = smokeCount / total;
    const fireHit = fireRatio >= this.profile.fireRatio && fireCount >= 6;
    // 大范围低饱和运动通常来自镜头平移或整屏场景变化，不是局部烟雾。
    const smokeHit =
      smokeRatio >= this.profile.smokeRatio &&
      smokeCount >= 10 &&
      smokeRatio < MAX_SMOKE_FRAME_RATIO &&
      cameraStable;

    this.fireStreak = fireHit ? this.fireStreak + 1 : 0;
    this.smokeStreak = smokeHit ? this.smokeStreak + 1 : 0;

    const now = Date.now();
    if (now - this.lastEmitAt < this.cooldownMs) return null;

    if (this.fireStreak >= this.profile.fireFrames) {
      this.lastEmitAt = now;
      this.fireStreak = 0;
      this.smokeStreak = 0;
      return {
        level: 'fire',
        confidence: Math.min(98, Math.round(74 + fireRatio * 900)),
        hotspot: {
          x: clampPercent((fireX / fireCount / width) * 100),
          y: clampPercent((fireY / fireCount / height) * 100),
        },
      };
    }

    if (this.smokeStreak >= this.profile.smokeFrames) {
      this.lastEmitAt = now;
      this.fireStreak = 0;
      this.smokeStreak = 0;
      return {
        level: 'smoke',
        confidence: Math.min(95, Math.round(63 + smokeRatio * 700)),
        hotspot: {
          x: clampPercent((smokeX / smokeCount / width) * 100),
          y: clampPercent((smokeY / smokeCount / height) * 100),
        },
      };
    }

    return null;
  }

  reset() {
    this.prevGray = null;
    this.shiftHistory = [];
    this.fireStreak = 0;
    this.smokeStreak = 0;
  }
}
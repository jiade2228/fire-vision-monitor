/**
 * 服务端火焰 / 烟雾像素分析。
 *
 * 算法与前端 src/lib/detector.ts 保持一致：不使用 canvas，也不使用随机数，
 * 全部结论都来自调用方传入的 RGBA 帧。这样浏览器端与服务端对同一段视频
 * 会给出相近的判定，便于现场比对。
 */

const PROFILES = {
  low: { fireRatio: 0.02, smokeRatio: 0.032, fireFrames: 4, smokeFrames: 5 },
  standard: { fireRatio: 0.012, smokeRatio: 0.022, fireFrames: 3, smokeFrames: 4 },
  high: { fireRatio: 0.007, smokeRatio: 0.014, fireFrames: 2, smokeFrames: 3 },
};

export const SENSITIVITY_META = {
  low: { label: '稳健', hint: '减少误报，适合灯光变化较多的场景' },
  standard: { label: '标准', hint: '平衡检出速度与误报率' },
  high: { label: '灵敏', hint: '更早发现异常，但误报概率会增加' },
};

export const DETECTION_SENSITIVITIES = Object.keys(PROFILES);

const MAX_SMOKE_FRAME_RATIO = 0.15;
const SHIFT_WINDOW = 4;
const MAX_RECENT_SHIFT = 6;
const SHIFT_SAMPLE_STEP = 2;
const SHIFT_SEARCH_RADIUS = 6;

const clampPercent = (value) => Math.min(97, Math.max(3, value));

const FLICKER_HISTORY = 12;
const FLICKER_MIN_DELTA = 2;
const SMALL_FIRE_RATIO = 0.03;

/**
 * 由百分比矩形生成屏蔽掩码：1=参与检测，0=屏蔽。
 * 没有任何屏蔽区时返回 null，让检测循环跳过掩码判断。
 */
export function buildRoiMask(rects, width, height) {
  if (!Array.isArray(rects) || rects.length === 0 || !width || !height) return null;
  const mask = new Uint8Array(width * height).fill(1);
  for (const rect of rects) {
    const x1 = Math.max(0, Math.min(width, Math.round((Number(rect.x) / 100) * width)));
    const y1 = Math.max(0, Math.min(height, Math.round((Number(rect.y) / 100) * height)));
    const x2 = Math.max(
      0,
      Math.min(width, Math.round(((Number(rect.x) + Number(rect.w)) / 100) * width)),
    );
    const y2 = Math.max(
      0,
      Math.min(height, Math.round(((Number(rect.y) + Number(rect.h)) / 100) * height)),
    );
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) mask[y * width + x] = 0;
    }
  }
  return mask;
}

/** 统计亮度序列的方向变化次数，用于区分“闪烁火焰”和“静态红色物体”。 */
export function countFlicker(values) {
  let changes = 0;
  let lastSign = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (Math.abs(delta) < FLICKER_MIN_DELTA) continue;
    const sign = delta > 0 ? 1 : -1;
    if (lastSign && sign !== lastSign) changes += 1;
    lastSign = sign;
  }
  return changes;
}

/**
 * 用降采样灰度的块匹配估计全局镜头位移（以采样图像素为单位）。
 * 固定机位近似为 0；镜头平移时用于把烟雾检测和背景运动区分开。
 */
function estimateGlobalShift(prevGray, gray, width, height) {
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
          const current = gray[y * SHIFT_SAMPLE_STEP * width + x * SHIFT_SAMPLE_STEP];
          const previous =
            prevGray[
              (y + dy) * SHIFT_SAMPLE_STEP * width + (x + dx) * SHIFT_SAMPLE_STEP
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

export class FlameDetector {
  constructor(sensitivity = 'standard', cooldownMs = 12_000) {
    this.cooldownMs = cooldownMs;
    this.profile = PROFILES[sensitivity] ?? PROFILES.standard;
    this.prevGray = null;
    this.shiftHistory = [];
    this.fireStreak = 0;
    this.smokeStreak = 0;
    this.fireLumaHistory = [];
    this.lastEmitAt = 0;
  }

  analyze(data, width, height, { mask = null } = {}) {
    if (!width || !height) return null;
    const total = width * height;
    if (data.length < total * 4) return null;

    // 掩码区域的像素不参与检测，比例也按“有效像素”计算，避免屏蔽后阈值失真。
    let activePixels = total;
    if (mask) {
      activePixels = 0;
      for (let p = 0; p < total; p += 1) if (mask[p]) activePixels += 1;
      if (activePixels === 0) return null;
    }

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
    let fireLuma = 0;
    let smokeCount = 0;
    let smokeX = 0;
    let smokeY = 0;

    for (let y = 0; y < height; y += 1) {
      const prevY = Math.min(height - 1, Math.max(0, y + shift.dy));
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (mask && mask[p] === 0) continue;
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
          fireLuma += luma;
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

    if (fireCount > 0) {
      this.fireLumaHistory.push(fireLuma / fireCount);
      if (this.fireLumaHistory.length > FLICKER_HISTORY) this.fireLumaHistory.shift();
    } else {
      this.fireLumaHistory.length = 0;
    }
    const flicker = countFlicker(this.fireLumaHistory);

    const fireRatio = fireCount / activePixels;
    const smokeRatio = smokeCount / activePixels;
    const fireHit =
      fireRatio >= this.profile.fireRatio &&
      fireCount >= 6 &&
      // 小面积红色物体（红色工装、指示灯、尾灯）必须出现亮度闪烁才判为火焰。
      (fireRatio >= SMALL_FIRE_RATIO || flicker >= 2);
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
      this.fireLumaHistory.length = 0;
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
      this.fireLumaHistory.length = 0;
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
    this.fireLumaHistory = [];
  }
}

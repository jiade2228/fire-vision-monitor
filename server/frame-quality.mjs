/**
 * 画面质量分析：识别「流在线但画面无效」的三类异常。
 *
 * 与火焰/烟雾检测共用同一条 RGBA 帧管线，全部结论来自像素统计，
 * 不依赖随机数与外部模型：
 * - dark    过暗/无光：画面近乎全黑（镜头被断电、遮黑布、夜间无照度）
 * - bright  过曝：画面近乎全白（强光直射、白炽遮挡物）
 * - covered 遮挡/失焦：画面低纹理（镜头盖、纸片贴住、严重脱焦）
 *
 * 单帧结论只是候选，上层（detection-engine）负责连续多帧去抖，
 * 夜视低照度场景的噪声梯度通常高于阈值，不会持续命中 covered。
 */

const SAMPLE_STEP = 2;

// 阈值设计：0-255 亮度坐标。
const DARK_MEAN_MAX = 14;
const DARK_RATIO_MIN = 0.92;
const BRIGHT_LUMA_MIN = 244;
const BRIGHT_RATIO_MIN = 0.88;
const COVERED_EDGE_MAX = 1.6;

/**
 * 分析一帧 RGBA 画面质量。
 *
 * @param {Buffer|Uint8Array} data RGBA 帧数据（width × height × 4 字节）。
 * @param {number} width 帧宽。
 * @param {number} height 帧高。
 * @returns {{ok: true} | {ok: false, reason: 'dark'|'bright'|'covered', meanLuma: number, edgeStrength: number, darkRatio: number, brightRatio: number}}
 *   ok=true 表示画面可用；ok=false 时携带异常类别与统计值（便于日志与事件文案）。
 */
export function analyzeFrameQuality(data, width, height) {
  const total = width * height;
  if (!width || !height || !data || data.length < total * 4) return { ok: true };

  // 单遍降采样：灰度、暗/亮占比、梯度共用一次遍历。
  let sampled = 0;
  let lumaSum = 0;
  let darkCount = 0;
  let brightCount = 0;
  let edgeSum = 0;
  let edgeCount = 0;

  for (let y = 0; y + SAMPLE_STEP < height; y += SAMPLE_STEP) {
    const rowTop = y * width;
    const rowBottom = (y + SAMPLE_STEP) * width;
    for (let x = 0; x + SAMPLE_STEP < width; x += SAMPLE_STEP) {
      const i = (rowTop + x) * 4;
      const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      const iRight = (rowTop + x + SAMPLE_STEP) * 4;
      const iBottom = (rowBottom + x) * 4;
      const lumaRight =
        (data[iRight] * 299 + data[iRight + 1] * 587 + data[iRight + 2] * 114) / 1000;
      const lumaBottom =
        (data[iBottom] * 299 + data[iBottom + 1] * 587 + data[iBottom + 2] * 114) / 1000;
      lumaSum += luma;
      if (luma < 10) darkCount += 1;
      if (luma > BRIGHT_LUMA_MIN) brightCount += 1;
      edgeSum += Math.abs(lumaRight - luma) + Math.abs(lumaBottom - luma);
      edgeCount += 1;
      sampled += 1;
    }
  }
  if (!sampled || !edgeCount) return { ok: true };

  const meanLuma = lumaSum / sampled;
  const darkRatio = darkCount / sampled;
  const brightRatio = brightCount / sampled;
  const edgeStrength = edgeSum / edgeCount;

  if (meanLuma < DARK_MEAN_MAX && darkRatio >= DARK_RATIO_MIN) {
    return { ok: false, reason: 'dark', meanLuma, edgeStrength, darkRatio, brightRatio };
  }
  if (brightRatio >= BRIGHT_RATIO_MIN) {
    return { ok: false, reason: 'bright', meanLuma, edgeStrength, darkRatio, brightRatio };
  }
  if (edgeStrength < COVERED_EDGE_MAX) {
    return { ok: false, reason: 'covered', meanLuma, edgeStrength, darkRatio, brightRatio };
  }
  return { ok: true, meanLuma, edgeStrength, darkRatio, brightRatio };
}

/** 异常类别 → 中文短文案（用于告警事件与通知）。 */
export const FRAME_QUALITY_REASONS = {
  dark: '画面过暗或无光',
  bright: '画面过曝（强光直射）',
  covered: '疑似镜头被遮挡或严重失焦',
};

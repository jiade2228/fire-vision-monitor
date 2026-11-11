/**
 * FFmpeg 能力探测与编码器选择。
 *
 * 依据：`streams.mjs` 原先把视频编码器硬编码为 `libx264`（仅允许环境变量覆盖）。
 * 但现场 FFmpeg 来源不一 —— Windows 便携包、Linux 发行版仓库包、Docker 镜像、
 * 海康/大华随附的裁剪版 —— 其中不少**不含 libx264**（GPL 组件被裁掉）。此时
 * 转 HLS 会以 `Unknown encoder 'libx264'` 失败，前端表现为「点位一直转圈」，
 * 而日志里只有 ffmpeg 的 stderr，运维很难联想到是编码器缺失。
 *
 * 这里在启动时探测一次编码器列表，选一个可用的，并把降级结果写进日志与
 * /api/system，便于现场快速定位。
 */

/** 按优先级尝试的软件编码器（都是各发行版 FFmpeg 常见内置项）。 */
export const CODEC_FALLBACK_CHAIN = ['libx264', 'h264', 'mpeg4'];

/**
 * 解析 `ffmpeg -encoders` 输出中的编码器名称集合。
 *
 * 输出形如：
 * ```
 *  V..... = Video
 *  ------
 *  V....D libx264              libx264 H.264 / AVC ...
 *  V....D mpeg4                MPEG-4 part 2
 * ```
 * 兼容 5/6 位 flags 与行首空白差异。
 *
 * @param {string} output ffmpeg 的标准输出。
 * @returns {Set<string>} 编码器名集合。
 */
export function parseEncoderNames(output) {
  const names = new Set();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    // 跳过表头与分隔线
    if (!line || /^\s*-{2,}/.test(line) || /Encoders:|^\s*[VAS][.A-Z]{4,}\s*=/.test(line)) {
      continue;
    }
    const matched = line.match(/^\s*[A-Z.]{5,6}\s+(\S+)/);
    if (matched) names.add(matched[1]);
  }
  return names;
}

/**
 * 选择实际可用的视频编码器。
 *
 * @param {object} options
 * @param {Set<string>|string[]} options.encoders 已探测到的编码器。
 * @param {string} [options.preferred] 环境变量显式指定的编码器（最高优先）。
 * @param {string[]} [options.chain] 回退链。
 * @returns {{codec: string, degraded: boolean, reason: string}}
 *   `degraded=true` 表示首选不可用、已回退，调用方应记录 warn。
 */
export function chooseVideoCodec({
  encoders,
  preferred = process.env.FFMPEG_VIDEO_CODEC || '',
  chain = CODEC_FALLBACK_CHAIN,
}) {
  const available = encoders instanceof Set ? encoders : new Set(encoders ?? []);
  const wanted = String(preferred || '').trim();
  if (wanted) {
    if (available.has(wanted)) {
      return { codec: wanted, degraded: false, reason: '使用环境变量指定的编码器' };
    }
    // 显式指定的不可用：仍回退，但必须让运维知道配置未生效。
    const fallback = chain.find((name) => available.has(name));
    if (fallback) {
      return {
        codec: fallback,
        degraded: true,
        reason: `FFMPEG_VIDEO_CODEC=${wanted} 不可用，已回退到 ${fallback}`,
      };
    }
    return {
      codec: wanted,
      degraded: true,
      reason: `FFMPEG_VIDEO_CODEC=${wanted} 不可用且无回退编码器`,
    };
  }
  const found = chain.find((name) => available.has(name));
  if (found) {
    return {
      codec: found,
      degraded: found !== chain[0],
      reason: found === chain[0] ? '首选编码器可用' : `首选不可用，已回退到 ${found}`,
    };
  }
  return {
    codec: chain[chain.length - 1],
    degraded: true,
    reason: '未探测到任何已知软件编码器，使用 mpeg4 兜底（画质与性能可能下降）',
  };
}

/**
 * 探测 ffmpeg 能力（编码器列表 + 选定编码器）。
 *
 * @param {object} [options]
 * @param {string} [options.ffmpegPath] ffmpeg 可执行路径。
 * @param {Function} [options.execImpl] 注入的执行函数 `(args, timeoutMs) => Promise<string>`（测试用）。
 * @param {number} [options.timeoutMs] 探测超时，避免拖慢启动。
 * @returns {Promise<{ok: boolean, encoders: Set<string>, codec: string, degraded: boolean, reason: string, error?: string}>}
 */
export async function detectFfmpegCapabilities({
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  execImpl,
  timeoutMs = 5000,
} = {}) {
  const exec =
    execImpl ??
    (async (args, limitMs) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run(ffmpegPath, args, {
        timeout: limitMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return String(stdout ?? '');
    });

  try {
    const stdout = await exec(['-hide_banner', '-encoders'], timeoutMs);
    const encoders = parseEncoderNames(stdout);
    const choice = chooseVideoCodec({ encoders });
    return {
      ok: true,
      encoders,
      codec: choice.codec,
      degraded: choice.degraded,
      reason: choice.reason,
    };
  } catch (error) {
    // 探测失败不阻断启动：streams 仍会尝试运行，只是放弃能力判定。
    return {
      ok: false,
      encoders: new Set(),
      codec: process.env.FFMPEG_VIDEO_CODEC || CODEC_FALLBACK_CHAIN[0],
      degraded: true,
      reason: 'FFmpeg 能力探测失败，沿用配置默认值',
      error: String(error?.message ?? error).slice(0, 200),
    };
  }
}

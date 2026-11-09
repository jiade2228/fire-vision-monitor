/**
 * 录像段实际时长校准（设计文档 §4：「ended_at 由 ffprobe 或 segment 回调校准」）。
 *
 * 索引层默认用 nominal 60s 估计段尾，最后一段与断流短段会虚增；
 * 本模块在对账时按需用 ffprobe 读 format.duration 并写回索引。
 * 全部通过 spawnImpl 注入，且只探测「时长恰为 nominal」的未校准段，
 * 因此 ffprobe 缺失、探测失败或段太多时都能安全降级为原有行为。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { safeSegmentPath } from './recording-playback.mjs';

/**
 * 读取单个段的时长（毫秒）；任何失败返回 null。
 * @returns {Promise<number|null>}
 */
function probeOne(absolutePath, { ffprobePath, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        ffprobePath,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=nw=1:nk=1',
          absolutePath,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on?.('data', (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-512);
    });
    child.on?.('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on?.('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const seconds = Number(stdout.trim());
      return finish(
        Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      );
    });
  });
}

/**
 * 批量探测未校准段的实际时长。
 * @param {object} options
 * @param {Array<{file:string, startedAt:number, endedAt:number}>} options.segments
 * @param {string} options.rootDir
 * @param {number} [options.nominalMs] 名义段长，用于识别「尚未校准」的段
 * @param {number} [options.maxProbes] 单轮探测上限，避免 IO 尖峰
 * @returns {Promise<Map<string, number>>} file → 实际时长 ms
 */
export async function probeSegmentDurations({
  segments = [],
  rootDir,
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  spawnImpl = nodeSpawn,
  nominalMs = 60_000,
  maxProbes = 50,
  timeoutMs = 5_000,
}) {
  const durations = new Map();
  const candidates = segments
    .filter(
      (segment) =>
        segment &&
        Math.abs(segment.endedAt - segment.startedAt - nominalMs) < 1_000,
    )
    .slice(0, Math.max(0, maxProbes));
  for (const segment of candidates) {
    const absolute = safeSegmentPath(rootDir, segment.file);
    if (!absolute) continue;
    const value = await probeOne(absolute, { ffprobePath, spawnImpl, timeoutMs });
    if (value) durations.set(segment.file, value);
  }
  return durations;
}

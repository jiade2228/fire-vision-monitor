import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 持续录像分段索引（设计文档 docs/continuous-recording-design.md §4 的第一阶段）。
 *
 * 本模块刻意不依赖 FFmpeg / 真机：只做「目录扫描 → 索引对账 → 时间线构建」，
 * 因此可以在纯文件系统夹具上完整测试。采集 worker 与按需转码留待真机联调。
 *
 * 目录约定（全部按 UTC 解释，避免服务端依赖客户端时区）：
 *   <root>/<cameraId>/<YYYYMMDD>/<HHmmss>.ts
 * 与 data/recordings/ 下的告警短视频 mp4 完全隔离。
 */

const DAY_DIR = /^(\d{4})(\d{2})(\d{2})$/;
const SEGMENT_FILE = /^(\d{2})(\d{2})(\d{2})\.ts$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} name YYYYMMDD 目录名 @returns {number | null} 当天 00:00 UTC 的 epoch ms */
export function parseUtcDay(name) {
  const match = DAY_DIR.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

/** @param {string} name HHmmss.ts 段文件名 @returns {number | null} 当天内的毫秒偏移 */
export function parseSegmentTime(name) {
  const match = SEGMENT_FILE.exec(name);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return (hour * 3600 + minute * 60 + second) * 1000;
}

/**
 * 由 `YYYY-MM-DD` / `YYYYMMDD` 得到 UTC 日范围。
 * @param {string} date
 * @returns {{from:number, to:number} | null} 非法日期返回 null
 */
export function dayRangeFromDate(date) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(date ?? ''));
  if (!match) return null;
  const from = parseUtcDay(`${match[1]}${match[2]}${match[3]}`);
  return from === null ? null : { from, to: from + DAY_MS };
}

/**
 * 依据相邻段起点校准每段结束时间：正常取 nominal 时长，
 * 若下一段来得更早（短段/提前切分）则以下一段起点为准，
 * 若下一段间隔过大则保留 nominal，时间线上自然形成 gap。
 *
 * @param {Array<{cameraId:string, file:string, startedAt:number, bytes:number}>} entries
 * @param {{segmentSeconds?:number}} [options]
 */
export function finalizeSegmentDurations(entries, { segmentSeconds = 60 } = {}) {
  const nominalMs = segmentSeconds * 1000;
  const byCamera = new Map();
  for (const entry of entries) {
    if (!byCamera.has(entry.cameraId)) byCamera.set(entry.cameraId, []);
    byCamera.get(entry.cameraId).push(entry);
  }
  const result = [];
  for (const [cameraId, list] of byCamera) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    for (let index = 0; index < list.length; index += 1) {
      const current = list[index];
      const next = list[index + 1];
      let endedAt = current.startedAt + nominalMs;
      if (next) {
        const delta = next.startedAt - current.startedAt;
        if (delta > 0 && delta <= nominalMs * 2) {
          endedAt = Math.min(endedAt, next.startedAt);
        }
      }
      result.push({
        id: current.file,
        cameraId,
        file: current.file,
        startedAt: current.startedAt,
        endedAt,
        bytes: current.bytes,
        protected: false,
      });
    }
  }
  return result.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 扫描录像目录；目录不存在时返回空数组（首次启动的正常状态）。
 * @param {string} rootDir
 * @param {{segmentSeconds?:number, durations?:Map<string, number>|null}} [options]
 *   durations 为可选的 ffprobe 实际时长（file → ms），不传时沿用 nominal 校准。
 * @returns {Promise<Array<{id:string, cameraId:string, file:string,
 *   startedAt:number, endedAt:number, bytes:number, protected:boolean}>>}
 */
export async function scanRecordingSegments(
  rootDir,
  { segmentSeconds = 60, durations = null } = {},
) {
  let cameras;
  try {
    cameras = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const camera of cameras) {
    if (!camera.isDirectory() || camera.name.startsWith('.')) continue;
    const cameraDir = path.join(rootDir, camera.name);
    // 采集滚动删除/水位淘汰可能与扫描并发；单个目录或文件消失不应中断整轮对账。
    let days;
    try {
      days = await fsp.readdir(cameraDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const day of days) {
      if (!day.isDirectory()) continue;
      const dayStart = parseUtcDay(day.name);
      if (dayStart === null) continue;
      const dayDir = path.join(cameraDir, day.name);
      let files;
      try {
        files = await fsp.readdir(dayDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile()) continue;
        const offset = parseSegmentTime(file.name);
        if (offset === null) continue;
        const full = path.join(dayDir, file.name);
        let bytes;
        try {
          bytes = (await fsp.stat(full)).size;
        } catch {
          continue;
        }
        entries.push({
          cameraId: camera.name,
          file: path.posix.join(camera.name, day.name, file.name),
          startedAt: dayStart + offset,
          bytes,
        });
      }
    }
  }
  const result = finalizeSegmentDurations(entries, { segmentSeconds });
  // 可选的实际时长覆盖：仅当调用方显式注入 ffprobe 结果时生效，
  // 默认（无 durations）与原有 nominal 校准逐字等价。
  if (durations?.size) {
    for (const segment of result) {
      const actual = durations.get(segment.file);
      if (Number.isFinite(actual) && actual > 0) {
        segment.endedAt = segment.startedAt + actual;
      }
    }
  }
  return result;
}

/**
 * 以文件系统为事实源对账索引：补录缺失段、校准大小、删除孤儿记录。
 * @param {{upsertRecordingSegments:Function, allRecordingSegmentFiles:Function,
 *   deleteRecordingSegments:Function}} store
 * @param {string} rootDir
 * @param {{segmentSeconds?:number,
 *   probe?: (segments: Array<object>) => Promise<Map<string, number>>}} [options]
 *   probe 为可选的 ffprobe 时长探测回调；失败或未注入时保持原有校准结果。
 */
// 定时对账与手动 reconcile 可能并发；串行化避免旧快照写回形成僵尸索引行。
let reconcileInFlight = false;

export async function reconcileRecordingSegments(store, rootDir, options = {}) {
  if (reconcileInFlight) {
    return { scanned: 0, inserted: 0, updated: 0, orphansRemoved: 0, skipped: true };
  }
  reconcileInFlight = true;
  try {
    let scanned = await scanRecordingSegments(rootDir, options);
    if (typeof options.probe === 'function') {
      try {
        const durations = await options.probe(scanned);
        if (durations?.size) {
          scanned = scanned.map((segment) => {
            const actual = durations.get(segment.file);
            return Number.isFinite(actual) && actual > 0
              ? { ...segment, endedAt: segment.startedAt + actual }
              : segment;
          });
        }
      } catch {
        // 探测失败不改变扫描结果，下一轮对账再试。
      }
    }
    const present = new Set(scanned.map((segment) => segment.file));
    const indexed = store.allRecordingSegmentFiles();
    // 目录暂时为空（采集重启/挂载切换）时不清空索引，避免时间线误报「录像全部丢失」。
    const orphans =
      scanned.length === 0 && indexed.length > 0
        ? []
        : indexed.filter((file) => !present.has(file));
    const upserted = store.upsertRecordingSegments(scanned);
    const removed = store.deleteRecordingSegments(orphans);
    return {
      scanned: scanned.length,
      inserted: upserted.inserted,
      updated: upserted.updated,
      orphansRemoved: removed,
    };
  } finally {
    reconcileInFlight = false;
  }
}

/**
 * 把段列表压成时间线：合并重叠/相邻段为连续块，并算出未覆盖的 gap。
 * @param {Array<{startedAt:number, endedAt:number, bytes?:number, protected?:boolean}>} segments
 * @param {number} from 窗口起点（epoch ms）
 * @param {number} to 窗口终点（epoch ms）
 */
export function buildTimeline(segments, from, to) {
  if (!(to > from)) {
    return { from, to, blocks: [], gaps: [], coverageMs: 0, segmentCount: 0 };
  }
  const clipped = segments
    .filter((segment) => segment.endedAt > from && segment.startedAt < to)
    .map((segment) => ({
      startedAt: Math.max(segment.startedAt, from),
      endedAt: Math.min(segment.endedAt, to),
      bytes: segment.bytes ?? 0,
      protected: Boolean(segment.protected),
    }))
    .filter((segment) => segment.endedAt > segment.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);

  /** @type {Array<{startedAt:number, endedAt:number, bytes:number, protected:boolean, segmentCount:number}>} */
  const blocks = [];
  for (const segment of clipped) {
    const last = blocks[blocks.length - 1];
    if (last && segment.startedAt <= last.endedAt) {
      last.endedAt = Math.max(last.endedAt, segment.endedAt);
      last.bytes += segment.bytes;
      last.protected = last.protected || segment.protected;
      last.segmentCount += 1;
    } else {
      blocks.push({ ...segment, segmentCount: 1 });
    }
  }

  const gaps = [];
  let cursor = from;
  for (const block of blocks) {
    if (block.startedAt > cursor) gaps.push({ startedAt: cursor, endedAt: block.startedAt });
    cursor = Math.max(cursor, block.endedAt);
  }
  if (cursor < to) gaps.push({ startedAt: cursor, endedAt: to });
  const coverageMs = blocks.reduce((total, block) => total + block.endedAt - block.startedAt, 0);
  return { from, to, blocks, gaps, coverageMs, segmentCount: clipped.length };
}

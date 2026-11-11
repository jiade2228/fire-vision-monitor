/**
 * 外部可执行文件定位（ffmpeg / ffprobe）。
 *
 * 背景：项目各处默认 `ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'`，
 * 依赖 PATH 查找。在 Linux systemd 与 Windows 服务场景下 PATH 通常完整，
 * 但 **macOS 通过 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`**，
 * Homebrew 的 `/opt/homebrew/bin`（Apple Silicon）或 `/usr/local/bin`（Intel）
 * 不在其中 —— 表现为「服务起来了，但所有 RTSP 点位转码失败、录像不生成」，
 * 而日志里只有 `spawn ffmpeg ENOENT`。
 *
 * 策略（保持既有行为优先）：
 *   1. 显式配置的环境变量最高优先，原样返回，不做猜测；
 *   2. 能在 PATH 中找到就返回原名（与改造前完全一致，不改变任何现有部署行为）；
 *   3. PATH 找不到时才尝试常见安装目录（macOS/Linux/Windows）；
 *   4. 都找不到则返回原名，让原有报错路径照旧。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 各平台常见的可执行文件安装目录（按优先级）。 */
export function candidateDirs(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin', // Apple Silicon Homebrew
      '/usr/local/bin', // Intel Homebrew / 手工安装
      '/opt/local/bin', // MacPorts
      '/usr/bin',
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\ffmpeg\\bin',
      'C:\\Program Files\\ffmpeg\\bin',
      'C:\\Program Files (x86)\\ffmpeg\\bin',
    ];
  }
  return ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/ffmpeg/bin'];
}

/**
 * 按目标平台拼接路径。
 *
 * 不能用 `path.join`：它使用**当前宿主**的分隔符。在 Windows 上跑测试或
 * 做跨平台校验时，`path.join('/usr/local/bin','ffmpeg')` 会得到
 * `\usr\local\bin\ffmpeg`，与真实 POSIX 路径不符。
 *
 * @param {string} platform 目标平台。
 * @param {...string} parts 路径片段。
 * @returns {string}
 */
function joinFor(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? String(part).replace(/[\\/]+$/, '') : String(part).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep);
}

/**
 * 在 PATH 中查找可执行文件。
 *
 * @param {string} name 可执行文件名（不带扩展名亦可）。
 * @param {object} [options]
 * @param {string} [options.pathEnv] PATH 内容（测试注入）。
 * @param {string} [options.platform] 目标平台（测试注入）。
 * @param {Function} [options.exists] 存在性判定（测试注入）。
 * @returns {string|null} 命中时返回可执行文件所在目录。
 */
export function findInPath(name, {
  pathEnv = process.env.PATH ?? '',
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(pathEnv).split(separator)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const full = joinFor(platform, dir, name + suffix);
      if (exists(full)) return dir;
    }
  }
  return null;
}

/**
 * 解析可执行文件的可用路径。
 *
 * @param {string} name 可执行文件名（如 `ffmpeg`）。
 * @param {object} [options]
 * @param {string} [options.configured] 显式配置值（环境变量），最高优先。
 * @param {string} [options.pathEnv] PATH 内容。
 * @param {string} [options.platform] 目标平台。
 * @param {Function} [options.exists] 存在性判定。
 * @param {string[]} [options.dirs] 覆盖候选目录。
 * @returns {{command: string, source: 'configured'|'path'|'fallback-dir'|'not-found', dir?: string}}
 */
export function resolveExecutable(name, {
  configured = '',
  pathEnv = process.env.PATH ?? '',
  platform = process.platform,
  exists = fs.existsSync,
  dirs = candidateDirs(platform),
} = {}) {
  const explicit = String(configured ?? '').trim();
  if (explicit) {
    return { command: explicit, source: 'configured' };
  }

  const inPath = findInPath(name, { pathEnv, platform, exists });
  if (inPath) {
    // 返回裸名：与改造前行为完全一致（PATH 已能解析，无需绝对路径）。
    return { command: name, source: 'path', dir: inPath };
  }

  const suffixes = platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const full = joinFor(platform, dir, name + suffix);
      if (exists(full)) {
        return { command: full, source: 'fallback-dir', dir };
      }
    }
  }

  return { command: name, source: 'not-found' };
}

/**
 * 一次性把 ffmpeg/ffprobe 的解析结果写回环境变量（仅在未显式配置时）。
 *
 * 这样各模块既有的 `process.env.FFMPEG_PATH || 'ffmpeg'` 默认值无需改动即可受益，
 * 也不会覆盖运维的显式配置。
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] 目标环境对象。
 * @returns {{ffmpeg: object, ffprobe: object, changed: string[]}}
 */
export function applyResolvedBinaries(env = process.env) {
  const changed = [];
  const ffmpeg = resolveExecutable('ffmpeg', { configured: env.FFMPEG_PATH });
  if (!env.FFMPEG_PATH && ffmpeg.source === 'fallback-dir') {
    env.FFMPEG_PATH = ffmpeg.command;
    changed.push('FFMPEG_PATH');
  }
  const ffprobe = resolveExecutable('ffprobe', { configured: env.FFPROBE_PATH });
  if (!env.FFPROBE_PATH && ffprobe.source === 'fallback-dir') {
    env.FFPROBE_PATH = ffprobe.command;
    changed.push('FFPROBE_PATH');
  }
  return { ffmpeg, ffprobe, changed };
}

/**
 * 读取当前进程的文件描述符软上限（POSIX）。
 *
 * macOS 默认软上限常为 256，多路 HLS + SSE + 录像并发时容易耗尽，
 * 表现为 `EMFILE: too many open files`。这里只做检测与提示，不修改限制
 * （修改需在启动器/plist 中设置，见 docs/MACOS-COMPAT.md）。
 *
 * @param {object} [options]
 * @param {Function} [options.execImpl] 注入执行函数（测试用）。
 * @returns {Promise<number|null>} 上限值；无法获取时 null。
 */
export async function readFileDescriptorLimit({
  execImpl,
  platform = os.platform(),
} = {}) {
  if (platform === 'win32') return null;
  try {
    const exec = execImpl ?? (async (args) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run('/bin/sh', args, { timeout: 1500 });
      return String(stdout ?? '');
    });
    const output = await exec(['-c', 'ulimit -n']);
    const value = Number(String(output).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

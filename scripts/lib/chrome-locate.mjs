/**
 * Chrome 可执行文件定位（E2E 与对比度扫描共用）。
 *
 * 背景：两个脚本原先各自内联了 Windows 路径候选，在 macOS/Linux 上
 * 即使装了 Chrome 也会被判为「未找到」而直接跳过 E2E/对比度检查，
 * 造成「本地绿、实际没测」的假象。这里按平台给出候选：
 *   - macOS：/Applications/... （系统级）与 ~/Applications/...（用户级）
 *   - Linux：常见发行版路径 + chrome/chromium 命令
 *   - Windows：Program Files 两个位置
 * 显式 `CHROME_PATH` 始终最高优先。
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * 返回当前平台下 Chrome 的候选路径列表（含 CHROME_PATH）。
 * @param {object} [options]
 * @param {string} [options.platform] 目标平台（测试注入）。
 * @param {string} [options.env] 环境变量（测试注入）。
 * @param {string} [options.home] 用户主目录（测试注入）。
 * @returns {string[]}
 */
/**
 * 按目标平台拼接路径。不能用 path.join：它使用宿主分隔符，
 * 在 Windows 上构造 macOS 路径会得到反斜杠，导致候选匹配失败。
 * @param {string} platform 目标平台。
 * @param {...string} parts 片段。
 * @returns {string}
 */
function joinFor(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts
    .filter((part) => part !== '')
    .map((part, index) =>
      index === 0
        ? String(part).replace(/[\\/]+$/, '')
        : String(part).replace(/^[\\/]+|[\\/]+$/g, ''),
    )
    .join(sep);
}

export function chromeCandidates({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const list = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);

  if (platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      joinFor(platform, home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else if (platform === 'win32') {
    list.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return list;
}

/**
 * 在 PATH 中查找命令是否存在。
 * @param {string} name 命令名。
 * @returns {string|null} 绝对路径或 null。
 */
function whichCommand(name) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 定位本机可用的浏览器。
 *
 * @param {object} [options]
 * @param {Function} [options.exists] 存在性判定（测试注入）。
 * @param {Function} [options.which] 命令查找（测试注入）。
 * @returns {string|null}
 */
export function findChrome({ exists = fs.existsSync, which = whichCommand, ...rest } = {}) {
  const candidates = chromeCandidates(rest);
  const hit = candidates.find((candidate) => exists(candidate));
  if (hit) return hit;
  // 兜底：PATH 里的 chrome/chromium（Linux 常见、macOS 若做了软链也可用）
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chrome']) {
    const found = which(name);
    if (found && exists(found)) return found;
  }
  return null;
}

/**
 * 应用目录布局解析（源码运行 / 便携包 / 安装包三种形态）。
 *
 * 背景：源码部署时数据目录是 `<项目根>/data`，而安装型部署把它装在
 * `Program Files` 下，该目录对普通用户不可写，数据库会写失败。
 * 便携包则希望数据就落在包内，拷走即迁移。
 *
 * 三种形态用**安装根目录下的布局标记文件**区分，避免靠路径猜：
 *   `.fire-vision-layout.json` = { "mode": "portable" | "installed" }
 *
 * 关键约束：**没有标记文件时行为与改造前完全一致**（`<项目根>/data`），
 * 这样现有源码部署、守护脚本与测试不受影响。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 布局标记文件名（放在安装根目录，与 program/ 同级）。 */
export const LAYOUT_MARKER = '.fire-vision-layout.json';

/**
 * 布局来源的权威结果传递键（D-07）。
 *
 * 背景：boot.mjs 先解析布局并把 DATA_DIR 写进环境变量，index.mjs 随后
 * 二次解析时看到 env.DATA_DIR 已存在，就把来源判成「环境变量 DATA_DIR」——
 * 与 boot 记录的「便携包内置数据目录」自相矛盾，排障时容易找错位置。
 * 由 boot 把首次解析出的来源写入本键，后续解析以它为准。
 */
export const LAYOUT_REASON_ENV = 'FIRE_VISION_LAYOUT_REASON';

/**
 * 读取布局标记。
 *
 * @param {string} installRoot 安装根目录。
 * @param {object} [options]
 * @param {Function} [options.readFile] 注入读取函数（测试用）。
 * @returns {'portable'|'installed'|null} 无法识别时返回 null（按源码形态处理）。
 */
export function readLayoutMode(installRoot, { readFile = fs.readFileSync } = {}) {
  try {
    const raw = readFile(path.join(installRoot, LAYOUT_MARKER), 'utf8');
    const parsed = JSON.parse(String(raw));
    if (parsed?.mode === 'portable' || parsed?.mode === 'installed') return parsed.mode;
    return null;
  } catch {
    return null;
  }
}

/**
 * 各平台的标准数据目录（仅 installed 形态使用）。
 *
 * @param {object} [options]
 * @param {string} [options.platform] 目标平台。
 * @param {object} [options.env] 环境变量。
 * @param {string} [options.home] 用户主目录。
 * @returns {string} 绝对路径。
 */
export function platformDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const base = env.ProgramData || 'C:\\ProgramData';
    return path.win32.join(base, 'FireVision');
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'FireVision');
  }
  // Linux 及其它 POSIX：优先系统级数据目录。
  return '/var/lib/fire-vision';
}

/**
 * 判断目录是否可写（写一个探针文件后删除）。
 *
 * @param {string} dir 目标目录。
 * @param {object} [options]
 * @param {Function} [options.mkdir] 注入建目录函数（测试用）。
 * @param {Function} [options.writeFile] 注入写入函数（测试用）。
 * @param {Function} [options.rm] 注入删除函数（测试用）。
 * @returns {boolean}
 */
export function probeWritable(dir, {
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  rm = fs.rmSync,
} = {}) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdir(dir, { recursive: true });
    writeFile(probe, 'ok');
    rm(probe, { force: true });
    return true;
  } catch {
    try { rm(probe, { force: true }); } catch { /* 忽略 */ }
    return false;
  }
}

/**
 * 解析最终的目录布局与数据目录。
 *
 * 优先级：
 *   1. `--data-dir` 参数（显式覆盖，最高）
 *   2. `DATA_DIR` 环境变量
 *   3. 便携包 → `<安装根>/data`
 *   4. 安装包 → 平台标准目录；不可写时回退 `<安装根>/data`，再不可写则用户目录
 *   5. 源码运行 → `<项目根>/data`（与改造前一致）
 *
 * @param {object} options
 * @param {string} options.projectRoot 程序根目录（`server/` 的父级）。
 * @param {string[]} [options.argv] 命令行参数。
 * @param {object} [options.env] 环境变量。
 * @param {string} [options.platform] 目标平台。
 * @param {string} [options.home] 用户主目录。
 * @param {Function} [options.isWritable] 可写判定（测试注入）。
 * @param {Function} [options.readFile] 读文件（测试注入）。
 * @returns {{mode: 'source'|'portable'|'installed', installRoot: string, programRoot: string, dataDir: string, fallback: boolean, reason: string}}
 */
export function resolveLayout({
  projectRoot,
  argv = process.argv,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  isWritable = probeWritable,
  readFile = fs.readFileSync,
} = {}) {
  const programRoot = path.resolve(projectRoot);
  // 打包布局：<installRoot>/program/server/... → installRoot 是 program 的父级。
  const installRoot = path.dirname(programRoot);
  const mode = readLayoutMode(installRoot, { readFile }) ?? 'source';

  const argValue = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const explicit = argValue('--data-dir') ?? env.DATA_DIR;
  if (explicit) {
    return {
      mode,
      installRoot,
      programRoot,
      dataDir: path.resolve(explicit),
      fallback: false,
      // D-07：boot 已解析过时沿用其结论，避免两条启动日志互相矛盾。
      reason:
        env[LAYOUT_REASON_ENV] ??
        (argValue('--data-dir') ? '命令行 --data-dir' : '环境变量 DATA_DIR'),
    };
  }

  if (mode === 'portable') {
    const bundled = path.join(installRoot, 'data');
    if (isWritable(bundled)) {
      return {
        mode, installRoot, programRoot, dataDir: bundled, fallback: false, reason: '便携包内置数据目录',
      };
    }
    const userFallback = platform === 'win32'
      ? path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'FireVision')
      : path.posix.join(home, '.fire-vision');
    return {
      mode, installRoot, programRoot, dataDir: userFallback, fallback: true, reason: '便携目录不可写，回退用户目录',
    };
  }

  if (mode === 'installed') {
    const standard = platformDataDir({ platform, env, home });
    if (isWritable(standard)) {
      return {
        mode, installRoot, programRoot, dataDir: standard, fallback: false, reason: '安装形态的标准数据目录',
      };
    }
    const beside = path.join(installRoot, 'data');
    if (isWritable(beside)) {
      return {
        mode, installRoot, programRoot, dataDir: beside, fallback: true, reason: '标准目录不可写，回退安装目录旁的 data',
      };
    }
    const userFallback = platform === 'win32'
      ? path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'FireVision')
      : path.posix.join(home, '.fire-vision');
    return {
      mode, installRoot, programRoot, dataDir: userFallback, fallback: true, reason: '标准目录与安装目录均不可写，回退用户目录',
    };
  }

  // 源码形态：保持改造前的行为。
  return {
    mode: 'source',
    installRoot,
    programRoot,
    dataDir: path.join(programRoot, 'data'),
    fallback: false,
    reason: '源码运行默认目录（与改造前一致）',
  };
}

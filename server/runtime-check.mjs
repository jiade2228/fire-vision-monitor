/**
 * 运行时环境前置校验。
 *
 * 依据：本项目使用 Node 内置的 `node:sqlite`（22.5.0 起提供）。此前没有版本
 * 前置判定，运维若用 Node 20 启动，会得到 `Cannot find module 'node:sqlite'`
 * 这类与真实原因无关的报错，排查成本高。
 *
 * 另外两处易被忽略的环境差异也在这里统一暴露：
 *   - 数据目录不可写（Windows 上常因 UAC/目录权限导致，表现为后续写库失败）
 *   - Windows MAX_PATH 260 限制（安装路径过深时录像文件写入会随机失败）
 */

/** 支持的最低 Node 版本（node:sqlite 引入版本）。 */
export const MIN_NODE_VERSION = [22, 5, 0];

/**
 * 解析 Node 版本字符串。
 * @param {string} version 形如 `22.22.2` 或 `v22.22.2`。
 * @returns {number[]} [major, minor, patch]；非法时返回 [0,0,0]。
 */
export function parseNodeVersion(version) {
  const text = String(version ?? '').trim().replace(/^v/i, '');
  // 允许 `22`、`22.5`、`22.5.0` 三种写法：process.versions.node 总是完整三段，
  // 但部署脚本/环境变量可能只给主版本，这里宽松解析避免误判为「未知版本」。
  const matched = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!matched) return [0, 0, 0];
  return [Number(matched[1]), Number(matched[2] ?? 0), Number(matched[3] ?? 0)];
}

/**
 * 判断 Node 版本是否满足最低要求。
 * @param {string} version 版本字符串。
 * @returns {boolean}
 */
export function isNodeSupported(version) {
  const current = parseNodeVersion(version);
  const [needMajor, needMinor, needPatch] = MIN_NODE_VERSION;
  if (current[0] !== needMajor) return current[0] > needMajor;
  if (current[1] !== needMinor) return current[1] > needMinor;
  return current[2] >= needPatch;
}

/**
 * 版本不满足时给出可操作的中文提示。
 * @param {string} version 当前版本。
 * @returns {string}
 */
export function nodeVersionHint(version) {
  return (
    `当前 Node 版本 ${version || '未知'} 过低，本项目依赖内置 node:sqlite，` +
    `需要 >= ${MIN_NODE_VERSION.join('.')}。请升级 Node（推荐 22 LTS）后重试：` +
    'https://nodejs.org/ 。若已安装多版本，可用 nvm use 22 切换。'
  );
}

/**
 * 断言运行时满足要求；不满足时抛出带操作指引的错误。
 *
 * @param {object} [options]
 * @param {string} [options.nodeVersion] 覆盖当前版本（测试用）。
 * @returns {{version: string, parsed: number[]}}
 * @throws {Error} 版本不满足时。
 */
export function assertNodeVersion({ nodeVersion = process.versions.node } = {}) {
  if (!isNodeSupported(nodeVersion)) {
    const error = new Error(nodeVersionHint(nodeVersion));
    error.code = 'NODE_VERSION_UNSUPPORTED';
    throw error;
  }
  return { version: nodeVersion, parsed: parseNodeVersion(nodeVersion) };
}

/**
 * 计算 Windows 长路径风险（仅提示，不阻断）。
 *
 * ffmpeg 自身能处理长路径，但 Node 的 fs 在未加 `\\?\` 前缀时受 MAX_PATH 限制。
 * 录像目录形如 `<dataDir>/continuous/<cameraId>/<yyyymmdd>/<hhmmss>.ts`，
 * 比 dataDir 长约 60 字符，因此 dataDir 超过 180 字符时给出预警。
 *
 * @param {string} absoluteDir 数据目录绝对路径。
 * @returns {{risky: boolean, length: number, limit: number}}
 */
export function checkLongPathRisk(absoluteDir) {
  const length = String(absoluteDir ?? '').length;
  const limit = 180;
  const risky = process.platform === 'win32' && length > limit;
  return { risky, length, limit };
}

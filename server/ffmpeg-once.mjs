/**
 * 一次性 FFmpeg 进程的公共骨架（无状态工具）。
 *
 * 抓拍 / 告警补录 / ROI 预览都遵循同一套生命周期：
 * spawn → settled 收敛 → 超时 SIGKILL → error/exit 收尾。
 * 差异（spawn 实现与可执行文件路径、命令行参数、stdio、超时值、
 * 失败返回值、exit 后基于 existsSync 的结果判定）全部由调用方显式传入，
 * 保证三处改造前后逐字等价。
 */

/**
 * 运行一次 FFmpeg 子进程并以 Promise 返回结果。
 *
 * @param {object} options 配置。
 * @param {typeof import('node:child_process').spawn} options.spawnImpl 进程拉起函数（测试注入用）。
 * @param {string} options.ffmpegPath FFmpeg 可执行文件路径。
 * @param {string[]} options.args FFmpeg 命令行参数。
 * @param {number} options.timeoutMs 超时毫秒数（各调用点保留各自的 5000/25000/8000）。
 * @param {import('node:child_process').StdioOptions} [options.stdio] 子进程 stdio 配置。
 * @param {*} options.failureValue spawn 抛错 / 超时 / error 事件的返回值（null 或 false）。
 * @param {(code: number|null) => *} options.onExit exit 事件（清除定时器后）的结果判定，封装各自 existsSync 语义。
 * @returns {Promise<*>} onExit 的结果或 failureValue。
 */
export function runFfmpegOnce({
  spawnImpl,
  ffmpegPath,
  args,
  timeoutMs,
  stdio = ['ignore', 'ignore', 'ignore'],
  failureValue,
  onExit,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(ffmpegPath, args, { windowsHide: true, stdio });
    } catch {
      resolve(failureValue);
      return;
    }
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
      finish(failureValue);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      finish(failureValue);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(onExit(code));
    });
  });
}

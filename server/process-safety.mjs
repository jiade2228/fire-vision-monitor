/**
 * 进程级异常兜底。
 *
 * 背景：Node 22 遇到**未捕获的 Promise rejection 会直接终止进程**（退出码 1）。
 * 本项目有多处以 `void someAsync()` 形式启动的异步任务（录像采集重启、
 * 回放会话回收、边缘网关消息处理、媒体水位清理等），其中任意一处 reject
 * 都会让整个火情监控平台当场停止工作 —— 而且没有任何告警：
 * 崩溃原因只在容器 stdout 里，编排系统的 restart 策略还会把它反复拉起，
 * 形成 crash-restart 循环，而每次重启都短暂「健康」，HEALTHCHECK 也发现不了。
 *
 * 策略：
 * - `unhandledRejection`：记结构化日志 + 计数，**不退出**。绝大多数单点故障
 *   （某次抓拍失败、某条记录写入冲突）不该让整站停摆；把「静默死亡」变成
 *   「可观测的失败」即可。
 * - `uncaughtException`：记日志 + 触发致命回调（走优雅停机后退出）。
 *   此时进程状态已不可信，继续运行风险更高。
 */

/**
 * @typedef {object} ProcessGuardState
 * @property {number} unhandledRejections 未捕获 rejection 累计次数。
 * @property {number} uncaughtExceptions 未捕获异常累计次数。
 * @property {{message: string, stack: string|undefined, at: number}|null} lastUnhandled 最近一次未捕获 rejection。
 * @property {{message: string, stack: string|undefined, at: number}|null} lastUncaught 最近一次未捕获异常。
 */

/**
 * 安装进程级异常处理器。
 *
 * @param {object} options
 * @param {(level: string, event: string, fields?: object) => void} options.log 结构化日志函数。
 * @param {(state: ProcessGuardState) => void} [options.onCount] 计数变化回调（用于把计数暴露到监控接口）。
 * @param {(error: Error) => void} [options.onFatal] uncaughtException 时的致命回调（通常走优雅停机）。
 * @returns {{state: ProcessGuardState, uninstall: () => void}} 状态快照与卸载函数。
 */
export function installProcessGuards({ log, onCount, onFatal } = {}) {
  /** @type {ProcessGuardState} */
  const state = {
    unhandledRejections: 0,
    uncaughtExceptions: 0,
    lastUnhandled: null,
    lastUncaught: null,
  };

  const notifyCount = () => {
    try {
      onCount?.(state);
    } catch {
      // 计数回调失败不能影响异常处理本身。
    }
  };

  const handleUnhandled = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    state.unhandledRejections += 1;
    state.lastUnhandled = { message: error.message, stack: error.stack, at: Date.now() };
    log?.('error', 'unhandled_rejection', {
      message: error.message,
      stack: error.stack,
      total: state.unhandledRejections,
    });
    notifyCount();
  };

  const handleUncaught = (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    state.uncaughtExceptions += 1;
    state.lastUncaught = { message: err.message, stack: err.stack, at: Date.now() };
    log?.('error', 'uncaught_exception', {
      message: err.message,
      stack: err.stack,
      total: state.uncaughtExceptions,
    });
    notifyCount();
    try {
      onFatal?.(err);
    } catch {
      // 致命回调自身失败也不能让进程无日志地退出。
    }
  };

  process.on('unhandledRejection', handleUnhandled);
  process.on('uncaughtException', handleUncaught);

  return {
    state,
    uninstall() {
      process.off('unhandledRejection', handleUnhandled);
      process.off('uncaughtException', handleUncaught);
    },
  };
}

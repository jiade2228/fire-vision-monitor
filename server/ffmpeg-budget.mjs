/**
 * 全局 FFmpeg 进程预算：限制同一时刻运行的 FFmpeg 子进程数量。
 *
 * 背景：
 * 检测引擎、持续录像、共享源、HLS 转码各自 spawn FFmpeg，
 * 四个模块之间没有任何全局约束。点位一多（几十上百路），
 * 就会同时拉起同等数量的 FFmpeg，CPU / 内存 / 文件句柄被瞬间打满，
 * 表现为：服务端无响应、告警写入失败、机器需要重启。
 *
 * 语义：
 * - 预算充足 → 立即放行；
 * - 预算不足 → **排队等待**（FIFO），而不是直接拒绝；
 * - 等待超时 → 拒绝并抛出可读错误，由调用方决定是退避重试还是标记不可用。
 *
 * 该模块只做「计数 + 排队」，不关心 FFmpeg 的参数与生命周期；
 * 释放责任在调用方（进程退出/停止时必须 release，release 幂等）。
 */

/** 默认并发上限。FFmpeg 单进程解码 1080p 约需 1 个核，留出余量后默认 8。 */
export const DEFAULT_FFMPEG_PROCESS_LIMIT = 8;

/** 默认排队等待上限（毫秒）。超时后调用方会退避重试，不会永久卡死。 */
export const DEFAULT_FFMPEG_WAIT_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} FfmpegBudgetToken
 * @property {boolean} released 是否已释放（保证 release 幂等）。
 * @property {string} label 用途标签，仅用于日志与可观测性。
 */

/**
 * FFmpeg 并发预算（信号量 + FIFO 队列）。
 */
export class FfmpegBudget {
  /**
   * @param {{limit?: number, waitTimeoutMs?: number, onWait?: (info: {waiting: number, limit: number}) => void}} [options]
   */
  constructor({
    limit = DEFAULT_FFMPEG_PROCESS_LIMIT,
    waitTimeoutMs = DEFAULT_FFMPEG_WAIT_TIMEOUT_MS,
    onWait = null,
  } = {}) {
    // 显式传入的数字按有效区间夹取；未传（undefined/NaN）才回落默认值。
    // 注意：环境变量在单例处用 `|| DEFAULT` 兜底，所以 FFMPEG_MAX_PROCESSES=0
    // 表示「未配置」而非「禁用 FFmpeg」。
    const rawLimit = Number(limit);
    this.limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_FFMPEG_PROCESS_LIMIT, 1),
      64,
    );
    const rawWait = Number(waitTimeoutMs);
    this.waitTimeoutMs = Math.min(
      Math.max(
        Number.isFinite(rawWait) ? rawWait : DEFAULT_FFMPEG_WAIT_TIMEOUT_MS,
        1_000,
      ),
      600_000,
    );
    this.onWait = onWait;
    /** @type {FfmpegBudgetToken[]} */
    this.active = [];
    /** @type {{resolve: (token: FfmpegBudgetToken) => void, reject: (error: Error) => void, timer: NodeJS.Timeout|null, label: string}[]} */
    this.waiters = [];
    this.peakActive = 0;
    this.totalAcquired = 0;
    this.totalRejected = 0;
  }

  /**
   * 当前正在运行的 FFmpeg 进程数。
   * @returns {number}
   */
  get activeCount() {
    return this.active.length;
  }

  /**
   * 当前排队等待的数量。
   * @returns {number}
   */
  get waitingCount() {
    return this.waiters.length;
  }

  /**
   * 获取一个执行名额。预算不足时排队等待，超过等待上限则拒绝。
   *
   * @param {{label?: string}} [options]
   * @returns {Promise<FfmpegBudgetToken>}
   * @throws {Error} 等待超时。
   */
  acquire({ label = '' } = {}) {
    if (this.active.length < this.limit) {
      return Promise.resolve(this.#grant(label));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, label };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.totalRejected += 1;
        reject(
          new Error(
            `FFmpeg 进程预算已满（上限 ${this.limit}，等待 ${this.waitTimeoutMs} ms 仍未轮到）`,
          ),
        );
      }, this.waitTimeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      this.onWait?.({ waiting: this.waiters.length, limit: this.limit });
    });
  }

  /**
   * 同步尝试获取名额，不排队。
   *
   * 用于「预算充足时必须保持同步语义」的场景：
   * 常驻检测进程在构造函数里同步拉起 FFmpeg，若改成异步会在启动瞬间
   * 产生一个空窗（此期间没有子进程，也没有帧）。
   *
   * @param {{label?: string}} [options]
   * @returns {FfmpegBudgetToken|null} 拿不到名额时返回 null（需改走 acquire 排队）。
   */
  tryAcquire({ label = '' } = {}) {
    if (this.active.length >= this.limit) return null;
    return this.#grant(label);
  }

  /**
   * 释放名额。重复释放不会重复计数（幂等）。
   *
   * @param {FfmpegBudgetToken|null|undefined} token
   * @returns {void}
   */
  release(token) {
    if (!token || token.released) return;
    token.released = true;
    const index = this.active.indexOf(token);
    if (index >= 0) this.active.splice(index, 1);
    this.#pump();
  }

  /**
   * 以「临时占用名额」的方式执行一段逻辑，结束后自动释放。
   *
   * @template T
   * @param {{label?: string}} options
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withSlot({ label = '' } = {}, fn) {
    const token = await this.acquire({ label });
    try {
      return await fn();
    } finally {
      this.release(token);
    }
  }

  /**
   * 运行期调整上限（例如运维在看板上下调）。
   * 上调后立即唤醒排队者。
   * @param {number} limit
   * @returns {number} 生效后的上限。
   */
  setLimit(limit) {
    const next = Math.min(Math.max(Number(limit) || this.limit, 1), 64);
    this.limit = next;
    this.#pump();
    return next;
  }

  /**
   * 可观测快照（供 /api/metrics 暴露）。
   * @returns {{limit: number, active: number, waiting: number, peakActive: number, totalAcquired: number, totalRejected: number, waitTimeoutMs: number}}
   */
  stats() {
    return {
      limit: this.limit,
      active: this.active.length,
      waiting: this.waiters.length,
      peakActive: this.peakActive,
      totalAcquired: this.totalAcquired,
      totalRejected: this.totalRejected,
      waitTimeoutMs: this.waitTimeoutMs,
    };
  }

  /**
   * 发放名额。
   * @param {string} label
   * @returns {FfmpegBudgetToken}
   */
  #grant(label) {
    /** @type {FfmpegBudgetToken} */
    const token = { released: false, label };
    this.active.push(token);
    this.totalAcquired += 1;
    if (this.active.length > this.peakActive) this.peakActive = this.active.length;
    return token;
  }

  /**
   * 有空位时按 FIFO 唤醒排队者。
   * @returns {void}
   */
  #pump() {
    while (this.active.length < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
      }
      waiter.resolve(this.#grant(waiter.label));
    }
  }
}

/**
 * 进程级默认预算实例。
 *
 * 上限来自环境变量 FFMPEG_MAX_PROCESSES（1-64，默认 8），
 * 排队等待上限来自 FFMPEG_WAIT_TIMEOUT_MS（默认 30 秒）。
 */
export const ffmpegBudget = new FfmpegBudget({
  limit: Number(process.env.FFMPEG_MAX_PROCESSES) || DEFAULT_FFMPEG_PROCESS_LIMIT,
  waitTimeoutMs:
    Number(process.env.FFMPEG_WAIT_TIMEOUT_MS) || DEFAULT_FFMPEG_WAIT_TIMEOUT_MS,
});

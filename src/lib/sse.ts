/**
 * 带指数退避的 SSE 客户端。
 *
 * 为什么不用浏览器原生 EventSource 的自动重连：
 * 1. 原生重连间隔固定（服务端 `retry: 3000`），服务端不可用时会形成
 *    「每 3 秒重连一次」的风暴，服务端刚恢复就被打满；
 * 2. 原生实现每次 error 都会触发 error 事件，而本项目原先在 error 里
 *    直接全量刷新告警列表 —— 服务端故障期间等于每 3 秒刷一次 /api/alarms；
 * 3. 服务端重启（event: server.shutdown）后需要立刻重连，而不是等退避计时。
 *
 * 这里改为自行管理连接：断开后按指数退避重连（1s→2s→4s…上限 30s，带抖动），
 * 连接成功后重置退避。抖动用于避免多客户端同时重连造成惊群。
 */

export interface SseDisconnectInfo {
  /** 连续失败次数（成功连接后归零）。 */
  attempt: number;
  /** 本次重连的等待毫秒数。 */
  delayMs: number;
}

export interface SseClientOptions {
  /** SSE 端点地址。 */
  url: string;
  /** 需要订阅的事件名（自定义事件名需显式列出）。 */
  events: string[];
  /** 收到事件时回调。 */
  onEvent: (type: string, data: string) => void;
  /** 连接建立（含重连成功）时回调。 */
  onOpen?: () => void;
  /** 连接断开、进入退避等待时回调。 */
  onDisconnect?: (info: SseDisconnectInfo) => void;
  /** 首次最小退避毫秒数，默认 1000。 */
  minDelayMs?: number;
  /** 最大退避毫秒数，默认 30000。 */
  maxDelayMs?: number;
  /** 创建 EventSource 的工厂（测试注入用）。 */
  createSource?: (url: string) => EventSource;
  /** 服务端主动告别事件名，默认 'server.shutdown'。 */
  goodbyeEvent?: string;
}

export interface SseClient {
  /** 关闭连接并停止重连。 */
  close: () => void;
  /** 当前是否已连接。 */
  readonly connected: boolean;
  /** 当前连续失败次数。 */
  readonly attempt: number;
}

/**
 * 计算第 attempt 次失败后的退避时长（带 ±20% 抖动）。
 *
 * @param attempt 连续失败次数（从 1 开始）。
 * @param minDelayMs 最小退避。
 * @param maxDelayMs 最大退避。
 * @returns {number} 等待毫秒数。
 */
export function backoffDelay(
  attempt: number,
  minDelayMs = 1_000,
  maxDelayMs = 30_000,
): number {
  const safeAttempt = Math.max(Number(attempt) || 1, 1);
  const exponential = Math.min(minDelayMs * 2 ** (safeAttempt - 1), maxDelayMs);
  // 抖动：±20%，避免多个浏览器标签页/多台客户端在同一时刻重连。
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.max(Math.round(exponential * jitter), 0);
}

/**
 * 建立一个带指数退避的 SSE 连接。
 *
 * @param options 连接参数。
 * @returns {SseClient} 客户端句柄。
 */
export function connectSse(options: SseClientOptions): SseClient {
  const {
    url,
    events,
    onEvent,
    onOpen,
    onDisconnect,
    minDelayMs = 1_000,
    maxDelayMs = 30_000,
    createSource = (target: string) => new EventSource(target),
    goodbyeEvent = 'server.shutdown',
  } = options;

  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let connected = false;
  let attempt = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (!closed) open();
    }, delayMs);
  };

  const handleEvent = (type: string) => (event: Event) => {
    const message = event as MessageEvent;
    const data = typeof message.data === 'string' ? message.data : '';
    // 服务端重启前会先发告别事件：立即重连，不等退避计时。
    if (type === goodbyeEvent) {
      connected = false;
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
      attempt = 0;
      scheduleReconnect(Math.min(minDelayMs, 500));
      return;
    }
    onEvent(type, data);
  };

  const open = () => {
    if (closed) return;
    try {
      source = createSource(url);
    } catch {
      attempt += 1;
      const delayMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
      onDisconnect?.({ attempt, delayMs });
      scheduleReconnect(delayMs);
      return;
    }
    source.onopen = () => {
      connected = true;
      attempt = 0;
      onOpen?.();
    };
    source.onerror = () => {
      connected = false;
      // 关闭原生连接，改为自行退避重连（原生重连是固定间隔）。
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
      attempt += 1;
      const delayMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
      onDisconnect?.({ attempt, delayMs });
      scheduleReconnect(delayMs);
    };
    for (const name of events) {
      source.addEventListener(name, handleEvent(name) as EventListener);
    }
  };

  open();

  return {
    close() {
      closed = true;
      connected = false;
      clearTimer();
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
    },
    get connected() {
      return connected;
    },
    get attempt() {
      return attempt;
    },
  };
}

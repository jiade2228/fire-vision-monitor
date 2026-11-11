/**
 * 环境变量解析（单一来源）。
 *
 * 改造前全仓有 5 种写法：`Number(x) || default`、`Number(x) > 0 ? ...`、
 * `Number(x) ?? default`、`Math.min(Math.max(...))`、裸 `Number(x)`。
 * 由此产生了三类真实故障：
 *
 *   1. **`0` 被吞**：`MEDIA_MAX_BYTES=0`（文档承诺「0 关闭」）→ 回退 2GB；
 *      `NOTIFY_MAX_FAILURES=0`（文档承诺「0 不停用」）→ 回退 5。
 *   2. **负数/NaN 静默生效**：`ALARM_RETENTION_DAYS=-5` → 保留策略把
 *      cutoff 算到未来 5 天 → 删光全库告警；`OFFLINE_TIMEOUT_MS=-1` →
 *      每个点位立即误报离线；`RECORDING_MAX_BYTES=abc` → 配额判定恒假。
 *   3. **同一变量多处解析口径不同**：`MAX_CONCURRENT_STREAMS=abc` 时
 *      StreamManager 得到 NaN（并发上限失效），PlaybackSessionManager 得到 8。
 *
 * 本模块把「取值 → 有限数校验 → 0 值语义 → 范围钳制」收敛到一处。
 * 设计原则：
 *   - **非法值一律回退默认值并记 warn**，绝不静默生效。
 *   - **0 是否合法由调用方显式声明**（allowZero），不再依赖 `||` 的偶然行为。
 *   - 范围钳制用 Math.round 归整，避免小数进入「毫秒/条数」语义。
 */

/**
 * 解析数值型环境变量。
 *
 * @param {string} name 环境变量名。
 * @param {object} options 配置。
 * @param {number} options.defaultValue 未设置或非法时的默认值。
 * @param {number} [options.min] 下界（含），默认 -Infinity。
 * @param {number} [options.max] 上界（含），默认 Infinity。
 * @param {boolean} [options.allowZero=false] 是否把 0 当作合法值（用于「0 = 关闭」语义）。
 * @param {boolean} [options.integer=false] 是否强制归整为整数。默认**保留小数** ——
 *   部分配置项（如 ESCALATION_MINUTES=0.01）依赖小数语义做快速验证，
 *   无条件 Math.round 会把它们抹成 0 而静默关闭功能。
 * @param {(message: string) => void} [options.onWarn] 非法值时的告警回调。
 * @returns {number} 解析后的数值。
 */
export function envNumber(name, options) {
  const {
    defaultValue,
    min = -Infinity,
    max = Infinity,
    allowZero = false,
    integer = false,
    onWarn = null,
  } = options;
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return defaultValue;
  const parsed = Number(raw);
  const warn = (reason) => {
    if (onWarn) onWarn(`配置项 ${name}=${JSON.stringify(raw)} ${reason}，已回退默认值 ${defaultValue}`);
  };
  if (!Number.isFinite(parsed)) {
    warn('不是有效数字');
    return defaultValue;
  }
  if (parsed === 0) {
    return allowZero ? 0 : defaultValue;
  }
  const normalized = integer ? Math.round(parsed) : parsed;
  const clamped = Math.min(Math.max(normalized, min), max);
  if (clamped !== normalized) {
    if (onWarn) {
      onWarn(`配置项 ${name}=${raw} 超出范围 [${min}, ${max}]，已钳制为 ${clamped}`);
    }
  }
  return clamped;
}

/**
 * 解析布尔型环境变量。
 *
 * 统一「1 / true / yes / on」为真，「0 / false / no / off」为假，空为默认值。
 * 改造前混用 `=== '1'` 与 `!== '0'`，运维按习惯写 `SERVER_DETECTION=false`
 * 仍会开启检测。
 *
 * @param {string} name 环境变量名。
 * @param {boolean} defaultValue 未设置或非法时的默认值。
 * @param {(message: string) => void} [options.onWarn] 非法值告警回调。
 * @returns {boolean}
 */
export function envBoolean(name, defaultValue, { onWarn = null } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return defaultValue;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (onWarn) {
    onWarn(`配置项 ${name}=${JSON.stringify(raw)} 不是有效布尔值，已回退默认值 ${defaultValue}`);
  }
  return defaultValue;
}

/**
 * 解析 TCP 端口。
 *
 * @param {number} value 原始值。
 * @param {number} [fallback=4173] 非法时的回退值。
 * @returns {{port: number, error: string|null}}
 */
export function normalizePort(value, fallback = 4173) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: fallback, error: `端口值 ${JSON.stringify(value)} 非法（需为 1-65535 的整数）` };
  }
  return { port, error: null };
}

/**
 * 解析 `HH:MM` 形式的时刻。
 *
 * 改造前只做 `normalizeText(value, 5)` 截断：`'25:99'` 会让每日摘要永不触发，
 * `'08:00:30'` 被静默截成 `'08:00'`。
 *
 * @param {string} value 原始值。
 * @param {string} [fallback='08:00'] 非法时的默认值。
 * @param {(message: string) => void} [options.onWarn] 告警回调。
 * @returns {{value: string, hour: number, minute: number}}
 */
export function normalizeClock(value, fallback = '08:00', { onWarn = null } = {}) {
  const raw = String(value ?? '').trim();
  const matched = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!matched) {
    if (raw && onWarn) onWarn(`时刻 ${JSON.stringify(raw)} 格式无效（需 HH:MM），已回退 ${fallback}`);
    return splitClock(fallback);
  }
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) {
    if (onWarn) onWarn(`时刻 ${JSON.stringify(raw)} 超出范围，已回退 ${fallback}`);
    return splitClock(fallback);
  }
  return { value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour, minute };
}

function splitClock(text) {
  const [hour, minute] = text.split(':').map(Number);
  return { value: text, hour, minute };
}

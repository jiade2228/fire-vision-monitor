/**
 * 出网地址校验（SSRF 缓解的统一实现）。
 *
 * 背景：平台会以「服务端主动发起请求」的方式访问三类外部地址——
 *   1. 相机视频源（/proxy 代理、ffprobe/ffmpeg 测流与抓图）；
 *   2. ONVIF 设备发现（单播 SOAP 探测）；
 *   3. 通知渠道 Webhook（告警推送）。
 * 三者的目标主机都来自配置（可由站点管理员写入），若不校验就等价于
 * 「把服务器变成任意内网探测器」。本模块把判定逻辑收敛到一处，
 * 供 index.mjs / routes/media.mjs / routes/cameras.mjs 复用。
 *
 * 策略分三层：
 * - **恒定拦截**（任何部署形态都无正当用途）：
 *   未指定地址 0.0.0.0/8 与 ::，以及云元数据地址（169.254.169.254、
 *   169.254.170.2、fd00:ec2::254、fe80::a9fe:a9fe）。
 * - **链路本地 169.254/16、fe80::/10**：默认对通知渠道恒定拦截（Webhook 不会
 *   部署在链路本地），对相机源与 ONVIF 发现默认放行（摄像头自组网时确实会用
 *   169.254.x.x 自分配地址），可由 allowLinkLocal 显式切换。
 * - **按部署形态收紧**（默认放行，环回与私网是摄像头/内网 Webhook 的常态）：
 *   allowPrivate=false 时额外拦截 10/8、172.16/12、192.168/16、100.64/10、
 *   198.18/15、fc00::/7、.local；allowLoopback=false 时额外拦截 127/8、::1。
 *
 * 已知局限：域名形式的地址可能经 DNS 解析到内网（DNS rebinding）。
 * 本模块做的是「配置期静态校验 + 每跳重定向校验」，不做 DNS 解析后校验；
 * 若部署在公网且需要更强防护，应在网络层（出口 ACL）限制回源地址。
 */

/**
 * 云元数据地址（IPv4）：AWS/阿里云/腾讯云/GCP 统一使用 169.254.169.254，
 * ECS 任务元数据使用 169.254.170.2。
 */
const METADATA_IPV4 = new Set(['169.254.169.254', '169.254.170.2']);

/**
 * 去掉 IPv6 字面量的方括号并转小写。
 * @param {string} hostname 主机名。
 * @returns {string} 规范化后的主机名。
 */
function normalizeHost(hostname) {
  return String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
}

/**
 * 解析 IPv4 字面量为四段十进制。
 * @param {string} hostname 主机名。
 * @returns {number[]|null} [a,b,c,d]；非法时 null。
 */
/**
 * 解析单段 IPv4 数值：支持十进制、0x 十六进制与前导 0 八进制。
 * WHATWG URL 会把 `2852039166`、`0xa9fea9fe`、`0177.0.0.1` 等编码
 * 规范化成真实 IP；若只认点分十进制，这些编码就能绕过拦截。
 *
 * @param {string} part 单段字符串。
 * @returns {number} 解析值；非法时 NaN。
 */
function parseIpv4Part(part) {
  const text = String(part ?? '');
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text.slice(2), 16);
  if (/^0[0-7]+$/.test(text)) return parseInt(text.slice(1), 8);
  if (/^\d+$/.test(text)) return Number(text);
  return Number.NaN;
}

/**
 * 解析 IPv4 字面量（含 WHATWG URL 支持的整数/十六进制/八进制编码）。
 *
 * @param {string} hostname 主机名。
 * @returns {number[]|null} [a,b,c,d]；非法时 null。
 */
export function parseIpv4(hostname) {
  const host = normalizeHost(hostname);
  // 单段 32 位整数形式：2852039166 / 0xa9fea9fe / 0377...（八进制）
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(host)) {
    const value = parseIpv4Part(host);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  }
  // 点分形式：允许每段独立使用上述编码（如 0177.0.0.1 / 0xa9fe.a9fe）。
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values = parts.map(parseIpv4Part);
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  // 少于四段时按 WHATWG URL 规则合并（127.1 → 127.0.0.1，127.0.1 → 127.0.0.1）。
  if (values.length === 4) return values;
  if (values.length === 3) return [values[0], values[1], values[2] >> 8, values[2] & 0xff];
  if (values.length === 2) {
    return [values[0], (values[1] >>> 16) & 0xff, (values[1] >>> 8) & 0xff, values[1] & 0xff];
  }
  return [0, 0, 0, values[0]];
}

/**
 * 从 IPv4-mapped IPv6 里取出 IPv4 部分。
 *
 * 必须同时支持两种写法：
 *   - 点分十进制：`::ffff:169.254.169.254`（手工输入、直接传字符串时）
 *   - 十六进制：  `::ffff:a9fe:a9fe`（**WHATWG URL 会把点分形式规范化成这个**）
 *
 * 只支持前者会留下真实的 SSRF 绕过：`new URL('http://[::ffff:169.254.169.254]/')`
 * 的 hostname 是 `[::ffff:a9fe:a9fe]`，若解析不出 IPv4，就既不命中元数据黑名单，
 * 也不被当作链路本地，最终被直接放行 —— 云服务器上等同于开放元数据接口。
 *
 * 解析出的 IPv4 会走后续全部判定（元数据 / 链路本地 / 环回 / 私网），
 * 而不只是元数据黑名单。
 *
 * @param {string} host 规范化主机名（已去方括号、小写）。
 * @returns {number[]|null} IPv4 四段；非该形式时 null。
 */
function mappedIpv4(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return parseIpv4(dotted[1]);
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/** @param {number[]} parts IPv4 四段。 @returns {boolean} 是否 127/8 环回。 */
function isLoopbackIpv4(parts) {
  return parts[0] === 127;
}

/** @param {number[]} parts IPv4 四段。 @returns {boolean} 是否链路本地（169.254/16）。 */
function isLinkLocalIpv4(parts) {
  return parts[0] === 169 && parts[1] === 254;
}

/** @param {number[]} parts IPv4 四段。 @returns {boolean} 是否 0.0.0.0/8 未指定。 */
function isUnspecifiedIpv4(parts) {
  return parts[0] === 0;
}

/**
 * 私网 / 运营商级 NAT / 基准测试网段判定。
 * @param {number[]} parts IPv4 四段。
 * @returns {boolean} 是否属于不应公网访问的内网段。
 */
function isPrivateIpv4(parts) {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * IPv6 字面量粗判（仅覆盖需要拦截的网段，不做完整地址解析）。
 * @param {string} host 规范化主机名。
 * @returns {boolean} 是否为 IPv6 字面量。
 */
function isIpv6Literal(host) {
  return host.includes(':');
}

/**
 * fe80::/10 链路本地（含云元数据 fe80::a9fe:a9fe）。
 * @param {string} host 规范化主机名。
 * @returns {boolean} 是否链路本地。
 */
function isLinkLocalIpv6(host) {
  return /^fe[89ab]/.test(host);
}

/**
 * fc00::/7 唯一本地地址。
 * @param {string} host 规范化主机名。
 * @returns {boolean} 是否唯一本地地址。
 */
function isUniqueLocalIpv6(host) {
  return /^f[cd]/.test(host);
}

/**
 * 环回地址判定（::1 / ::0.0.0.1 形式）。
 * @param {string} host 规范化主机名。
 * @returns {boolean} 是否环回。
 */
function isLoopbackIpv6(host) {
  return host === '::1' || host === '::0:0:0:0:0:0:0:1';
}

/**
 * 出网主机白名单校验。
 *
 * @param {string} hostname 目标主机名（可含 IPv6 方括号）。
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=true] 是否允许私网段（摄像头/内网 Webhook 的常态）。
 * @param {boolean} [options.allowLoopback=true] 是否允许环回地址。
 * @param {boolean} [options.allowLinkLocal=false] 是否允许链路本地地址（169.254/16、fe80::/10）。
 * @returns {string|null} 拒绝原因；null 表示放行。
 */
export function blockedOutboundHost(hostname, options = {}) {
  const { allowPrivate = true, allowLoopback = true, allowLinkLocal = false } = options;
  const host = normalizeHost(hostname);
  if (!host) return '主机名不能为空';

  // 未指定地址：任何部署形态都没有正当用途。
  if (host === '0.0.0.0' || host === '::' || host === '::0') {
    return '不允许指向未指定地址';
  }
  // 云元数据地址：恒定拦截，与 allowLinkLocal 无关。
  if (METADATA_IPV4.has(host)) {
    return '不允许指向云元数据地址';
  }
  if (host === 'fd00:ec2::254' || host === 'fe80::a9fe:a9fe') {
    return '不允许指向云元数据地址';
  }

  const mapped = mappedIpv4(host);
  // 云元数据判定必须在链路本地判定**之前**：169.254.169.254 属于 169.254/16，
  // allowLinkLocal=true（相机源策略）下会被当成普通链路本地地址放行。
  // 这里统一对**解析后**的 IPv4 判定 —— 原始字符串可能是整数/0x/八进制编码，
  // 直接字符串比较会漏掉这些形式（2852039166 === 169.254.169.254）。
  const ipv4 = mapped ?? parseIpv4(host);
  if (ipv4 && METADATA_IPV4.has(ipv4.join('.'))) {
    return '不允许指向云元数据地址';
  }
  if (ipv4) {
    if (isLinkLocalIpv4(ipv4)) {
      return allowLinkLocal ? null : '不允许指向链路本地地址';
    }
    if (isUnspecifiedIpv4(ipv4)) return '不允许指向未指定地址';
    if (isLoopbackIpv4(ipv4)) {
      return allowLoopback ? null : '不允许指向环回地址';
    }
    if (isPrivateIpv4(ipv4)) {
      return allowPrivate ? null : '不允许指向私网地址';
    }
    return null;
  }

  if (isIpv6Literal(host)) {
    if (isLinkLocalIpv6(host)) {
      return allowLinkLocal ? null : '不允许指向链路本地地址';
    }
    if (isLoopbackIpv6(host)) {
      return allowLoopback ? null : '不允许指向环回地址';
    }
    if (isUniqueLocalIpv6(host)) {
      return allowPrivate ? null : '不允许指向私网地址';
    }
    return null;
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return allowLoopback ? null : '不允许指向本机';
  }
  if (host.endsWith('.local')) {
    return allowPrivate ? null : '不允许指向 .local 域名';
  }
  return null;
}

/**
 * 出网 URL 校验：协议 + 主机双重判定。
 *
 * @param {string|URL} target 目标 URL。
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=true] 是否允许私网段。
 * @param {boolean} [options.allowLoopback=true] 是否允许环回地址。
 * @param {boolean} [options.allowLinkLocal=false] 是否允许链路本地地址。
 * @param {string[]} [options.protocols] 允许的协议白名单，默认 http/https。
 * @returns {{error: string}|{url: URL}} 校验失败返回 error，否则返回解析后的 URL。
 */
export function assertOutboundUrl(target, options = {}) {
  const {
    allowPrivate = true,
    allowLoopback = true,
    allowLinkLocal = false,
    protocols = ['http:', 'https:'],
  } = options;
  let url;
  try {
    url = target instanceof URL ? target : new URL(String(target));
  } catch {
    return { error: '地址格式无效' };
  }
  if (!protocols.includes(url.protocol)) {
    return { error: `不支持的协议 ${url.protocol.replace(':', '')}` };
  }
  const blocked = blockedOutboundHost(url.hostname, {
    allowPrivate,
    allowLoopback,
    allowLinkLocal,
  });
  if (blocked) return { error: blocked };
  return { url };
}

/**
 * 出网被拒绝时抛出的错误（带 code 便于调用方区分处理）。
 */
export class OutboundBlockedError extends Error {
  /**
   * @param {string} message 拒绝原因。
   */
  constructor(message) {
    super(message);
    this.name = 'OutboundBlockedError';
    this.code = 'OUTBOUND_BLOCKED';
  }
}

/**
 * 受控 fetch：手动跟随重定向，并对**每一跳**重新执行出网地址校验。
 *
 * 直接用 fetch(..., { redirect: 'follow' }) 会让上游 302 把请求带到
 * 未校验的内网地址，等于绕过首跳校验。这里用 redirect:'manual' 逐跳处理，
 * 既保留跨 CDN 跳转的可用性，又不会放过跳向云元数据的重定向。
 *
 * @param {string|URL} target 起始 URL。
 * @param {RequestInit} [init] fetch 选项（redirect 会被强制为 manual）。
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=true] 是否允许私网段。
 * @param {boolean} [options.allowLoopback=true] 是否允许环回地址。
 * @param {boolean} [options.allowLinkLocal=false] 是否允许链路本地地址。
 * @param {number} [options.maxRedirects=3] 最大重定向跳数。
 * @returns {Promise<Response>} 终点响应（重定向时返回最后一跳的响应）。
 * @throws {OutboundBlockedError} 目标地址或某一跳重定向被拒绝。
 */
export async function guardedFetch(target, init = {}, options = {}) {
  const {
    allowPrivate = true,
    allowLoopback = true,
    allowLinkLocal = false,
    maxRedirects = 3,
  } = options;
  let current = typeof target === 'string' ? target : target.href;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = assertOutboundUrl(current, {
      allowPrivate,
      allowLoopback,
      allowLinkLocal,
    });
    if (checked.error) throw new OutboundBlockedError(checked.error);
    const response = await fetch(current, { ...init, redirect: 'manual' });
    const status = response.status;
    if (![301, 302, 303, 307, 308].includes(status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop === maxRedirects) {
      throw new OutboundBlockedError('重定向次数过多');
    }
    let next;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new OutboundBlockedError('重定向地址无效');
    }
    // 丢弃 3xx 响应体，避免连接占用。
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    current = next;
  }
  throw new OutboundBlockedError('重定向次数过多');
}

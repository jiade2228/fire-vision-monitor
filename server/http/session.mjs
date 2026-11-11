import crypto from 'node:crypto';

/**
 * 会话（Session）与登录限流逻辑。
 *
 * 采用工厂模式：index.mjs 在启动时把 store、会话密钥、Cookie 配置、
 * metrics 与 parseCookies 注入，返回一组闭包。这样会话相关逻辑独立成文件，
 * 缩小 index.mjs 体积，同时 index.mjs 原有调用点（currentUser /
 * setSessionCookie / clearSessionCookie / checkLoginBlocked / recordLoginFailure）
 * 通过解构保持不变。
 *
 * ── 重构说明（本轮）────────────────────────────────────────────────
 *
 * 改造前的问题：
 *   1. **登出杀掉全部标签页**。`POST /api/auth/logout` 调用
 *      `bumpTokenVersion(user.id)`，而 tokenVersion 写在 users 表上，
 *      是**账号级**的。于是用户在一个标签页登出，该账号在所有设备、
 *      所有标签页的已签发令牌会同时失效。这不是"登出"，是"全端下线"。
 *      用户在监控大屏上误点登出，会导致值守的其它屏幕一起掉线。
 *   2. **令牌无服务端记录**，无法「列出我的登录设备」「踢掉某台设备」，
 *      也无法在泄露后精确撤销单个令牌。
 *   3. **令牌不绑定会话实例**，同一账号的令牌无法区分。
 *
 * 现在的策略（分层）：
 *   - **会话级撤销**（新增）：每个会话有唯一 `sid`，服务端记录活跃会话。
 *     登出只撤销当前会话的 sid，其它标签页/设备不受影响。
 *   - **账号级失效**（保留）：users.token_version 语义不变 ——
 *     改密码、停用账号、显式「全端下线」时递增它，令该账号全部令牌失效。
 *     这是比会话级更强的能力，两者是「或」关系。
 *   - 令牌载荷新增 `sid` 字段；**旧令牌（无 sid）仍然可用**，
 *     保证升级后不强制所有人重新登录。
 *
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {{
 *   id: string,
 *   tokenVersion?: number,
 *   disabled?: boolean,
 * }} SessionUser
 */

/**
 * @typedef {object} SessionConfig
 * @property {object} store 数据库访问层，需提供 getUser(id)；可选提供
 *   registerSession / revokeSession / revokeUserSessions / listUserSessions
 * @property {string} sessionSecret HMAC 签名密钥
 * @property {string} sessionCookie Cookie 名称
 * @property {number} sessionLifetimeSeconds 会话有效期（秒）
 * @property {{ loginFailures: number }} metrics 指标计数器
 * @property {(header?: string) => Record<string, string>} parseCookies
 */

/**
 * 创建会话相关函数集合。
 * @param {SessionConfig} config
 * @returns {{
 *   sessionSignature: (payload: string) => string,
 *   createSessionToken: (user: SessionUser) => string,
 *   readSessionToken: (token: unknown) => { uid: string, v: number, exp: number, sid?: string } | null,
 *   currentUser: (req: Request) => (SessionUser | null),
 *   setSessionCookie: (req: Request, res: Response, user: SessionUser) => void,
 *   clearSessionCookie: (res: Response) => void,
 *   checkLoginBlocked: (ip: string, username: string) => boolean,
 *   recordLoginFailure: (ip: string, username: string) => void,
 *   clearLoginFailures: (username: string) => void,
 * }}
 */
export function createSession({
  store,
  sessionSecret,
  sessionCookie,
  sessionLifetimeSeconds,
  metrics,
  parseCookies,
}) {
  function sessionSignature(payload) {
    return crypto
      .createHmac('sha256', sessionSecret)
      .update(payload)
      .digest('base64url');
  }

  /**
   * 生成会话 ID。
   * @returns {string}
   */
  function createSessionId() {
    return crypto.randomUUID();
  }

  /**
   * 签发会话令牌。
   *
   * 载荷新增 `sid`（会话 ID）字段，用于服务端按会话精确撤销。
   * 载荷同时保留 `uid` / `v`（账号 token 版本）/ `exp`，语义与改造前一致。
   *
   * @param {SessionUser} user 用户。
   * @returns {string}
   */
  function createSessionToken(user) {
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        v: user.tokenVersion ?? 0,
        exp: Date.now() + sessionLifetimeSeconds * 1000,
        sid: createSessionId(),
      }),
    ).toString('base64url');
    return `${payload}.${sessionSignature(payload)}`;
  }

  /**
   * 校验并解析会话令牌。
   * @param {unknown} token 令牌字符串。
   * @returns {{ uid: string, v: number, exp: number, sid?: string } | null}
   */
  function readSessionToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = sessionSignature(payload);
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof parsed.uid !== 'string' || typeof parsed.exp !== 'number') {
        return null;
      }
      if (parsed.exp < Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 从请求解析当前登录用户。
   *
   * 校验链：签名 → 有效期 → 账号存在且未停用 → 账号级 token 版本匹配
   * → 会话级 sid 未被撤销。
   *
   * @param {Request} req 请求。
   * @returns {SessionUser | null}
   */
  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[sessionCookie];
    const session = readSessionToken(token);
    if (!session) return null;
    const user = store.getUser(session.uid);
    if (!user || user.disabled) return null;
    if ((session.v ?? 0) !== (user.tokenVersion ?? 0)) return null;
    // 会话级撤销：仅当 sid 存在且服务端记录了它时检查（兼容升级前的旧令牌）。
    if (session.sid && typeof store.isSessionRevoked === 'function') {
      if (store.isSessionRevoked(session.uid, session.sid)) return null;
    }
    return user;
  }

  /**
   * 写入会话 Cookie。
   * @param {Request} req 请求。
   * @param {Response} res 响应。
   * @param {SessionUser} user 用户。
   * @returns {void}
   */
  function setSessionCookie(req, res, user) {
    const token = createSessionToken(user);
    // 登记会话：登出时按 sid 精确撤销，避免影响其它标签页。
    const sid = readSessionToken(token)?.sid;
    if (sid && typeof store.registerSession === 'function') {
      try {
        store.registerSession(user.id, sid, {
          userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 200),
          ip: String(req.ip ?? '').slice(0, 128),
          expiresAt: Date.now() + sessionLifetimeSeconds * 1000,
        });
      } catch {
        // 登记失败不阻断登录：降级为「仅账号级撤销」模式。
      }
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${
        secure ? '; Secure' : ''
      }`,
    );
  }

  /**
   * 清除会话 Cookie。
   * @param {Response} res 响应。
   * @returns {void}
   */
  function clearSessionCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  const loginAttempts = new Map();
  const accountAttempts = new Map();
  const ipAttempts = new Map();
  const windowMs = 10 * 60 * 1000;
  // 第四维：全站累计失败数。不依赖 IP 也不依赖用户名 —— 攻击者同时轮换
  // X-Forwarded-For 与 username 时，前三维会同时失效。全局维度在达到阈值后
  // 进入短时冷却（而非硬锁账号），既能挡住喷洒又不至于让正常用户长时间无法登录。
  const GLOBAL_FAILURE_LIMIT = 500;
  const globalCooldownMs = 60_000;
  let globalFailures = { count: 0, started: 0, cooldownUntil: 0 };

  // 简单、可清理的三维度登录限流。
  //
  // 1. `ip:username`（8 次/窗口）：限制**单一来源**对某个账号的尝试。
  // 2. `username`（20 次/窗口）：限制针对某个账号的**分布式**暴力破解。
  //    这一维不含 IP：开启 TRUST_PROXY 后 req.ip 取自 X-Forwarded-For，
  //    攻击者轮换该头即可绕过只含 IP 的限流。阈值取 20（高于维度 1）
  //    是为了兼顾：既能挡住分布式爆破，又不会因为误触就把正常账号锁死。
  // 3. `ip`（30 次/窗口）：限制单一来源对所有账号的尝试。
  function checkLoginBlocked(ip, username) {
    const now = Date.now();
    const account = loginAttempts.get(`${ip}:${username}`);
    const globalAccount = accountAttempts.get(username);
    const address = ipAttempts.get(ip);
    const within = (record, limit) =>
      Boolean(record && record.count >= limit && now - record.started < windowMs);
    return (
      now < globalFailures.cooldownUntil ||
      within(account, 8) ||
      within(globalAccount, 20) ||
      within(address, 30)
    );
  }

  function recordLoginFailure(ip, username) {
    const now = Date.now();
    metrics.loginFailures += 1;
    if (now - globalFailures.started > windowMs) {
      globalFailures = { count: 1, started: now, cooldownUntil: 0 };
    } else {
      globalFailures.count += 1;
    }
    if (globalFailures.count >= GLOBAL_FAILURE_LIMIT) {
      globalFailures.cooldownUntil = now + globalCooldownMs;
    }
    const accountKey = `${ip}:${username}`;
    const account = loginAttempts.get(accountKey);
    if (!account || now - account.started > windowMs) {
      loginAttempts.set(accountKey, { count: 1, started: now });
    } else {
      account.count += 1;
    }
    const globalAccount = accountAttempts.get(username);
    if (!globalAccount || now - globalAccount.started > windowMs) {
      accountAttempts.set(username, { count: 1, started: now });
    } else {
      globalAccount.count += 1;
    }
    const address = ipAttempts.get(ip);
    if (!address || now - address.started > windowMs) {
      ipAttempts.set(ip, { count: 1, started: now });
    } else {
      address.count += 1;
    }
  }

  /**
   * 登录成功后清零该账号的失败计数。
   *
   * 原实现只在失败路径累加，登录成功不清零：用户输错 7 次后输对，
   * 计数仍停在 7，再错 1 次就被锁 10 分钟。
   *
   * @param {string} username 小写用户名。
   * @returns {void}
   */
  function clearLoginFailures(username) {
    accountAttempts.delete(username);
    for (const key of loginAttempts.keys()) {
      if (key.endsWith(`:${username}`)) loginAttempts.delete(key);
    }
  }

  setInterval(() => {
    const now = Date.now();
    // 全局失败计数窗口过期后重置（冷却期内不清零，避免绕过）。
    if (now - globalFailures.started > windowMs && now >= globalFailures.cooldownUntil) {
      globalFailures = { count: 0, started: now, cooldownUntil: 0 };
    }
    for (const [key, record] of loginAttempts) {
      if (now - record.started > windowMs) loginAttempts.delete(key);
    }
    for (const [key, record] of accountAttempts) {
      if (now - record.started > windowMs) accountAttempts.delete(key);
    }
    for (const [key, record] of ipAttempts) {
      if (now - record.started > windowMs) ipAttempts.delete(key);
    }
    // 超量时淘汰最旧记录而非整体清空——整表 clear 会给攻击者制造限流重置窗口。
    const evictOldest = (map) => {
      const overflow = map.size - 10_000;
      if (overflow <= 0) return;
      let removed = 0;
      for (const key of map.keys()) {
        map.delete(key);
        if (++removed >= overflow) break;
      }
    };
    evictOldest(loginAttempts);
    evictOldest(accountAttempts);
    evictOldest(ipAttempts);
  }, 5 * 60 * 1000).unref();

  return {
    sessionSignature,
    createSessionToken,
    readSessionToken,
    currentUser,
    setSessionCookie,
    clearSessionCookie,
    checkLoginBlocked,
    recordLoginFailure,
    clearLoginFailures,
  };
}

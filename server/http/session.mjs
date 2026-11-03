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
 * @property {object} store 数据库访问层，需提供 getUser(id)
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
 *   readSessionToken: (token: unknown) => { uid: string, v: number, exp: number } | null,
 *   currentUser: (req: Request) => (SessionUser | null),
 *   setSessionCookie: (req: Request, res: Response, user: SessionUser) => void,
 *   clearSessionCookie: (res: Response) => void,
 *   checkLoginBlocked: (ip: string, username: string) => boolean,
 *   recordLoginFailure: (ip: string, username: string) => void,
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

  function createSessionToken(user) {
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        v: user.tokenVersion ?? 0,
        exp: Date.now() + sessionLifetimeSeconds * 1000,
      }),
    ).toString('base64url');
    return `${payload}.${sessionSignature(payload)}`;
  }

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

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[sessionCookie];
    const session = readSessionToken(token);
    if (!session) return null;
    const user = store.getUser(session.uid);
    if (!user || user.disabled) return null;
    if ((session.v ?? 0) !== (user.tokenVersion ?? 0)) return null;
    return user;
  }

  function setSessionCookie(req, res, user) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=${encodeURIComponent(createSessionToken(user))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${
        secure ? '; Secure' : ''
      }`,
    );
  }

  function clearSessionCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  const loginAttempts = new Map();
  const ipAttempts = new Map();
  const windowMs = 10 * 60 * 1000;

  // 简单、可清理的双维度登录限流。
  function checkLoginBlocked(ip, username) {
    const now = Date.now();
    const account = loginAttempts.get(`${ip}:${username}`);
    const address = ipAttempts.get(ip);
    return Boolean(
      (account && account.count >= 8 && now - account.started < windowMs) ||
        (address && address.count >= 30 && now - address.started < windowMs),
    );
  }

  function recordLoginFailure(ip, username) {
    const now = Date.now();
    metrics.loginFailures += 1;
    const accountKey = `${ip}:${username}`;
    const account = loginAttempts.get(accountKey);
    if (!account || now - account.started > windowMs) {
      loginAttempts.set(accountKey, { count: 1, started: now });
    } else {
      account.count += 1;
    }
    const address = ipAttempts.get(ip);
    if (!address || now - address.started > windowMs) {
      ipAttempts.set(ip, { count: 1, started: now });
    } else {
      address.count += 1;
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of loginAttempts) {
      if (now - record.started > windowMs) loginAttempts.delete(key);
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
  };
}

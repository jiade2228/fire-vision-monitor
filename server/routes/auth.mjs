import crypto from 'node:crypto';

import {
  badRequest,
  conflict,
  invalidCredentials,
  tooManyAttempts,
  unauthorized,
} from '../auth/errors.mjs';
import { CAPABILITIES, resolveCapabilityGuard } from '../auth/roles.mjs';

/**
 * 认证与会话相关接口：初始化状态、首次 setup、登录、登出、当前用户、
 * SSE 事件流、能力探测。
 *
 * 采用 deps 注入模式：会话工厂函数、main() 闭包中的 store 与服务、以及
 * index.mjs 的模块级辅助函数，统一通过 deps 传入；node 内建 crypto 直接
 * import，避免与 index.mjs 循环依赖。行为与原内联路由完全一致。
 *
 * ── 重构说明（本轮）────────────────────────────────────────────────
 *
 * 1. **登出语义修正**。改造前 `POST /api/auth/logout` 调用
 *    `bumpTokenVersion(user.id)` —— token_version 写在 users 表上，是**账号级**的，
 *    于是用户在一个标签页登出，该账号在所有设备、所有标签页的令牌会同时失效。
 *    这不是"登出"，是"全端下线"：值守大屏误点登出会导致其它屏幕一起掉线。
 *    现在改为**只撤销当前会话**（按 sid 精确撤销）。
 *
 *    兼容性：`bumpTokenVersion` 保留在 store 层，`/api/auth/logout` 的
 *    响应体（`{ ok: true }`）与状态码（200）完全不变，只是语义更准确。
 *    需要「全端下线」时用 `PATCH /api/users/:id` 改密码或停用账号 ——
 *    那两处仍会递增 token_version，全部令牌失效（这是应有的强语义）。
 *
 * 2. **统一错误类型**。原先各路由散落 `res.status(xxx).json({ error })`，
 *    文案口径不一。现在统一走 auth/errors.mjs，登录失败固定为
 *    「用户名或密码错误」，账号不存在与密码错误**不可区分**。
 *
 * 3. **能力守卫**。新增 requireCapability 入口（见 http/guards.mjs）。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerAuthRoutes(app, deps) {
  const {
    requireCapability,
    requireManager,
    requireRole,
    currentUser,
    setSessionCookie,
    clearSessionCookie,
    checkLoginBlocked,
    recordLoginFailure,
    clearLoginFailures,
    store,
    publicUser,
    normalizeText,
    validUsername,
    validatePassword,
    passwordHash,
    verifyPassword,
    clientIp,
    defaultCameras,
    setupGuard,
    requireAuth,
    allowedSiteIdsFor,
    sseClients,
    detectionEngine,
  } = deps;
  // 能力守卫降级：旧调用方（既有测试/集成方）可能只提供 requireRole，
  // 此时按能力反查角色兜底，保证零改动兼容；两者都缺失则一律拒绝。
  const capabilityGuard = resolveCapabilityGuard(requireCapability, requireRole, requireManager);

  app.get('/api/auth/status', (req, res) => {
    const user = currentUser(req);
    res.json({
      needsSetup: store.needsSetup,
      authenticated: Boolean(user),
      user: user ? publicUser(user) : null,
    });
  });

  app.post('/api/setup', async (req, res) => {
    if (setupGuard.inFlight || !store.needsSetup || store.setupComplete) {
      return res.status(409).json({ error: '系统已经初始化' });
    }
    const username = normalizeText(req.body.username, 32);
    const displayName = normalizeText(req.body.displayName, 32) || username;
    if (!validUsername(username)) {
      return res.status(400).json({ error: '用户名需为 3-32 位字母、数字、点、横线或下划线' });
    }
    if (!validatePassword(req.body.password)) {
      return res.status(400).json({ error: '密码至少需要 8 位' });
    }
    setupGuard.inFlight = true;
    try {
      const user = {
        id: crypto.randomUUID(),
        username,
        displayName,
        role: 'admin',
        // 密码哈希带算法版本与参数前缀，便于将来升级 KDF 参数。
        salt: crypto.randomBytes(16).toString('hex'),
        passwordHash: await passwordHash(req.body.password),
        disabled: false,
        tokenVersion: 0,
        createdAt: Date.now(),
      };
      store.transaction(() => {
        store.createUser(user);
        for (const camera of defaultCameras) {
          store.insertCamera({
            ...camera,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        store.setMeta('setup_complete', '1');
        store.recordAudit({
          user,
          action: 'system.setup',
          targetType: 'system',
          detail: '创建初始管理员和默认点位',
          ip: clientIp(req),
        });
      });
      const created = store.getUser(user.id);
      setSessionCookie(req, res, created);
      res.status(201).json({ user: publicUser(created) });
    } finally {
      setupGuard.inFlight = false;
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = normalizeText(req.body.username, 32);
    const ip = clientIp(req);
    if (checkLoginBlocked(ip, username.toLowerCase())) {
      const error = tooManyAttempts(`${ip} 对 ${username} 的尝试已超限`);
      res.setHeader('Retry-After', '600');
      return res.status(error.status).json(error.toBody());
    }
    const user = store.getUserByUsername(username);
    // 无论账号是否存在都走一次等价 KDF，避免用响应时间枚举用户名。
    const passwordOk = await verifyPassword(req.body.password, user);
    if (!user || user.disabled || !passwordOk) {
      recordLoginFailure(ip, username.toLowerCase());
      store.recordAudit({
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        detail: username ? `用户名 ${username}` : '空用户名',
        ip,
      });
      // 对外文案不区分「账号不存在」与「密码错误」，避免账号枚举。
      const error = invalidCredentials(
        user ? '密码不匹配' : '账号不存在或已停用',
      );
      return res.status(error.status).json(error.toBody());
    }
    // 登录成功清零该账号的失败计数：否则输错 7 次后输对，计数仍为 7，
    // 再错 1 次就会被锁 10 分钟。
    clearLoginFailures(username.toLowerCase());
    setSessionCookie(req, res, user);
    store.recordAudit({
      user,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      ip,
    });
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    // 只撤销**当前会话**：把该标签页踢下线，其它标签页/设备继续可用。
    //
    // 改造前这里调用 bumpTokenVersion(user.id)，那是账号级的 —— 会把该账号
    // 所有设备的令牌一起作废（监控大屏场景下等于「全端下线」）。
    // 账号级的强失效仍然保留在「改密码」与「停用账号」两处（它们会递增
    // token_version），语义上更符合直觉。
    const user = currentUser(req);
    const token = parseSessionCookie(req);
    const session = token ? readSession(token) : null;
    if (user?.id && session?.sid) {
      try {
        store.revokeSession?.(user.id, session.sid);
      } catch {
        // 撤销失败不阻断本次登出（Cookie 仍会被清除）。
      }
      // 同时关闭该会话的事件流：否则被登出的标签页仍会继续收到告警推送。
      for (const client of sseClients) {
        if (client.sid !== session.sid) continue;
        try {
          client.res.end();
        } catch {
          // 连接可能已断开。
        }
        sseClients.delete(client);
      }
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  /**
   * 当前登录会话列表（新增，只读）。
   *
   * 用于「我的登录设备」—— 让用户知道自己的账号在哪些设备上处于登录态，
   * 为「踢掉某台设备」提供基础。
   */
  app.get('/api/auth/sessions', requireAuth, (req, res) => {
    const sessions = store.listUserSessions?.(req.user.id) ?? [];
    res.json({ sessions });
  });

  app.get('/api/events', requireAuth, (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(
      `event: ready\ndata: ${JSON.stringify({
        userId: req.user.id,
        at: Date.now(),
      })}\n\n`,
    );
    // 连接数上限：按用户限制多标签页数量，并限制全站总连接数，
    // 防止任一登录用户建立大量长连接耗尽 FD/内存并拖慢广播遍历。
    const MAX_SSE_PER_USER = 5;
    const MAX_SSE_TOTAL = 200;
    const sameUser = [...sseClients].filter((item) => item.userId === req.user.id);
    if (sameUser.length >= MAX_SSE_PER_USER || sseClients.size >= MAX_SSE_TOTAL) {
      const oldest = sameUser[0] ?? [...sseClients][0];
      if (oldest) {
        try { oldest.res.end(); } catch { /* 已断开 */ }
        sseClients.delete(oldest);
      }
    }
    const client = {
      res,
      userId: req.user.id,
      // 记录会话 ID：登出后按 sid 精确关闭本连接，不影响该账号其它标签页。
      // 必须走 readSession()：它内部调用 deps.readSessionToken 并吞掉解析异常。
      // 这里曾直接写 readSessionToken(...)，但该函数只存在于 session.mjs 的闭包中，
      // 本模块并未导入，导致 req.user.sid 缺失时（实际所有会话都缺失）抛
      // ReferenceError，SSE 每次连接都在写出 ready 事件后断开。
      sid: readSession(parseSessionCookie(req))?.sid ?? null,
      siteIds: allowedSiteIdsFor(req.user, store),
    };
    sseClients.add(client);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(client);
      }
    }, 25_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  });

  // 供所有登录用户判断是否还需要浏览器本地识别（服务端识别已接管时可省 CPU）。
  app.get('/api/capabilities', requireAuth, (_req, res) => {
    res.json({ serverDetection: Boolean(detectionEngine?.active) });
  });

  /* 内部辅助：从请求 Cookie 中解析出当前会话令牌。
   * 依赖 index.mjs 注入的 sessionCookie / parseCookies / readSessionToken，
   * 这里通过闭包访问，避免重复实现 Cookie 解析。 */
  function parseSessionCookie(req) {
    const cookie = deps.parseCookies?.(req.headers.cookie) ?? {};
    return cookie[deps.sessionCookie] ?? null;
  }
  function readSession(token) {
    try {
      return deps.readSessionToken?.(token) ?? null;
    } catch {
      return null;
    }
  }
}

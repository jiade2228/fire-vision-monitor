import crypto from 'node:crypto';

/**
 * 认证与会话相关接口：初始化状态、首次 setup、登录、登出、当前用户、
 * SSE 事件流、能力探测。
 *
 * 采用 deps 注入模式：会话工厂函数、main() 闭包中的 store 与服务、以及
 * index.mjs 的模块级辅助函数，统一通过 deps 传入；node 内建 crypto 直接
 * import，避免与 index.mjs 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerAuthRoutes(app, deps) {
  const {
    currentUser,
    setSessionCookie,
    clearSessionCookie,
    checkLoginBlocked,
    recordLoginFailure,
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
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: crypto.randomUUID(),
        username,
        displayName,
        role: 'admin',
        salt,
        passwordHash: passwordHash(req.body.password, salt),
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

  app.post('/api/auth/login', (req, res) => {
    const username = normalizeText(req.body.username, 32);
    const ip = clientIp(req);
    if (checkLoginBlocked(ip, username.toLowerCase())) {
      res.setHeader('Retry-After', '600');
      return res.status(429).json({ error: '登录尝试过多，请 10 分钟后再试' });
    }
    const user = store.getUserByUsername(username);
    if (!user || user.disabled || !verifyPassword(req.body.password, user)) {
      recordLoginFailure(ip, username.toLowerCase());
      store.recordAudit({
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        detail: username ? `用户名 ${username}` : '空用户名',
        ip,
      });
      return res.status(401).json({ error: '用户名或密码错误' });
    }
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
    // 递增 tokenVersion 让同一账号其它标签页的已签发 token 一并失效。
    const user = currentUser(req);
    if (user?.id) {
      try {
        store.bumpTokenVersion(user.id);
      } catch {
        // 版本递增失败不阻断本次登出。
      }
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
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
    const client = {
      res,
      userId: req.user.id,
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
}

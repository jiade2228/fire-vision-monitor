/**
 * 鉴权中间件与站点/相机管理能力判断。
 *
 * 采用工厂模式：index.mjs 在启动时把 store 与 currentUser 注入，
 * 返回一组闭包。这样既能把鉴权逻辑独立成文件、缩小 index.mjs 体积，
 * 又保持路由注册处的调用点（requireAuth / requireManager 等）完全不变。
 *
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 * @typedef {import('express').RequestHandler} RequestHandler
 * @typedef {{
 *   id: string,
 *   role: 'admin' | 'manager' | 'operator' | 'viewer',
 *   siteAdmin?: boolean,
 *   tokenVersion?: number,
 *   disabled?: boolean,
 * }} User
 */

/**
 * @typedef {object} GuardsContext
 * @property {(req: Request) => (User | null)} currentUser 从请求解析出当前登录用户
 * @property {object} store 数据库访问层，需提供 siteMemberSiteIds(id) 与 defaultSiteId
 */

/**
 * 创建鉴权相关函数集合。
 * @param {object} store 数据库访问层（提供 siteMemberSiteIds / defaultSiteId）
 * @param {(req: Request) => (User | null)} currentUser 从请求解析当前用户
 * @returns {{
 *   requireAuth: RequestHandler,
 *   requireRole: (...roles: string[]) => RequestHandler,
 *   requireManager: RequestHandler,
 *   adminSiteIdsFor: (user: User | null) => string[] | null,
 *   canManageSite: (user: User | null, siteId: string) => boolean,
 *   canManageCamera: (user: User | null, camera: { siteId?: string }) => boolean,
 *   isManager: (user: User | null) => boolean,
 *   fallbackSiteIdFor: (user: User | null) => string,
 * }}
 */
export function createGuards(store, currentUser) {
  /** 校验登录态，未登录返回 401。 */
  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: '请先登录' });
    req.user = user;
    next();
  }

  /** 校验当前用户拥有指定角色之一，否则 403。 */
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: '请先登录' });
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: '当前账号没有此操作权限' });
      }
      next();
    };
  }

  /** 站点管理员可管理的站点 ID；全局管理员返回 null 表示全部。 */
  function adminSiteIdsFor(user) {
    if (!user) return [];
    if (user.role === 'admin') return null;
    if (!user.siteAdmin) return [];
    return store.siteMemberSiteIds(user.id);
  }

  /** 用户能否管理某站点。 */
  function canManageSite(user, siteId) {
    const ids = adminSiteIdsFor(user);
    if (ids === null) return true;
    return Boolean(siteId) && ids.includes(siteId);
  }

  /** 用户能否管理某相机（按其所属站点判断，缺省归入默认站点）。 */
  function canManageCamera(user, camera) {
    if (!camera) return false;
    return canManageSite(user, camera.siteId || store.defaultSiteId);
  }

  /** 当前用户是否为（全局或站点）管理员。 */
  function isManager(user) {
    const ids = adminSiteIdsFor(user);
    return ids === null || ids.length > 0;
  }

  /** 校验管理权限，否则 401/403。 */
  function requireManager(req, res, next) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!isManager(req.user)) {
      return res.status(403).json({ error: '当前账号没有管理权限' });
    }
    next();
  }

  /** 站点管理员的默认站点：其第一个可管理站点；全局管理员用默认站点。 */
  function fallbackSiteIdFor(user) {
    const ids = adminSiteIdsFor(user);
    if (ids === null) return store.defaultSiteId;
    return ids[0] ?? '';
  }

  return {
    requireAuth,
    requireRole,
    requireManager,
    adminSiteIdsFor,
    canManageSite,
    canManageCamera,
    isManager,
    fallbackSiteIdFor,
  };
}

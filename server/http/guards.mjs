import { AuthError, forbidden, unauthorized } from '../auth/errors.mjs';
import { CAPABILITIES, hasCapability, isManagerRole } from '../auth/roles.mjs';

/**
 * 鉴权中间件与站点/相机管理能力判断。
 *
 * 采用工厂模式：index.mjs 在启动时把 store 与 currentUser 注入，
 * 返回一组闭包。这样既能把鉴权逻辑独立成文件、缩小 index.mjs 体积，
 * 又保持路由注册处的调用点（requireAuth / requireManager 等）完全不变。
 *
 * 重构说明：
 *   - 新增 requireCapability(capability)：基于 server/auth/roles.mjs 的能力矩阵，
 *     是权限判断的**推荐入口**。
 *   - requireRole(...) 与 requireManager 保留为兼容层，语义与改造前**完全一致**，
 *     现有路由调用点无需改动。新代码应优先使用 requireCapability。
 *
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 * @typedef {import('express').RequestHandler} RequestHandler
 * @typedef {{
 *   id: string,
 *   role: 'admin' | 'operator' | 'viewer',
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
 *   requireCapability: (capability: string) => RequestHandler,
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
    if (!user) {
      // 走统一错误体：前端可据 code 区分「会话失效」与其它 401。
      // 文案保持既有值不变。
      const error = new AuthError(401, '请先登录', '缺少有效会话', 'unauthenticated');
      return res.status(error.status).json(error.toBody());
    }
    req.user = user;
    next();
  }

  /**
   * 校验当前用户拥有指定角色之一，否则 403。
   *
   * 兼容层：保留原有语义。新代码请优先使用 requireCapability。
   *
   * @param {...string} roles 允许的角色名。
   * @returns {RequestHandler}
   */
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) {
        const error = unauthorized('缺少有效会话');
        return res.status(error.status).json(error.toBody());
      }
      if (!roles.includes(req.user.role)) {
        const error = forbidden('角色不匹配');
        return res.status(error.status).json(error.toBody());
      }
      next();
    };
  }

  /**
   * 校验当前用户拥有指定能力，否则 403。
   *
   * 这是权限判断的推荐入口：能力矩阵集中在 server/auth/roles.mjs，
   * 新增角色或调整权限只需改那一处，不必逐条改路由。
   *
   * @param {string} capability 能力常量（见 CAPABILITIES）。
   * @returns {RequestHandler}
   */
  function requireCapability(capability) {
    return (req, res, next) => {
      if (!req.user) {
        const error = unauthorized('缺少有效会话');
        return res.status(error.status).json(error.toBody());
      }
      if (!hasCapability(req.user, capability)) {
        const error = forbidden(`缺少能力 ${capability}`);
        return res.status(error.status).json(error.toBody());
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

  /**
   * 当前用户是否为（全局或站点）管理员。
   *
   * 兼容层：语义与改造前一致 —— 全局管理员恒为真；
   * 非 admin 需要具备 siteAdmin 身份。
   *
   * @param {User | null} user 用户对象。
   * @returns {boolean}
   */
  function isManager(user) {
    return isManagerRole(user);
  }

  /** 校验管理权限，否则 401/403。 */
  function requireManager(req, res, next) {
    if (!req.user) {
      const error = unauthorized('缺少有效会话');
      return res.status(error.status).json(error.toBody());
    }
    if (!isManager(req.user)) {
      // 文案保持既有值（站点管理员被拒时的提示），只补 code 字段。
      const error = new AuthError(403, '当前账号没有管理权限', '非管理角色', 'forbidden');
      return res.status(error.status).json(error.toBody());
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
    requireCapability,
    requireManager,
    adminSiteIdsFor,
    canManageSite,
    canManageCamera,
    isManager,
    fallbackSiteIdFor,
  };
}

/**
 * 供其它模块复用的能力常量，避免各处重复 import 路径。
 */
export { CAPABILITIES };

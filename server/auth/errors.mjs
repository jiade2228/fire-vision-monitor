/**
 * 认证与授权域的统一错误类型。
 *
 * 重构背景：改造前各路由各自写 `res.status(400).json({ error: '...' })`，
 * 文案与状态码没有单一来源，导致两类问题：
 *   1. **信息泄露口径不一**：`/api/auth/login` 返回「用户名或密码错误」，
 *      而 `/api/users/:id` 返回「账号不存在」「不能删除当前账号」等精确文案；
 *      账号相关接口的错误文案直接暴露了目标账号的存在性。
 *   2. **重复**：同一条错误在 3~4 处重复书写，改文案要全局搜索。
 *
 * 本模块提供 AuthError 类型与工厂函数，把「状态码 + 对外文案 + 内部原因」
 * 三者绑定：
 *   - 对外文案（message）严格控制信息量，鉴权类失败统一为模糊表述；
 *   - 内部原因（internalReason）只进日志与审计，不进响应体。
 */

/**
 * 认证/授权错误。
 */
export class AuthError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} message 对外文案（不得包含敏感信息）。
   * @param {string} [internalReason] 内部原因，仅用于日志/审计。
   * @param {string} [code] 机器可读错误码。
   */
  constructor(status, message, internalReason = '', code = '') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.internalReason = internalReason;
    this.code = code;
  }

  /**
   * 转换为响应体。
   *
   * 为保持与既有接口兼容，响应体格式仍是 `{ error: string }`；
   * 仅在提供 code 时额外附带 `code` 字段（纯新增，不破坏旧客户端）。
   *
   * @returns {{error: string, code?: string}}
   */
  toBody() {
    return this.code ? { error: this.message, code: this.code } : { error: this.message };
  }
}

/**
 * 未登录（401）。
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function unauthorized(internalReason = '缺少有效会话') {
  return new AuthError(401, '请先登录', internalReason, 'unauthenticated');
}

/**
 * 已登录但权限不足（403）。
 *
 * 对外文案统一为「当前账号没有此操作权限」，不透露被访问资源的具体信息，
 * 避免通过错误文案探测资源是否存在。
 *
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function forbidden(internalReason = '权限不足') {
  return new AuthError(403, '当前账号没有此操作权限', internalReason, 'forbidden');
}

/**
 * 登录失败。
 *
 * 对外统一「用户名或密码错误」，账号不存在与密码错误**不可区分**，
 * 防止账号枚举。
 *
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function invalidCredentials(internalReason = '凭据不匹配') {
  return new AuthError(401, '用户名或密码错误', internalReason, 'invalid_credentials');
}

/**
 * 登录尝试过于频繁（429）。
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function tooManyAttempts(internalReason = '登录尝试过多') {
  return new AuthError(
    429,
    '登录尝试过多，请 10 分钟后再试',
    internalReason,
    'too_many_attempts',
  );
}

/**
 * 输入校验失败（400）。
 * @param {string} message 对外文案。
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function badRequest(message, internalReason = '') {
  return new AuthError(400, message, internalReason, 'bad_request');
}

/**
 * 资源冲突（409）。
 * @param {string} message 对外文案。
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function conflict(message, internalReason = '') {
  return new AuthError(409, message, internalReason, 'conflict');
}

/**
 * 未找到（404）。
 *
 * 用于「越权访问也按不存在处理」的场景，避免通过 403 探测资源是否存在。
 *
 * @param {string} message 对外文案。
 * @param {string} [internalReason] 内部原因。
 * @returns {AuthError}
 */
export function notFound(message = '资源不存在', internalReason = '') {
  return new AuthError(404, message, internalReason, 'not_found');
}

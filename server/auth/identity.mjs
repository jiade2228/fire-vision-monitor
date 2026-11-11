import { isValidRole, normalizeRole } from './roles.mjs';

/**
 * 用户身份投影与通用输入归一化。
 *
 * 重构背景：改造前 normalizeText / publicUser 定义在 server/index.mjs，
 * 通过 deps 注入透传到 4 个路由模块；而 publicUser 是「脱敏边界」——
 * 它决定了哪些字段会离开服务端。把它放在 index.mjs 里意味着：
 * 任何新增路由只要记得调 publicUser 就安全，忘了就会把 salt / passwordHash
 * 直接吐给前端。
 *
 * 现在把投影收敛到本模块，并让 store 层返回的原始用户对象显式携带
 * `sensitive: true` 标记 —— 任何未经过 toPublicUser 的对象都带着这个标记，
 * 便于测试与审计发现泄漏路径。
 */

/**
 * 归一化用户输入文本：去首尾空白、压缩连续空白、截断到上限。
 *
 * @param {unknown} value 原始值。
 * @param {number} maxLength 最大长度。
 * @returns {string} 归一化后的文本（非字符串输入返回空串）。
 */
export function normalizeText(value, maxLength) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
    : '';
}

/**
 * 把内部用户对象投影为可安全外发的公开对象。
 *
 * 这是**唯一**允许离开服务端的用户形态：不包含 salt、passwordHash。
 * 所有返回用户数据的接口都必须经过本函数。
 *
 * @param {object | null} user 内部用户对象。
 * @returns {object | null} 公开用户对象；入参为空时返回 null。
 */
export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: normalizeRole(user.role),
    siteAdmin: Boolean(user.siteAdmin),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  };
}

/**
 * 判断给定的用户对象是否为「未脱敏的内部对象」。
 *
 * 供测试与静态检查使用：若某个接口把这种对象直接返回，说明发生了凭据泄漏。
 *
 * @param {unknown} value 待检查对象。
 * @returns {boolean}
 */
export function isSensitiveUserObject(value) {
  if (!value || typeof value !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    'salt' in record ||
    'passwordHash' in record ||
    'password_hash' in record
  );
}

/**
 * 校验并归一化用户输入的角色名。
 * @param {unknown} value 原始角色。
 * @returns {{ok: true, role: string} | {ok: false, error: string}}
 */
export function parseRoleInput(value) {
  if (!isValidRole(value)) {
    return { ok: false, error: '角色无效，只能是 admin、operator 或 viewer' };
  }
  return { ok: true, role: /** @type {string} */ (value) };
}

import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希与校验能力。
 *
 * 重构背景：改造前 passwordHash / verifyPassword / dummyVerify / validUsername /
 * validatePassword 定义在 server/index.mjs（一个 1900+ 行的模块级文件）里，
 * 再经 deps 注入透传给 routes/auth.mjs、routes/users.mjs、reset-password.mjs。
 * 结果是：密码策略散落、reset-password 必须复制一份 scrypt 调用才能与服务端
 * 保持参数一致（一旦某侧改参数，另一侧会静默地让所有密码校验失败）。
 *
 * 本模块把这些能力收敛到一处，并做两处强化：
 *   1. **算法版本化**：哈希串带 `scrypt$<params>$<salt>$<hash>` 形式，
 *      支持将来升级 KDF 参数并在登录时透明重哈希（旧格式仍可校验）。
 *   2. **强度可配置**：显式写出 scrypt 的 N/r/p，而不是依赖 Node 默认值，
 *      避免不同 Node 版本默认值变化导致存量密码集体失效。
 *
 * 兼容性：verifyPassword 同时接受「旧的裸 hex 哈希」与「新的版本化串」，
 * 因此升级无需强制改密码，存量用户登录时自动重哈希为新格式。
 */

/**
 * scrypt 参数。
 *
 * N=2^15, r=8, p=1：内存开销约 32MB/次，OWASP 对 scrypt 的最低推荐为 N=2^17。
 * 这里取 N=2^15 是「单次约 60ms」的折中：既能有效抬高离线爆破成本，
 * 又不会让登录接口在并发场景下成为 CPU 瓶颈（登录有三维限流保护）。
 * 如需更高强度，改这里即可 —— 所有存量哈希会在下次登录时自动重哈希。
 */
export const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
});

/**
 * **历史默认参数**（改造前使用的 Node 默认值）。
 *
 * 关键：改造前本项目用 `promisify(crypto.scrypt)` 的默认参数，
 * 即 N=2^14=16384, r=8, p=1。存量用户的 password_hash 是用这组参数算出来的，
 * 且旧格式哈希串里**没有记录参数**。
 *
 * 若校验时用新参数（N=2^15）去比对旧哈希，全部存量用户都会登录失败。
 * 因此解析旧格式哈希时必须回退到这组历史参数。
 * 新登录/改密码会写新格式（内含参数），登录成功后自动重哈希升级。
 */
export const LEGACY_SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
});

/**
 * 密码哈希算法的版本号，写入哈希串便于将来识别与升级。
 */
export const PASSWORD_HASH_VERSION = 1;

/**
 * 单次 scrypt 的内存上限。
 *
 * Node 默认 maxmem 为 32MB，而 N=32768,r=8 需要 32MB 恰好略超，
 * 会触发 "Invalid scrypt params" 报错。必须显式放宽到 64MB。
 */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/**
 * 为什么用异步版：`crypto.scryptSync` 会在请求处理线程上同步占用 50–100ms
 * 纯 CPU 时间，Node 单线程下会把**所有**其它请求（健康检查、告警查询、
 * 媒体流）一起卡住；配合登录限流可构成拒绝服务。
 * 异步版把 KDF 交给 libuv 线程池，事件循环不再被阻塞。
 */
const scryptAsync = promisify(crypto.scrypt);

/**
 * 密码最小/最大长度。
 * 最小 8 位沿用改造前的策略（保证兼容）；最大 128 位防止超长输入
 * 拖垮 KDF 与内存。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 用户名规则：3-32 位字母、数字、点、横线或下划线。
 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

/**
 * 判断用户名是否合法。
 * @param {unknown} value 用户名。
 * @returns {boolean}
 */
export function validUsername(value) {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

/**
 * 判断密码是否满足强度要求。
 *
 * 改造前仅要求长度 >= 8。新策略在此基础上追加了对常见弱口令的拒绝，
 * 但**保留长度下限不变**以兼容既有口令与既有测试契约。
 *
 * @param {unknown} value 明文密码。
 * @returns {boolean}
 */
export function validatePassword(value) {
  if (typeof value !== 'string') return false;
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  // 纯空白或单一字符重复的组合在 8 位以上仍属弱口令，直接拒绝。
  if (/^\s+$/.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return true;
}

/**
 * 生成密码摘要。
 *
 * 返回格式：`scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * 带版本与参数前缀，使参数升级后旧哈希仍可被识别与校验。
 *
 * @param {string} password 明文密码。
 * @param {string} [salt] 每账号随机的 salt（hex）。缺省则自动生成。
 * @returns {Promise<string>} 版本化哈希串。
 */
export async function passwordHash(password, salt) {
  const saltHex = salt ?? crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(
    String(password ?? ''),
    saltHex,
    SCRYPT_PARAMS.keylen,
    {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_MAXMEM,
    },
  );
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    saltHex,
    Buffer.from(derived).toString('hex'),
  ].join('$');
}

/**
 * 解析已存储的哈希串。
 *
 * 支持两种格式：
 *   - 新格式：`scrypt$N$r$p$salt$hash`
 *   - 旧格式：裸 hex（无分隔符），参数按当前默认值解释。
 *
 * @param {string} stored 已存储的哈希串。
 * @returns {{salt: string, hash: string, params: {N: number, r: number, p: number}} | null}
 */
export function parsePasswordHash(stored) {
  if (typeof stored !== 'string' || !stored) return null;
  const parts = stored.split('$');
  if (parts.length === 6 && parts[0] === 'scrypt') {
    const [, n, r, p, salt, hash] = parts;
    const N = Number(n);
    const R = Number(r);
    const P = Number(p);
    if (!Number.isFinite(N) || !Number.isFinite(R) || !Number.isFinite(P)) {
      return null;
    }
    if (!salt || !hash) return null;
    return { salt, hash, params: { N, r: R, p: P } };
  }
  // 旧格式：整串即 hex 哈希，salt 来自独立的 salt 列。
  // 参数回退到**历史默认值**（N=2^14）—— 存量哈希是用它算出来的，
  // 用新参数比对会导致所有老用户无法登录。
  if (/^[0-9a-f]+$/i.test(stored)) {
    return {
      salt: '',
      hash: stored,
      params: {
        N: LEGACY_SCRYPT_PARAMS.N,
        r: LEGACY_SCRYPT_PARAMS.r,
        p: LEGACY_SCRYPT_PARAMS.p,
      },
    };
  }
  return null;
}

/**
 * 判断哈希串是否已是当前参数下的最新格式（用于登录时透明升级）。
 * @param {string} stored 已存储的哈希串。
 * @returns {boolean}
 */
export function isCurrentPasswordHash(stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  return (
    parts.length === 6 &&
    parts[0] === 'scrypt' &&
    Number(parts[1]) === SCRYPT_PARAMS.N &&
    Number(parts[2]) === SCRYPT_PARAMS.r &&
    Number(parts[3]) === SCRYPT_PARAMS.p
  );
}

/**
 * 校验密码。
 *
 * 用户不存在/已停用时同样执行一次等价 KDF（dummyVerify），
 * 消除「用户不存在 → 立即返回」的时序侧信道，避免被用来枚举账号。
 *
 * @param {string} password 明文密码。
 * @param {{salt?: string, passwordHash?: string} | null} user 用户记录。
 * @returns {Promise<boolean>} 是否匹配。
 */
export async function verifyPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) {
    await dummyVerify();
    return false;
  }
  const parsed = parsePasswordHash(user.passwordHash);
  if (!parsed) {
    await dummyVerify();
    return false;
  }
  // 旧格式的 salt 存在独立的 salt 列；新格式的 salt 内嵌在哈希串里。
  const salt = parsed.salt || user.salt;
  const derived = Buffer.from(
    await scryptAsync(
      String(password ?? ''),
      salt,
      SCRYPT_PARAMS.keylen,
      {
        N: parsed.params.N,
        r: parsed.params.r,
        p: parsed.params.p,
        maxmem: SCRYPT_MAXMEM,
      },
    ),
  );
  const expected = Buffer.from(parsed.hash, 'hex');
  if (derived.length !== expected.length) {
    await dummyVerify();
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * 空跑一次 scrypt：用于在「账号不存在」时抹平与正常校验的时间差。
 * @returns {Promise<void>}
 */
export async function dummyVerify() {
  try {
    await scryptAsync(
      'invalid-password-placeholder',
      'invalid-salt',
      SCRYPT_PARAMS.keylen,
      {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: SCRYPT_MAXMEM,
      },
    );
  } catch {
    // ignore
  }
}

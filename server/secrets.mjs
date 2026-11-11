import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

function decodeKey(value, label) {
  if (!value) throw new Error(`${label} 不能为空`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${label} 必须是 32 字节 base64 密钥`);
  return key;
}

async function loadOrCreateKeyFile(dataDir, fileName, envValue, { createIfMissing = true } = {}) {
  if (envValue) return decodeKey(envValue, fileName);
  const file = path.join(dataDir, fileName);
  try {
    const value = (await fsp.readFile(file, 'utf8')).trim();
    return decodeKey(value, fileName);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!createIfMissing) {
      throw new Error(
        `缺少 ${fileName}，无法解密已保存的点位凭据。请从备份恢复该文件或设置对应环境变量。`,
      );
    }
    const key = crypto.randomBytes(32);
    await fsp.writeFile(file, key.toString('base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return key;
  }
}

export async function loadCredentialKey(dataDir, options = {}) {
  return loadOrCreateKeyFile(
    dataDir,
    'credentials.key',
    process.env.CREDENTIALS_KEY,
    options,
  );
}

export async function loadEdgeToken(dataDir) {
  if (process.env.EDGE_GATEWAY_TOKEN) {
    if (process.env.EDGE_GATEWAY_TOKEN.length < 16) {
      throw new Error('EDGE_GATEWAY_TOKEN 至少需要 16 个字符');
    }
    return process.env.EDGE_GATEWAY_TOKEN;
  }
  const file = path.join(dataDir, 'edge.token');
  try {
    const value = (await fsp.readFile(file, 'utf8')).trim();
    if (value.length < 16) throw new Error('edge.token 内容无效');
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const value = crypto.randomBytes(36).toString('base64url');
    await fsp.writeFile(file, value, { mode: 0o600, flag: 'wx' });
    return value;
  }
}

export async function loadSessionSecret(dataDir, legacySecret = '') {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET 至少需要 32 个字符');
    }
    return process.env.SESSION_SECRET;
  }
  const file = path.join(dataDir, 'session.secret');
  try {
    const value = (await fsp.readFile(file, 'utf8')).trim();
    if (value.length < 32) throw new Error('session.secret 内容无效');
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const value = legacySecret || crypto.randomBytes(48).toString('base64url');
    await fsp.writeFile(file, value, { mode: 0o600, flag: 'wx' });
    return value;
  }
}

/** 密文前缀（版本标记）。 */
const CIPHER_PREFIX = 'enc:v1:';

export class SecretBox {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error('SecretBox 需要 32 字节密钥');
    }
    this.key = key;
  }

  /**
   * 加密明文。
   *
   * 注意：**不再**因为明文「看起来像密文」就原样返回——那会让一条恰好以
   * `enc:v1:` 开头的凭据被明文入库，随后 decrypt 又把它当密文解析而报错。
   * 现在任何明文都会被真实加密，幂等性由调用方（先查后写）保证。
   *
   * @param {string} value 明文。
   * @returns {string} 形如 enc:v1:iv:tag:cipher 的密文。
   */
  encrypt(value) {
    const plaintext = String(value ?? '');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  /**
   * 解密密文；非本格式的值按明文原样返回（兼容历史明文数据）。
   * @param {string} value 密文或明文。
   * @returns {string} 明文。
   */
  decrypt(value) {
    const text = String(value ?? '');
    if (!text.startsWith(CIPHER_PREFIX)) return text;
    const [, version, ivValue, tagValue, cipherValue] = text.split(':');
    if (version !== 'v1' || !ivValue || !tagValue || !cipherValue) {
      throw new Error('加密数据格式无效');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivValue, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherValue, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}


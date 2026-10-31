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

export class SecretBox {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error('SecretBox 需要 32 字节密钥');
    }
    this.key = key;
  }

  encrypt(value) {
    const plaintext = String(value ?? '');
    if (plaintext.startsWith('enc:v1:')) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(value) {
    const text = String(value ?? '');
    if (!text.startsWith('enc:v1:')) return text;
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


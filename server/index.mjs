import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { VENDORS_BY_ID, buildVendorUrl, publicVendors } from './vendors.mjs';
import {
  SecretBox,
  loadCredentialKey,
  loadEdgeToken,
  loadSessionSecret,
} from './secrets.mjs';
import { openStore, parseRoi } from './store.mjs';
import { StreamError, StreamManager } from './streams.mjs';
import { ffprobeAvailable, probeStream } from './probe.mjs';
import { EdgeHub, parseEdgeSource } from './edge-hub.mjs';
import { discoverDevices } from './onvif.mjs';
import { discoverOnvifDevices } from './onvif-discovery.mjs';
import { DetectionEngine } from './detection-engine.mjs';
import {
  DEMO_CAMERA_CODE,
  DEMO_CAMERA_NAME,
  DEMO_CAMERA_ZONE,
  DemoSource,
  DemoSourceError,
} from './demo-source.mjs';
import { Notifier } from './notify.mjs';
import { createGuards } from './http/guards.mjs';
import { createSession } from './http/session.mjs';
import { registerNotifyRoutes } from './routes/notify.mjs';
import { registerCameraRoutes } from './routes/cameras.mjs';
import { registerAlarmRoutes } from './routes/alarms.mjs';
import { registerSiteRoutes } from './routes/sites.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, 'data');
const distDir = path.join(projectRoot, 'dist');
const legacyJsonFile = path.join(dataDir, 'app.json');
const databaseFile = path.join(dataDir, 'app.db');
const snapshotDir = path.join(dataDir, 'snapshots');
const recordingsDir = path.join(dataDir, 'recordings');
const previewDir = path.join(dataDir, 'previews');
const portArgIndex = process.argv.indexOf('--port');
const port = Number(
  process.env.PORT ?? (portArgIndex >= 0 ? process.argv[portArgIndex + 1] : 4173),
);
const sessionCookie = 'fv_session';
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const maxSnapshotBytes = 1_500_000;
const startedAt = Date.now();

const defaultCameras = [
  ['CAM-01', '一号仓库', 'A 区库房'],
  ['CAM-02', '配电室', 'B1 层'],
  ['CAM-03', '食堂后厨', '综合楼一层'],
  ['CAM-04', '生产车间', 'C 区厂房'],
  ['CAM-05', '地下车库', 'B2 层'],
  ['CAM-06', '主楼走廊', '办公楼三层'],
].map(([code, name, zone]) => ({
  id: crypto.randomUUID(),
  code,
  name,
  zone,
  protocol: 'none',
  sourceUrl: '',
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}));

const metrics = {
  requests: 0,
  errors: 0,
  loginFailures: 0,
  alarmsCreated: 0,
};
const sseClients = new Set();

function broadcastEvent(event, data, siteId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    // 告警事件按站点投递：避免把 A 区告警推给只有 B 区权限的账号。
    if (siteId && Array.isArray(client.siteIds) && !client.siteIds.includes(siteId)) {
      continue;
    }
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function log(level, event, fields = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function normalizeText(value, maxLength) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
    : '';
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    siteAdmin: Boolean(user.siteAdmin),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  };
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) return false;
  const derived = Buffer.from(passwordHash(String(password ?? ''), user.salt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(value);
}

function validatePassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return [part, ''];
        const raw = part.slice(index + 1);
        try {
          return [part.slice(0, index), decodeURIComponent(raw)];
        } catch {
          return [part.slice(0, index), raw];
        }
      }),
  );
}

function backupLegacyFile() {
  if (!fs.existsSync(legacyJsonFile)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.copyFileSync(legacyJsonFile, path.join(dataDir, `app.json.corrupt-${stamp}`));
  } catch (error) {
    log('error', 'legacy_backup_failed', { message: error.message });
  }
}

async function acquireInstanceLock() {
  const lockFile = path.join(dataDir, 'instance.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(
        lockFile,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        { mode: 0o600, flag: 'wx' },
      );
      return async () => {
        try {
          const value = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
          if (value.pid === process.pid) await fsp.rm(lockFile, { force: true });
        } catch {
          // ignore
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
      } catch {
        existing = null;
      }
      let alive = false;
      if (Number.isInteger(existing?.pid)) {
        try {
          process.kill(existing.pid, 0);
          alive = true;
        } catch (probeError) {
          alive = probeError?.code === 'EPERM';
        }
      }
      if (alive) {
        throw new Error(
          `数据目录已被进程 ${existing.pid} 占用。SQLite 版本必须单实例运行。`,
        );
      }
      await fsp.rm(lockFile, { force: true });
    }
  }
  throw new Error('无法获取数据目录实例锁');
}

function validateCameraInput(body) {
  const name = normalizeText(body.name, 24);
  const zone = normalizeText(body.zone, 32);
  const protocol = ['none', 'hls', 'http', 'rtsp', 'edge'].includes(body.protocol)
    ? body.protocol
    : 'none';
  const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
  if (!name) return { error: '请填写点位名称' };
  if (!zone) return { error: '请填写所属区域' };
  if (protocol !== 'none') {
    if (!sourceUrl) return { error: '请填写视频流地址' };
    const valid =
      protocol === 'rtsp'
        ? /^rtsps?:\/\//i.test(sourceUrl)
        : protocol === 'edge'
          ? /^edge:\/\/[a-zA-Z0-9._/-]{1,200}$/i.test(sourceUrl)
          : /^https?:\/\//i.test(sourceUrl);
    if (!valid) {
      return {
        error:
          protocol === 'rtsp'
            ? 'RTSP 地址必须以 rtsp:// 或 rtsps:// 开头'
            : protocol === 'edge'
              ? '边缘网关地址格式应为 edge://网关名称/摄像头标识'
              : '网络视频地址必须以 http:// 或 https:// 开头',
      };
    }
    if (sourceUrl.length > 2048) return { error: '视频流地址过长' };
  }
  const detectSensitivity = ['low', 'standard', 'high'].includes(body.detectSensitivity)
    ? body.detectSensitivity
    : null;
  const detectRoi = parseRoi(
    Array.isArray(body.detectRoi) ? JSON.stringify(body.detectRoi) : body.detectRoi,
  );
  return {
    value: {
      name,
      zone,
      protocol,
      sourceUrl: protocol === 'none' ? '' : sourceUrl,
      enabled: body.enabled !== false,
      detectEnabled: body.detectEnabled !== false,
      detectSensitivity,
      detectRoi,
    },
  };
}

function cameraForClient(camera, user) {
  const hideUrl =
    (camera.protocol === 'rtsp' || camera.protocol === 'edge') &&
    user.role !== 'admin';
  return {
    id: camera.id,
    code: camera.code,
    name: camera.name,
    zone: camera.zone,
    siteId: camera.siteId || null,
    enabled: camera.enabled,
    detectEnabled: camera.detectEnabled !== false,
    detectSensitivity: camera.detectSensitivity ?? null,
    detectRoi: camera.detectRoi ?? [],
    protocol: camera.protocol,
    sourceUrl: hideUrl ? '' : camera.sourceUrl,
    hasSource: Boolean(camera.sourceUrl),
    streamUrl:
      camera.protocol === 'rtsp' || camera.protocol === 'edge'
        ? `/streams/${camera.id}/index.m3u8`
        : `/proxy/${camera.id}`,
    createdAt: camera.createdAt,
    updatedAt: camera.updatedAt,
  };
}

/** 通知渠道出参：不回传完整 URL / 密钥，只给来源提示。 */
function notifyChannelForClient(channel, siteName = null) {
  let urlHint = '地址无效';
  try {
    urlHint = new URL(channel.url).origin;
  } catch {
    urlHint = '地址无效';
  }
  return {
    id: channel.id,
    siteId: channel.siteId,
    siteName,
    kind: channel.kind,
    name: channel.name,
    urlHint,
    hasSecret: Boolean(channel.secret),
    enabled: channel.enabled,
    templateId: channel.templateId ?? null,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

/**
 * 通知渠道目标校验（SSRF 缓解）。
 * 永久拦截：169.254.0.0/16（链路本地/云元数据）与 0.0.0.0——任何部署形态都无正当用途。
 * 默认放行：环回（127/8、::1、localhost）与私网段（10/8、172.16/12、192.168/16、100.64/10）——
 *   内网部署的 Webhook 常在内网甚至本机（本地转发/自建接收端）。
 * 公网部署建议设 NOTIFY_BLOCK_PRIVATE=1：额外拦截环回、私网与 .local。
 */
function isBlockedNotifyHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return '主机名不能为空';
  const strict = process.env.NOTIFY_BLOCK_PRIVATE === '1';
  if (host === '0.0.0.0') return '不允许指向未指定地址';
  if (host === 'localhost' || host === '::1') {
    return strict ? '公网部署模式下不允许指向本机' : null;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 169 && b === 254) return '不允许指向链路本地地址（含云元数据）';
    if (a === 0) return '不允许指向未指定地址';
    if (!strict) return null;
    const privateOrLoopback =
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
    if (privateOrLoopback) return '公网部署模式下不允许指向私网或环回地址';
    return null;
  }
  if (strict && host.endsWith('.local')) {
    return '公网部署模式下不允许指向 .local';
  }
  return null;
}

function parseNotifyChannelInput(body, { partial = false } = {}) {
  const value = {};
  if (!partial || body.kind !== undefined) {
    if (!['webhook', 'wecom', 'dingtalk'].includes(body.kind)) {
      return { error: '通知类型必须是 webhook、wecom 或 dingtalk' };
    }
    value.kind = body.kind;
  }
  if (!partial || body.name !== undefined) {
    const name = normalizeText(body.name, 32);
    if (!name) return { error: '请填写渠道名称' };
    value.name = name;
  }
  if (!partial || body.url !== undefined) {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return { error: '请填写推送地址' };
    if (url.length > 2048) return { error: '推送地址过长' };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { error: '推送地址格式无效' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: '推送地址必须是 http:// 或 https://' };
    }
    const hostBlocked = isBlockedNotifyHost(parsed.hostname);
    if (hostBlocked) return { error: hostBlocked };
    value.url = url;
  }
  if (body.secret !== undefined) {
    value.secret = normalizeText(body.secret, 200);
  }
  if (body.enabled !== undefined) {
    value.enabled = body.enabled !== false;
  }
  if (body.siteId !== undefined) {
    value.siteId = normalizeText(String(body.siteId ?? ''), 64) || null;
  }
  if (!partial || body.templateId !== undefined) {
    const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
    value.templateId = templateId || null;
  }
  return { value };
}

// 管理员可见全部站点；operator/viewer 仅可见其被授权的站点（空数组=无权限）。
function allowedSiteIdsFor(user, store) {
  if (!user || user.role === 'admin') return null;
  return store.siteMemberSiteIds(user.id);
}

/** 非管理员只能操作自己被授权站点下的点位/告警。 */
function canAccessCameraSite(user, camera, store) {
  if (!camera) return true;
  const allowed = allowedSiteIdsFor(user, store);
  if (allowed === null) return true;
  return allowed.includes(camera.siteId || store.defaultSiteId);
}

function canAccessAlarmSite(user, alarm, store) {
  if (!alarm) return false;
  const allowed = allowedSiteIdsFor(user, store);
  if (allowed === null) return true;
  // 直接看告警自身的站点：点位被删除后仍能正确鉴权，且无站点归属的告警仅管理员可见。
  return Boolean(alarm.siteId) && allowed.includes(alarm.siteId);
}

function mapAlarmEvent(row) {
  return {
    id: row.id,
    alarmId: row.alarm_id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function mapAudit(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 128);
}

function parseSnapshot(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:image\/jpeg;base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new StreamError('抓拍格式必须是 JPEG data URL', { status: 400 });
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0 || buffer.length > maxSnapshotBytes) {
    throw new StreamError('抓拍图片过大或为空', { status: 413 });
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new StreamError('抓拍内容不是有效 JPEG 图片', { status: 400 });
  }
  return buffer;
}

/** 抓取一帧 JPEG 作为 ROI 编辑底图，失败返回 false。 */
function capturePreview(camera, target) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-y'];
    if (camera.protocol === 'rtsp') args.push('-rtsp_transport', 'tcp');
    args.push('-i', camera.sourceUrl, '-frames:v', '1', '-q:v', '4', '-an', target);
    let child;
    try {
      child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(false);
    }, 8_000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let exists = false;
      try {
        exists = fs.existsSync(target);
      } catch {
        exists = false;
      }
      finish(code === 0 && exists);
    });
  });
}

async function main() {
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(recordingsDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(previewDir, { recursive: true, mode: 0o700 });

  // 媒体磁盘水位：抓拍 + 短视频总量超过 MEDIA_MAX_BYTES 时自动清理（0 关闭）。
  const mediaMaxBytes =
    Number(process.env.MEDIA_MAX_BYTES) > 0
      ? Number(process.env.MEDIA_MAX_BYTES)
      : 2 * 1024 * 1024 * 1024;
  let mediaUsageCache = {
    at: 0,
    snapshots: { files: 0, bytes: 0 },
    recordings: { files: 0, bytes: 0 },
  };
  const scanMediaDir = async (dir) => {
    let files = 0;
    let bytes = 0;
    try {
      const entries = await fsp.readdir(dir);
      for (const name of entries) {
        try {
          const stat = await fsp.stat(path.join(dir, name));
          if (stat.isFile()) {
            files += 1;
            bytes += stat.size;
          }
        } catch {
          // 扫描间隙文件可能被删除
        }
      }
    } catch {
      // 目录不存在视为空
    }
    return { files, bytes };
  };
  const computeMediaUsage = async (force = false) => {
    if (!force && Date.now() - mediaUsageCache.at < 5 * 60_000) return mediaUsageCache;
    const [snapshots, recordings] = await Promise.all([
      scanMediaDir(snapshotDir),
      scanMediaDir(recordingsDir),
    ]);
    mediaUsageCache = { at: Date.now(), snapshots, recordings };
    return mediaUsageCache;
  };
  const releaseLock = await acquireInstanceLock();
  let store;
  let streamManager;
  let notifier;
  let detectionEngine;
  let detectionTimer;
  let offlineTimer;
  let retentionTimer;
  let escalationTimer;
  let summaryTimer;
  let mediaTimer;
  let backupTimer;

  try {
    const dbExists = fs.existsSync(databaseFile);
    let legacyData = null;
    if (!dbExists && fs.existsSync(legacyJsonFile)) {
      try {
        legacyData = JSON.parse(await fsp.readFile(legacyJsonFile, 'utf8'));
      } catch (error) {
        backupLegacyFile();
        throw new Error(
          `旧数据库 app.json 损坏，已保留副本，拒绝自动重建：${error.message}`,
        );
      }
    }

    const sessionSecret = await loadSessionSecret(dataDir, legacyData?.sessionSecret);
    const edgeGatewayToken = await loadEdgeToken(dataDir);
    const credentialKey = await loadCredentialKey(dataDir, {
      createIfMissing: !dbExists,
    });
    const secretBox = new SecretBox(credentialKey);
    store = await openStore({ dataDir, secretBox, legacyData });
    if (!store.health()) throw new Error('SQLite 健康检查失败');
    // 提前触发凭据解密，避免服务启动后首个点位请求才暴露密钥错误。
    store.listCameras();
    if (fs.existsSync(legacyJsonFile)) {
      try {
        await store.backup();
        const rawLegacy = await fsp.readFile(legacyJsonFile, 'utf8');
        const encryptedLegacy = secretBox.encrypt(rawLegacy);
        await fsp.writeFile(path.join(dataDir, 'app.json.migrated.enc'), encryptedLegacy, {
          mode: 0o600,
        });
        await fsp.rm(legacyJsonFile, { force: true });
        log('info', 'legacy_migrated', { encryptedArchive: 'app.json.migrated.enc' });
      } catch (error) {
        log('warn', 'legacy_cleanup_failed', {
          message: '旧 app.json 可能仍含明文凭据，请手动加密或删除',
          error: error.message,
        });
      }
    }

    streamManager = new StreamManager({
      dataDir,
      maxStreams: Number(process.env.MAX_CONCURRENT_STREAMS || 8),
      logger: {
        warn: (event, fields) => log('warn', event, fields),
        info: (event, fields) => log('info', event, fields),
      },
    });
    if (!streamManager.init()) {
      log('warn', 'ffmpeg_missing', {
        message: '未找到 FFmpeg，RTSP 点位将无法转码',
      });
    }
    const ffprobeOk = ffprobeAvailable();
    if (!ffprobeOk) {
      log('warn', 'ffprobe_missing', {
        message: '未找到 FFprobe，一键测流功能不可用',
      });
    }

    // 本地演示视频源：没有真实摄像头时也能跑通完整闭环（播放/识别/告警/推送）。
    const demoSource = new DemoSource({
      dataDir,
      logger: {
        warn: (message) => log('warn', 'demo_source', { message }),
        info: (message) => log('info', 'demo_source', { message }),
      },
    });
    if (!demoSource.init()) {
      log('info', 'demo_source_disabled', { message: '未找到 FFmpeg，演示模式不可用' });
    }
    // 演示点位只在演示运行期间存在：进程重启后旧记录的地址必然失效，直接清理。
    for (const camera of store.listCameras()) {
      if (camera.code === DEMO_CAMERA_CODE) {
        store.deleteCamera(camera.id);
        streamManager.stop(camera.id);
      }
    }
    await fsp.rm(demoSource.directory, { recursive: true, force: true });

    // 演示点位 id 台账：点位删除后历史告警仍可按 id 识别为演示数据。
    const DEMO_CAMERA_IDS_KEY = 'demo_camera_ids';
    const demoCameraIds = () => {
      try {
        const raw = store.getMeta(DEMO_CAMERA_IDS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
      } catch {
        return [];
      }
    };
    const rememberDemoCameraId = (cameraId) => {
      const ids = [...new Set([...demoCameraIds(), cameraId])].slice(-50);
      store.setMeta(DEMO_CAMERA_IDS_KEY, JSON.stringify(ids));
    };
    const demoPurgeFilter = () => ({
      cameraIds: demoCameraIds(),
      cameraName: DEMO_CAMERA_NAME,
    });

    notifier = new Notifier({
      store,
      logger: {
        warn: (message) => log('warn', 'notify', { message }),
        info: (message) => log('info', 'notify', { message }),
      },
    });

    // 服务端 7×24 火焰/烟雾识别：浏览器关闭时仍可持续巡检。
    detectionEngine = new DetectionEngine({
      store,
      snapshotDir,
      recordingsDir,
      enabled: process.env.SERVER_DETECTION !== '0',
      // 演示点位记录的是站内相对地址，服务端解码时补成回环绝对地址。
      resolveSourceUrl: (url) =>
        typeof url === 'string' && url.startsWith('/')
          ? `http://127.0.0.1:${port}${url}`
          : url,
      logger: {
        warn: (message) => log('warn', 'server_detection', { message }),
        info: (message) => log('info', 'server_detection', { message }),
      },
      onClip: (alarm, camera) => {
        store.recordAudit({
          action: 'alarm.clip',
          targetType: 'alarm',
          targetId: alarm.id,
          detail: `${camera.code} 短视频已生成`,
          ip: 'server-detector',
        });
        broadcastEvent('alarm.updated', { alarm }, alarm.siteId);
      },
      onAlarm: (alarm, camera) => {
        metrics.alarmsCreated += 1;
        store.recordAudit({
          action: 'alarm.create',
          targetType: 'alarm',
          targetId: alarm.id,
          detail: `${camera.code} ${alarm.level}（服务端识别）`,
          ip: 'server-detector',
        });
        broadcastEvent('alarm.created', { alarm }, alarm.siteId);
        void notifier
          ?.notifyAlarm(alarm, 'created', { camera })
          .catch(() => undefined);
      },
    });
    detectionEngine.init();
    log('info', 'server_detection_ready', {
      active: detectionEngine.active,
      fps: detectionEngine.fps,
      sensitivity: detectionEngine.sensitivity,
      size: `${detectionEngine.width}x${detectionEngine.height}`,
    });
    detectionEngine.sync(store.listCameras());
    // 定时对齐点位变化（启用/停用、改地址、改站点），避免逐路由埋点。
    detectionTimer = setInterval(syncDetection, 20_000);
    detectionTimer.unref?.();

    function syncDetection() {
      try {
        detectionEngine?.sync(store.listCameras());
      } catch (error) {
        log('warn', 'server_detection_sync_failed', { error: error.message });
      }
    }

    // 离线巡检：worker 超过阈值没有新帧即生成离线告警；画面恢复后自动归档。
    const offlineTimeoutMs = Number(process.env.OFFLINE_TIMEOUT_MS) || 60_000;
    const offlineActor = { id: null, username: 'server-monitor' };
    const offlineCheck = () => {
      if (!detectionEngine?.active) return;
      const cameras = new Map(store.listCameras().map((camera) => [camera.id, camera]));
      const now = Date.now();
      for (const worker of detectionEngine.status().cameras) {
        const camera = cameras.get(worker.cameraId);
        if (!camera) continue;
        const active = store.activeAlarmForCamera(camera.id);
        const reference = worker.lastFrameAt || worker.startedAt;
        const stale = !reference || now - reference > offlineTimeoutMs;
        if (stale) {
          if (active) continue;
          try {
            const alarm = store.createAlarm({
              id: crypto.randomUUID(),
              cameraId: camera.id,
              cameraName: camera.name,
              zone: camera.zone,
              siteId: camera.siteId || store.defaultSiteId,
              level: 'offline',
              confidence: 0,
              hotspot: { x: 50, y: 50 },
              actor: offlineActor,
              eventDetail: `${offlineTimeoutMs / 1000}s 内未收到视频帧`,
            });
            store.recordAudit({
              action: 'alarm.create',
              targetType: 'alarm',
              targetId: alarm.id,
              detail: `${camera.code} offline（离线巡检）`,
              ip: 'server-monitor',
            });
            broadcastEvent('alarm.created', { alarm }, alarm.siteId);
            void notifier
              ?.notifyAlarm(alarm, 'created', { camera })
              .catch(() => undefined);
            log('warn', 'camera_offline', { cameraId: camera.id, code: camera.code });
          } catch (error) {
            log('warn', 'camera_offline_alarm_failed', {
              cameraId: camera.id,
              error: error.message,
            });
          }
        } else if (active && active.level === 'offline') {
          try {
            const updated = store.updateAlarm(
              active.id,
              { status: 'archived', archivedAt: now },
              offlineActor,
            );
            store.addAlarmEvent(active.id, offlineActor, 'archived', '视频流恢复，自动归档');
            broadcastEvent('alarm.updated', { alarm: updated }, updated.siteId);
            void notifier
              ?.notifyAlarm(updated, 'recovered', { camera })
              .catch(() => undefined);
            log('info', 'camera_recovered', { cameraId: camera.id, code: camera.code });
          } catch (error) {
            log('warn', 'camera_recover_failed', {
              cameraId: camera.id,
              error: error.message,
            });
          }
        }
      }
    };
    const offlineCheckEveryMs =
      Number(process.env.OFFLINE_CHECK_INTERVAL_MS) || 15_000;
    offlineTimer = setInterval(offlineCheck, offlineCheckEveryMs);
    offlineTimer.unref?.();
    setTimeout(offlineCheck, Math.min(8_000, offlineCheckEveryMs)).unref?.();

    // 数据保留：清理超期的已关闭告警、抓拍/短视频、推送日志与审计日志。
    const alarmRetentionDays = Number(process.env.ALARM_RETENTION_DAYS) || 180;
    const notifyRetentionDays = Number(process.env.NOTIFY_RETENTION_DAYS) || 30;
    const auditRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS) || 180;
    const retentionRun = async () => {
      try {
        const result = store.pruneAlarms({ retainDays: alarmRetentionDays });
        for (const file of result.snapshots) {
          await fsp.rm(path.join(snapshotDir, path.basename(file)), { force: true });
        }
        for (const file of result.clips) {
          await fsp.rm(path.join(recordingsDir, path.basename(file)), { force: true });
        }
        const logs = store.pruneNotificationLogs(notifyRetentionDays);
        const auditLogs = store.pruneAuditLogsByAge(auditRetentionDays);
        if (result.deleted || logs || auditLogs) {
          log('info', 'retention_applied', {
            alarms: result.deleted,
            alarmEvents: result.events ?? 0,
            snapshots: result.snapshots.length,
            clips: result.clips.length,
            notifyLogs: logs,
            auditLogs,
            alarmRetentionDays,
            notifyRetentionDays,
            auditRetentionDays,
          });
        }
      } catch (error) {
        log('warn', 'retention_failed', { error: error.message });
      }
    };
    retentionTimer = setInterval(() => void retentionRun(), 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
    setTimeout(() => void retentionRun(), 90_000).unref?.();

    // 磁盘水位：抓拍 + 短视频超过上限时，从最老的已关闭告警开始清媒体（保留记录）。
    const enforceMediaWatermark = async () => {
      if (!(mediaMaxBytes > 0)) return;
      const usage = await computeMediaUsage(true);
      let over = usage.snapshots.bytes + usage.recordings.bytes - mediaMaxBytes;
      if (over <= 0) return;
      let prunedFiles = 0;
      let prunedAlarms = 0;
      for (let round = 0; round < 20 && over > 0; round += 1) {
        const cleared = store.clearOldestAlarmMedia(100);
        if (cleared.files.length === 0) break;
        for (const file of cleared.files) {
          const target = path.join(
            String(file).toLowerCase().endsWith('.mp4') ? recordingsDir : snapshotDir,
            path.basename(file),
          );
          try {
            const stat = await fsp.stat(target).catch(() => null);
            await fsp.rm(target, { force: true });
            if (stat) over -= stat.size;
            prunedFiles += 1;
          } catch {
            // ignore
          }
        }
        prunedAlarms += cleared.alarms;
        await computeMediaUsage(true);
      }
      if (prunedFiles > 0) {
        log('warn', 'media_watermark_pruned', {
          prunedFiles,
          prunedAlarms,
          mediaMaxBytes,
        });
      }
    };
    mediaTimer = setInterval(() => void enforceMediaWatermark(), 10 * 60_000);
    mediaTimer.unref?.();
    setTimeout(() => void enforceMediaWatermark(), 30_000).unref?.();

    // 告警升级：超过 N 分钟仍未确认的告警再推一次，避免值班员漏看后沉底。
    const escalationMinutes = Number(process.env.ESCALATION_MINUTES ?? 5);
    const escalationIntervalMs =
      Number(process.env.ESCALATION_CHECK_INTERVAL_MS) || 60_000;
    const escalationInFlight = new Set();
    const escalationCheck = () => {
      if (!Number.isFinite(escalationMinutes) || escalationMinutes <= 0) return;
      const cutoff = Date.now() - escalationMinutes * 60_000;
      let pending = [];
      try {
        pending = store.listPendingAlarmsOlderThan(cutoff);
      } catch (error) {
        log('warn', 'escalation_query_failed', { error: error.message });
        return;
      }
      for (const alarm of pending) {
        if (escalationInFlight.has(alarm.id)) continue;
        try {
          if (store.hasAlarmEvent(alarm.id, 'escalated')) continue;
        } catch {
          continue;
        }
        escalationInFlight.add(alarm.id);
        const camera = store.getCamera(alarm.cameraId);
        void notifier
          ?.notifyAlarm(alarm, 'escalated', { camera, minutes: escalationMinutes })
          .then((result) => {
            if (!result || (result.sent === 0 && result.failed === 0)) return;
            store.addAlarmEvent(
              alarm.id,
              { id: null, username: 'server-monitor' },
              'escalated',
              `超过 ${escalationMinutes} 分钟未确认，已升级通知`,
            );
            log('warn', 'alarm_escalated', {
              alarmId: alarm.id,
              cameraId: alarm.cameraId,
              sent: result.sent,
              failed: result.failed,
            });
          })
          .catch(() => undefined)
          .finally(() => escalationInFlight.delete(alarm.id));
      }
    };
    escalationTimer = setInterval(escalationCheck, escalationIntervalMs);
    escalationTimer.unref?.();
    setTimeout(escalationCheck, Math.min(15_000, escalationIntervalMs)).unref?.();

    // 每日值守摘要：固定时间把昨日告警统计推送到通知渠道（DAILY_SUMMARY_AT 为空时关闭）。
    const summaryAt = normalizeText(process.env.DAILY_SUMMARY_AT ?? '08:00', 5);
    const summaryForce = process.env.DAILY_SUMMARY_FORCE === '1';
    const pad2 = (value) => String(value).padStart(2, '0');
    const shanghaiParts = (ts) => {
      const shifted = new Date(ts + 8 * 3600 * 1000);
      return {
        y: shifted.getUTCFullYear(),
        m: shifted.getUTCMonth() + 1,
        d: shifted.getUTCDate(),
        hh: shifted.getUTCHours(),
        mm: shifted.getUTCMinutes(),
      };
    };
    const shanghaiDayStart = (parts) =>
      Date.UTC(parts.y, parts.m - 1, parts.d) - 8 * 3600 * 1000;
    const summaryLevelNames = { fire: '火焰', smoke: '烟雾', offline: '设备离线' };
    const dailySummaryCheck = () => {
      if (!summaryAt || !notifier) return;
      const nowParts = shanghaiParts(Date.now());
      const runKey = `${nowParts.y}-${pad2(nowParts.m)}-${pad2(nowParts.d)}`;
      if (store.getMeta('daily_summary_last') === runKey && !summaryForce) return;
      if (!summaryForce) {
        const [hh, mm] = summaryAt.split(':').map((value) => Number(value));
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
        if (nowParts.hh !== hh || nowParts.mm !== mm) return;
      }
      const windowEnd = Date.now();
      const windowStart = windowEnd - 24 * 3600 * 1000;
      const startParts = shanghaiParts(windowStart);
      const endParts = shanghaiParts(windowEnd);
      const dateKey = runKey;
      const rows = store.alarmStatsBetween(windowStart, windowEnd);
      const byLevel = { fire: 0, smoke: 0, offline: 0 };
      const byStatus = { pending: 0, confirmed: 0, false: 0, archived: 0 };
      const bySite = new Map();
      let total = 0;
      for (const row of rows) {
        const siteId = row.siteId || store.defaultSiteId;
        const bucket = bySite.get(siteId) ?? { total: 0, levels: {} };
        byLevel[row.level] = (byLevel[row.level] ?? 0) + row.count;
        byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
        bucket.total += row.count;
        bucket.levels[row.level] = (bucket.levels[row.level] ?? 0) + row.count;
        bySite.set(siteId, bucket);
        total += row.count;
      }
      const lines = [`### 值守摘要（近 24 小时）`];
      lines.push(
        `> 统计区间：${pad2(startParts.m)}-${pad2(startParts.d)} ${pad2(startParts.hh)}:${pad2(startParts.mm)} ~ ${pad2(endParts.m)}-${pad2(endParts.d)} ${pad2(endParts.hh)}:${pad2(endParts.mm)}`,
      );
      lines.push(
        `> 告警总数：${total}（火焰 ${byLevel.fire} · 烟雾 ${byLevel.smoke} · 设备离线 ${byLevel.offline}）`,
      );
      lines.push(
        `> 已确认 ${byStatus.confirmed} · 判定误报 ${byStatus.false} · 仍待处置 ${byStatus.pending}`,
      );
      for (const [siteId, bucket] of bySite.entries()) {
        const name = store.getSite(siteId)?.name ?? '未归属站点';
        const detail = Object.entries(bucket.levels)
          .map(([level, count]) => `${summaryLevelNames[level] ?? level} ${count}`)
          .join(' · ');
        lines.push(`> ${name}：${bucket.total} 条${detail ? `（${detail}）` : ''}`);
      }
      lines.push('> 请登录平台查看处置详情。');
      const message = lines.join('\n');
      const channels = store.listNotifyChannels().filter((channel) => channel.enabled);
      void notifier
        .notifyBroadcast(
          'summary',
          {
            key: `summary-${dateKey}`,
            message,
            data: { date: dateKey, total, byLevel, byStatus },
          },
          channels,
        )
        .then((result) => {
          store.setMeta('daily_summary_last', runKey);
          log('info', 'daily_summary_sent', { date: dateKey, ...result });
        })
        .catch((error) => {
          log('warn', 'daily_summary_failed', { error: error.message });
        });
    };
    summaryTimer = setInterval(() => dailySummaryCheck(), 60_000);
    summaryTimer.unref?.();
    if (summaryForce) {
      // 仅用于测试/演练：启动后强制跑一次昨日摘要，给调用方留出灌数据的时间。
      setTimeout(() => dailySummaryCheck(), 4_000).unref?.();
    }
    const edgeHub = new EdgeHub({
      token: edgeGatewayToken,
      logger: {
        info: (event, fields) => log('info', event, fields),
        warn: (event, fields) => log('warn', event, fields),
      },
    });
    if (!edgeHub.enabled) {
      log('info', 'edge_gateway_disabled', {
        message: '未配置 EDGE_GATEWAY_TOKEN，现场网关隧道未启用',
      });
    }

    const app = express();
    app.disable('x-powered-by');
    if (process.env.TRUST_PROXY) {
      const value = process.env.TRUST_PROXY;
      app.set(
        'trust proxy',
        value === 'true' ? 1 : /^\d+$/.test(value) ? Number(value) : value,
      );
    }

    app.use((req, res, next) => {
      const start = Date.now();
      metrics.requests += 1;
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob: http: https:",
          "connect-src 'self' http: https: ws: wss:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'self'",
        ].join('; '),
      );
      if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
      }
      res.on('finish', () => {
        if (
          req.path.startsWith('/api/') &&
          !req.path.includes('/snapshot') &&
          !req.path.startsWith('/streams/')
        ) {
          log('info', 'request', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Date.now() - start,
            ip: clientIp(req),
          });
        }
      });
      next();
    });

    app.use('/api', (req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      if (req.get('x-requested-with') !== 'flame-vision') {
        return res.status(403).json({ error: '缺少请求校验头' });
      }
      const origin = req.get('origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('host')) {
            return res.status(403).json({ error: '跨站请求已被拒绝' });
          }
        } catch {
          return res.status(403).json({ error: '请求来源无效' });
        }
      }
      next();
    });
    app.use(express.json({ limit: '2mb' }));

    const {
      sessionSignature,
      createSessionToken,
      readSessionToken,
      currentUser,
      setSessionCookie,
      clearSessionCookie,
      checkLoginBlocked,
      recordLoginFailure,
    } = createSession({
      store,
      sessionSecret,
      sessionCookie,
      sessionLifetimeSeconds,
      metrics,
      parseCookies,
    });

    const {
      requireAuth,
      requireRole,
      requireManager,
      adminSiteIdsFor,
      canManageSite,
      canManageCamera,
      isManager,
      fallbackSiteIdFor,
    } = createGuards(store, currentUser);

    let setupInFlight = false;

    app.get('/healthz', async (_req, res) => {
      const databaseOk = store.health();
      let diskFreeBytes = null;
      try {
        const stats = await fsp.statfs(dataDir);
        diskFreeBytes = Number(stats.bfree) * Number(stats.bsize);
      } catch {
        diskFreeBytes = null;
      }
      const diskOk = diskFreeBytes === null || diskFreeBytes > 50 * 1024 * 1024;
      const ok = databaseOk && streamManager.ffmpegAvailable && diskOk;
      res.status(ok ? 200 : 503).json({
        ok,
        database: databaseOk,
        ffmpeg: streamManager.ffmpegAvailable,
        ffprobe: ffprobeOk,
        diskOk,
        diskFreeBytes,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
    });

    app.get('/api/auth/status', (req, res) => {
      const user = currentUser(req);
      res.json({
        needsSetup: store.needsSetup,
        authenticated: Boolean(user),
        user: user ? publicUser(user) : null,
      });
    });

    app.post('/api/setup', async (req, res) => {
      if (setupInFlight || !store.needsSetup || store.setupComplete) {
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
      setupInFlight = true;
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
        setupInFlight = false;
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

    function findDemoCamera() {
      return store.listCameras().find((camera) => camera.code === DEMO_CAMERA_CODE) ?? null;
    }

    // 演示模式：用 FFmpeg 合成一段火焰直播流并自动注册「演示点位」，
    // 无需任何真实摄像头即可验证播放、识别、告警、抓拍与推送闭环。
    app.get('/api/demo/status', requireAuth, requireRole('admin'), (_req, res) => {
      const camera = findDemoCamera();
      res.json({
        ...demoSource.status(),
        purgeable: store.countDemoAlarms(demoPurgeFilter()),
        camera: camera
          ? { id: camera.id, code: camera.code, name: camera.name, streamUrl: camera.sourceUrl }
          : null,
      });
    });

    app.post('/api/demo/start', requireAuth, requireRole('admin'), async (req, res) => {
      try {
        const state = await demoSource.start();
        const sourceUrl = state.playlistUrl;
        const siteId =
          normalizeText(String(req.body?.siteId ?? ''), 64) || store.defaultSiteId;
        const existing = findDemoCamera();
        let camera = existing;
        if (existing) {
          camera = store.updateCamera(existing.id, {
            name: DEMO_CAMERA_NAME,
            zone: DEMO_CAMERA_ZONE,
            protocol: 'hls',
            sourceUrl,
            siteId,
            enabled: true,
            detectEnabled: true,
            updatedAt: Date.now(),
          });
        } else {
          camera = store.createCamera({
            id: crypto.randomUUID(),
            code: DEMO_CAMERA_CODE,
            name: DEMO_CAMERA_NAME,
            zone: DEMO_CAMERA_ZONE,
            protocol: 'hls',
            sourceUrl,
            siteId,
            enabled: true,
            detectEnabled: true,
            detectSensitivity: 'standard',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        syncDetection();
        rememberDemoCameraId(camera.id);
        store.recordAudit({
          user: req.user,
          action: 'demo.start',
          targetType: 'camera',
          targetId: camera.id,
          detail: `${camera.code} 演示视频源已启动`,
          ip: clientIp(req),
        });
        res.json({
          ...demoSource.status(),
          purgeable: store.countDemoAlarms(demoPurgeFilter()),
          camera: {
            id: camera.id,
            code: camera.code,
            name: camera.name,
            streamUrl: camera.sourceUrl,
          },
        });
      } catch (error) {
        const demoError =
          error instanceof DemoSourceError
            ? error
            : new DemoSourceError(
                error instanceof Error ? error.message : '演示视频源启动失败',
              );
        res.status(demoError.status).json({ error: demoError.message });
      }
    });

    app.post('/api/demo/stop', requireAuth, requireRole('admin'), (req, res) => {
      demoSource.stop();
      const existing = findDemoCamera();
      let removed = false;
      if (existing) {
        store.deleteCamera(existing.id);
        streamManager.stop(existing.id);
        detectionEngine.stop(existing.id);
        removed = true;
      }
      syncDetection();
      if (removed) {
        store.recordAudit({
          user: req.user,
          action: 'demo.stop',
          targetType: 'camera',
          targetId: existing.id,
          detail: `${existing.code} 演示视频源已停止`,
          ip: clientIp(req),
        });
      }
      res.json({ ...demoSource.status(), camera: null, removed });
    });

    // 一键清除演示数据：删演示告警及其事件、推送日志与媒体文件。
    // 审计日志保留（操作留痕）；真实告警与点位不受影响。演示运行中也可安全执行。
    app.post('/api/demo/purge', requireAuth, requireRole('admin'), async (req, res) => {
      const filter = demoPurgeFilter();
      const before = store.countDemoAlarms(filter);
      if (!before.alarms) {
        return res.json({ removed: 0, purgeable: before });
      }
      const result = store.purgeDemoAlarms(filter);
      const removeMedia = async (files, dir) => {
        let removed = 0;
        for (const file of files) {
          try {
            await fsp.rm(path.join(dir, path.basename(file)), { force: true });
            removed += 1;
          } catch {
            // 文件缺失不阻断
          }
        }
        return removed;
      };
      const filesRemoved =
        (await removeMedia(result.snapshots, snapshotDir)) +
        (await removeMedia(result.clips, recordingsDir));
      store.recordAudit({
        user: req.user,
        action: 'demo.purge',
        targetType: 'system',
        detail: `清除演示告警 ${result.deleted} 条、媒体 ${filesRemoved} 个、事件 ${result.events} 条、推送日志 ${result.notifications} 条`,
        ip: clientIp(req),
      });
      log('info', 'demo_purged', {
        alarms: result.deleted,
        files: filesRemoved,
        events: result.events,
        notifications: result.notifications,
      });
      res.json({
        removed: result.deleted,
        filesRemoved,
        events: result.events,
        notifications: result.notifications,
        purgeable: store.countDemoAlarms(filter),
      });
    });

    app.get('/api/system', requireAuth, requireRole('admin'), async (req, res) => {
      const usage = await computeMediaUsage();
      const dbStat = await fsp.stat(databaseFile).catch(() => null);
      res.json({
        ffmpegAvailable: streamManager.ffmpegAvailable,
        ffprobeAvailable: ffprobeOk,
        nodeVersion: process.version,
        maxConcurrentStreams: streamManager.maxStreams,
        activeStreams: streamManager.activeCount(),
        database: 'sqlite',
        schemaVersion: store.schemaVersion,
        detection: detectionEngine.status(),
        storage: {
          dbBytes: dbStat?.size ?? 0,
          snapshots: usage.snapshots,
          recordings: usage.recordings,
          mediaBytes: usage.snapshots.bytes + usage.recordings.bytes,
          mediaMaxBytes,
        },
      });
    });

    app.get('/api/detection/status', requireAuth, requireRole('admin'), (_req, res) => {
      res.json(detectionEngine.status());
    });

    app.get('/api/edge/status', requireAuth, requireRole('admin'), (_req, res) => {
      res.json({
        enabled: edgeHub.enabled,
        gateways: edgeHub.status(),
        pairingToken: edgeGatewayToken,
      });
    });

    // 跨域 HLS/HTTP 视频代理：浏览器只连中心，解决跨域无法读帧识别的问题。
    // 仅允许代理与该点位已配置源站同源的资源，杜绝被当作通用代理（SSRF）。
    app.all(/^\/proxy\/(?<cameraId>[^/]+)(?:\/(?<tail>.*))?$/, requireAuth, async (req, res) => {
      const cameraId = req.params.cameraId;
      const tail = req.params.tail || '';
      const camera = store.getCamera(cameraId);
      if (
        !camera ||
        (camera.protocol !== 'hls' && camera.protocol !== 'http') ||
        !canAccessCameraSite(req.user, camera, store)
      ) {
        return res.status(404).json({ error: '该点位不支持代理取流或不存在' });
      }
      let targetUrl;
      if (!tail) {
        targetUrl = camera.sourceUrl;
      } else {
        try {
          targetUrl = Buffer.from(tail, 'base64url').toString('utf8');
        } catch {
          return res.status(400).json({ error: '代理路径格式错误' });
        }
      }
      let parsed;
      let baseOrigin;
      try {
        parsed = new URL(targetUrl);
        baseOrigin = new URL(camera.sourceUrl).origin;
      } catch {
        return res.status(400).json({ error: '视频源地址无效' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: '仅支持 http/https 视频源' });
      }
      if (parsed.origin !== baseOrigin) {
        return res.status(403).json({ error: '禁止代理非同源视频源' });
      }
      const upstreamHeaders = {};
      if (req.headers.range) upstreamHeaders.Range = req.headers.range;
      try {
        const upstream = await fetch(parsed, {
          method: req.method === 'HEAD' ? 'GET' : req.method,
          headers: upstreamHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const contentType = upstream.headers.get('content-type') || '';
        const isPlaylist =
          contentType.includes('mpegurl') ||
          contentType.includes('x-mpegurl') ||
          targetUrl.endsWith('.m3u8') ||
          targetUrl.endsWith('.m3u');
        const arrayBuf = await upstream.arrayBuffer();
        if (isPlaylist) {
          const text = Buffer.from(arrayBuf).toString('utf8');
          const rewritten = text
            .split('\n')
            .map((line) => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) return line;
              let absolute;
              try {
                absolute = new URL(trimmed, `${baseOrigin}/`).href;
              } catch {
                return line;
              }
              return `/proxy/${cameraId}/${Buffer.from(absolute).toString('base64url')}`;
            })
            .join('\n');
          res.status(upstream.status === 206 ? 200 : upstream.status);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-store');
          res.send(rewritten);
          return;
        }
        res.status(upstream.status);
        for (const header of [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
        ]) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        if (upstream.status === 200 || upstream.status === 206) {
          res.setHeader('Accept-Ranges', 'bytes');
        }
        res.send(Buffer.from(arrayBuf));
      } catch {
        log('warn', 'proxy_upstream_failed', {
          cameraId,
          message: '代理上游视频源失败',
        });
        res.status(502).json({ error: '视频源无法访问或响应超时' });
      }
    });

    app.get('/api/users', requireAuth, requireRole('admin'), (_req, res) => {
      res.json({ users: store.listUsers().map(publicUser) });
    });

    app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
      const username = normalizeText(req.body.username, 32);
      const displayName = normalizeText(req.body.displayName, 32) || username;
      const role = ['admin', 'operator', 'viewer'].includes(req.body.role)
        ? req.body.role
        : 'viewer';
      if (!validUsername(username)) {
        return res.status(400).json({ error: '用户名需为 3-32 位字母、数字、点、横线或下划线' });
      }
      if (store.getUserByUsername(username)) {
        return res.status(409).json({ error: '用户名已存在' });
      }
      if (!validatePassword(req.body.password)) {
        return res.status(400).json({ error: '密码至少需要 8 位' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const user = store.createUser({
        id: crypto.randomUUID(),
        username,
        displayName,
        role,
        siteAdmin: role !== 'admin' && req.body.siteAdmin === true,
        salt,
        passwordHash: passwordHash(req.body.password, salt),
        disabled: false,
        tokenVersion: 0,
        createdAt: Date.now(),
      });
      store.recordAudit({
        user: req.user,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        detail: `创建 ${role} 账号 ${username}`,
        ip: clientIp(req),
      });
      res.status(201).json({ user: publicUser(user) });
    });

    app.patch('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
      const user = store.getUser(req.params.id);
      if (!user) return res.status(404).json({ error: '账号不存在' });
      if (req.body.role !== undefined) {
        if (!['admin', 'operator', 'viewer'].includes(req.body.role)) {
          return res.status(400).json({ error: '角色无效' });
        }
        if (
          user.role === 'admin' &&
          req.body.role !== 'admin' &&
          store.countActiveAdmins() <= 1
        ) {
          return res.status(400).json({ error: '必须保留至少一个可用管理员' });
        }
      }
      if (req.body.disabled !== undefined) {
        if (user.id === req.user.id && req.body.disabled) {
          return res.status(400).json({ error: '不能停用当前登录账号' });
        }
        if (user.role === 'admin' && req.body.disabled && store.countActiveAdmins() <= 1) {
          return res.status(400).json({ error: '必须保留至少一个可用管理员' });
        }
      }
      const nextRole = req.body.role ?? user.role;
      if (req.body.siteAdmin === true && nextRole === 'admin') {
        return res.status(400).json({ error: '全局管理员无需设置为站点管理员' });
      }
      let newSalt;
      let newHash;
      if (req.body.password !== undefined) {
        if (!validatePassword(req.body.password)) {
          return res.status(400).json({ error: '密码至少需要 8 位' });
        }
        newSalt = crypto.randomBytes(16).toString('hex');
        newHash = passwordHash(req.body.password, newSalt);
      }
      const updated = store.updateUser(user.id, {
        displayName:
          req.body.displayName !== undefined
            ? normalizeText(req.body.displayName, 32) || user.displayName
            : undefined,
        role: req.body.role,
        disabled:
          req.body.disabled !== undefined ? Boolean(req.body.disabled) : undefined,
        siteAdmin:
          req.body.siteAdmin !== undefined
            ? nextRole !== 'admin' && Boolean(req.body.siteAdmin)
            : undefined,
        salt: newSalt,
        passwordHash: newHash,
      });
      store.recordAudit({
        user: req.user,
        action: 'user.update',
        targetType: 'user',
        targetId: user.id,
        detail: [
          req.body.role ? `role=${req.body.role}` : '',
          req.body.siteAdmin !== undefined
            ? `siteAdmin=${Boolean(req.body.siteAdmin)}`
            : '',
          req.body.disabled !== undefined ? `disabled=${Boolean(req.body.disabled)}` : '',
          req.body.password ? 'password-reset' : '',
        ]
          .filter(Boolean)
          .join(' '),
        ip: clientIp(req),
      });
      res.json({ user: publicUser(updated) });
    });

    app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
      const user = store.getUser(req.params.id);
      if (!user) return res.status(404).json({ error: '账号不存在' });
      if (user.id === req.user.id) return res.status(400).json({ error: '不能删除当前账号' });
      if (user.role === 'admin' && store.countActiveAdmins() <= 1) {
        return res.status(400).json({ error: '必须保留至少一个管理员' });
      }
      store.deleteUser(user.id);
      store.recordAudit({
        user: req.user,
        action: 'user.delete',
        targetType: 'user',
        targetId: user.id,
        detail: `删除账号 ${user.username}`,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    });

    // ---------------- 站点（多租户/分组） ----------------
    registerSiteRoutes(app, {
      store,
      allowedSiteIdsFor,
      requireAuth,
      requireRole,
      requireManager,
      canManageSite,
      normalizeText,
      clientIp,
    });
    app.get('/api/users/:id/sites', requireAuth, requireRole('admin'), (req, res) => {
      const user = store.getUser(req.params.id);
      if (!user) return res.status(404).json({ error: '账号不存在' });
      res.json({ siteIds: store.siteMemberSiteIds(user.id), sites: store.listSites() });
    });

    app.put('/api/users/:id/sites', requireAuth, requireRole('admin'), (req, res) => {
      const user = store.getUser(req.params.id);
      if (!user) return res.status(404).json({ error: '账号不存在' });
      if (user.role === 'admin') {
        return res.status(400).json({ error: '管理员默认可见全部站点，无需单独授权' });
      }
      const incoming = Array.isArray(req.body.siteIds) ? req.body.siteIds : [];
      const valid = store.listSites().map((site) => site.id);
      const siteIds = incoming.filter((id) => valid.includes(String(id)));
      const result = store.setUserSites(user.id, siteIds);
      store.recordAudit({
        user: req.user,
        action: 'user.sites',
        targetType: 'user',
        targetId: user.id,
        detail: `授权站点 ${result.length} 个`,
        ip: clientIp(req),
      });
      res.json({ siteIds: result });
    });

    registerNotifyRoutes(app, {
      store,
      notifier,
      requireAuth,
      requireManager,
      adminSiteIdsFor,
      canManageSite,
      normalizeText,
      clientIp,
      notifyChannelForClient,
      parseNotifyChannelInput,
    });
    app.get('/api/vendors', requireAuth, (_req, res) => {
      res.json({ vendors: publicVendors() });
    });

    registerCameraRoutes(app, {
      store,
      streamManager,
      edgeHub,
      ffprobeOk,
      syncDetection,
      detectionEngine,
      dataDir,
      previewDir,
      log,
      validateCameraInput,
      capturePreview,
      requireAuth,
      requireManager,
      canManageCamera,
      canManageSite,
      allowedSiteIdsFor,
      fallbackSiteIdFor,
      normalizeText,
      clientIp,
      cameraForClient,
    });
    registerAlarmRoutes(app, {
      store,
      metrics,
      broadcastEvent,
      notifier,
      canAccessAlarmSite,
      canAccessCameraSite,
      mapAlarmEvent,
      parseSnapshot,
      snapshotDir,
      recordingsDir,
      allowedSiteIdsFor,
      requireAuth,
      requireRole,
      normalizeText,
      clientIp,
    });
    // 审计日志：超管专属，支持按动作前缀/关键词/时间范围筛选与分页。
    registerAdminRoutes(app, {
      store,
      streamManager,
      metrics,
      startedAt,
      requireAuth,
      requireRole,
      normalizeText,
      mapAudit,
      clientIp,
    });

    // 演示播放列表：一次性 token 鉴权（服务端解码没有会话 Cookie，
    // 因此这里不能强制登录；token 随演示启停而生灭）。
    app.get('/demo/:token/index.m3u8', async (req, res) => {
      if (!demoSource.running || !demoSource.verifyToken(req.params.token)) {
        return res.status(404).send('演示视频未启动');
      }
      try {
        const playlist = await demoSource.playlist();
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(playlist);
      } catch {
        res.status(404).send('演示视频未就绪');
      }
    });

    app.get('/demo/:token/:segment', (req, res) => {
      if (!demoSource.running) {
        return res.status(404).end();
      }
      if (!demoSource.verifyToken(req.params.token)) {
        return res.status(404).end();
      }
      const file = demoSource.segmentPath(req.params.segment);
      if (!file) return res.status(400).end();
      // sendFile 在文件被 HLS muxer 滚动删除的瞬间会失败；
      // 用 fs 直接读取，404 时返回空体并保持下游重试语义。
      fsp
        .readFile(file)
        .then((buffer) => {
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'private, max-age=10');
          res.send(buffer);
        })
        .catch(() => {
          if (!res.headersSent) res.status(404).end();
        });
    });

    app.get('/streams/:cameraId/index.m3u8', requireAuth, async (req, res) => {
      const camera = store.getCamera(req.params.cameraId);
      if (
        !camera ||
        !['rtsp', 'edge'].includes(camera.protocol) ||
        !camera.sourceUrl ||
        !canAccessCameraSite(req.user, camera, store)
      ) {
        return res.status(404).send('视频点位不存在');
      }
      try {
        const playlist =
          camera.protocol === 'edge'
            ? (await edgeHub.request(camera.sourceUrl, 'index.m3u8')).toString('utf8')
            : await streamManager.playlist(camera);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(playlist);
      } catch (error) {
        const streamError =
          error instanceof StreamError
            ? error
            : new StreamError(
                error instanceof Error ? error.message : 'RTSP/HLS 转码失败',
                { status: 502 },
              );
        if (streamError.retryAfter) {
          res.setHeader('Retry-After', String(streamError.retryAfter));
        }
        res.status(streamError.status).send(streamError.message);
      }
    });

    app.get('/streams/:cameraId/:segment', requireAuth, async (req, res) => {
      const camera = store.getCamera(req.params.cameraId);
      if (
        !camera ||
        !['rtsp', 'edge'].includes(camera.protocol) ||
        !canAccessCameraSite(req.user, camera, store)
      ) {
        return res.status(404).end();
      }
      const segment = req.params.segment;
      if (!/^[a-zA-Z0-9._-]+\.ts$/.test(segment)) return res.status(400).end();
      if (camera.protocol === 'edge') {
        try {
          const body = await edgeHub.request(camera.sourceUrl, segment);
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'private, max-age=10');
          res.send(body);
        } catch {
          res.status(404).end();
        }
        return;
      }
      const file = streamManager.segmentPath(camera.id, segment);
      if (!file) return res.status(400).end();
      streamManager.touch(camera.id);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'private, max-age=10');
      res.sendFile(file, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    });

    if (fs.existsSync(distDir)) {
      app.use(
        express.static(distDir, {
          index: false,
          maxAge: '1y',
          immutable: true,
          setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
              res.setHeader('Cache-Control', 'no-store');
            }
          },
        }),
      );
      app.use((req, res, next) => {
        if (
          req.method !== 'GET' ||
          req.path.startsWith('/api/') ||
          req.path.startsWith('/streams/') ||
          req.path.startsWith('/demo/') ||
          req.path.startsWith('/proxy/') ||
          req.path === '/healthz'
        ) {
          return next();
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(distDir, 'index.html'));
      });
    }

    app.use((req, res) => {
      if (
        req.path.startsWith('/api/') ||
        req.path.startsWith('/streams/') ||
        req.path.startsWith('/demo/')
      ) {
        return res.status(404).json({ error: '接口不存在' });
      }
      return res.status(404).send('Not found');
    });

    app.use((error, req, res, _next) => {
      metrics.errors += 1;
      const status = Number(error?.status ?? error?.statusCode ?? 500);
      if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '请求体不是有效的 JSON' });
      }
      if (error?.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
      }
      log('error', 'unhandled_error', {
        path: req.path,
        method: req.method,
        status,
        message: String(error?.message ?? error).slice(0, 500),
      });
      if (res.headersSent) return;
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: status >= 500 ? '服务器内部错误' : String(error?.message ?? '请求失败'),
      });
    });

    const backupTimerRun = async () => {
      try {
        const pruned = store.pruneAuditLogs();
        if (pruned > 0) log('info', 'audit_logs_pruned', { count: pruned });
        const file = await store.backup();
        log('info', 'database_backup', { file: path.basename(file) });
      } catch (error) {
        log('error', 'database_backup_failed', { message: error.message });
      }
    };
    setTimeout(() => void backupTimerRun(), 15_000).unref();
    backupTimer = setInterval(() => void backupTimerRun(), 24 * 60 * 60 * 1000);
    backupTimer.unref();

    const server = app.listen(port, '0.0.0.0', () => {
      log('info', 'server_started', {
        port,
        dataDir,
        database: 'sqlite',
        ffmpeg: streamManager.ffmpegAvailable,
        ffprobe: ffprobeOk,
        edgeGateway: edgeHub.enabled,
        users: store.stats().users,
        cameras: store.stats().cameras,
      });
    });
    if (edgeHub.enabled) {
      edgeHub.attach(server);
      log('info', 'edge_gateway_enabled', { path: '/gateway' });
    }

    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', 'server_shutdown', { signal });
      if (backupTimer) clearInterval(backupTimer);
      if (detectionTimer) clearInterval(detectionTimer);
      if (offlineTimer) clearInterval(offlineTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (escalationTimer) clearInterval(escalationTimer);
      if (summaryTimer) clearInterval(summaryTimer);
      if (mediaTimer) clearInterval(mediaTimer);
      demoSource?.stop();
      detectionEngine?.stopAll();
      for (const client of sseClients) {
        try {
          client.res.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      streamManager.stopAll();
      edgeHub.close();
      server.closeAllConnections?.();
      server.close(async () => {
        try {
          store.close();
        } finally {
          await releaseLock();
          process.exit(0);
        }
      });
      setTimeout(() => process.exit(1), 8_000).unref();
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    log('error', 'startup_failed', { message: error.message });
    try {
      if (detectionTimer) clearInterval(detectionTimer);
      if (offlineTimer) clearInterval(offlineTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (escalationTimer) clearInterval(escalationTimer);
      if (summaryTimer) clearInterval(summaryTimer);
      if (mediaTimer) clearInterval(mediaTimer);
      detectionEngine?.stopAll();
      streamManager?.stopAll();
    } catch {
      // ignore
    }
    try {
      store?.close();
    } catch {
      // ignore
    }
    await releaseLock();
    process.exit(1);
  }
}

void main();

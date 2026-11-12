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
import { runFfmpegOnce } from './ffmpeg-once.mjs';
import { toClientSchedule } from './schedule.mjs';
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
// 认证域能力集中到 server/auth/*：密码哈希、身份投影、角色与权限矩阵、
// 统一错误类型。原先这些逻辑定义在本文件里并经 deps 透传给各路由模块。
import {
  passwordHash,
  passwordIssue,
  validatePassword,
  verifyPassword,
  validUsername,
} from './auth/password.mjs';
import { normalizeText, toPublicUser as publicUser } from './auth/identity.mjs';
import { registerNotifyRoutes } from './routes/notify.mjs';
import { registerCameraRoutes } from './routes/cameras.mjs';
import { registerAlarmRoutes } from './routes/alarms.mjs';
import { registerSiteRoutes } from './routes/sites.mjs';
import { registerUserRoutes } from './routes/users.mjs';
import { registerAuthRoutes } from './routes/auth.mjs';
import { registerDemoRoutes } from './routes/demo.mjs';
import { registerMediaRoutes } from './routes/media.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { registerRecordingRoutes } from './routes/recordings.mjs';
import { reconcileRecordingSegments } from './recording-index.mjs';
import { installProcessGuards } from './process-safety.mjs';
import { RecordingCaptureManager } from './recording-capture.mjs';
import {
  PlaybackSessionManager,
  exportRecordingToMp4,
  safeSegmentPath,
} from './recording-playback.mjs';
import { probeSegmentDurations } from './recording-duration.mjs';
import { SharedSourceHub } from './shared-source.mjs';
import { detectFfmpegCapabilities } from './ffmpeg-capabilities.mjs';
import { applyResolvedBinaries } from './binary-locate.mjs';
import { resolveLayout } from './app-paths.mjs';
import { assertOutboundUrl, blockedOutboundHost } from './net-guard.mjs';
import { SHANGHAI_OFFSET_MS, toShanghaiParts } from './time.mjs';
import { envBoolean, envNumber, normalizeClock, normalizePort } from './config.mjs';

// 配置非法值统一走 warn 日志，不再静默生效（详见 server/config.mjs）。
const configWarn = (message) => log('warn', 'config_invalid', { message });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
// 目录布局：源码运行 → <项目根>/data（与改造前一致）；
// 便携包/安装包 → 由 app-paths 按布局标记决定，并处理不可写时的回退。
// boot.mjs 启动时已写入 DATA_DIR，这里重复解析是幂等的（保证直接以
// index.mjs 启动的既有守护脚本也能正确工作）。
const layout = resolveLayout({ projectRoot, argv: process.argv, env: process.env });
const dataDir = layout.dataDir;
const distDir = path.join(projectRoot, 'dist');
// SPA 回退与 404 兜底共享保留前缀；回退额外排除精确路径 /healthz。
const commonReservedPaths = ['/api/', '/streams/', '/demo/', '/proxy/'];
const spaReservedPaths = [...commonReservedPaths];
const spaReservedExactPaths = ['/healthz'];
const reservedExactPaths = ['/api', '/streams', '/demo', '/proxy'];
const legacyJsonFile = path.join(dataDir, 'app.json');
const databaseFile = path.join(dataDir, 'app.db');
const snapshotDir = path.join(dataDir, 'snapshots');
const recordingsDir = path.join(dataDir, 'recordings');
// 持续录像段独立存放：data/recordings/ 已被告警短视频 mp4 与媒体水位扫描占用。
const continuousDir = path.join(dataDir, 'continuous');
// 回放会话与导出的临时产物：进程重启后不复用，启动时清空。
const continuousPlayDir = path.join(dataDir, 'continuous-play');
const continuousExportDir = path.join(dataDir, 'continuous-export');
const recordingEnabled = envBoolean('RECORDING', false, { onWarn: configWarn });
// 与 README 的范围承诺对齐：单段 10-600 秒，保留/保护天数不得为负。
const recordingSegmentSeconds = envNumber('RECORDING_SEGMENT_SECONDS', {
  defaultValue: 60, min: 10, max: 600, onWarn: configWarn,
});
const recordingRetentionDays = envNumber('RECORDING_RETENTION_DAYS', {
  defaultValue: 14, min: 1, max: 3650, onWarn: configWarn,
});
const recordingProtectDays = envNumber('RECORDING_PROTECT_DAYS', {
  defaultValue: 30, min: 0, max: 3650, allowZero: true, onWarn: configWarn,
});
const recordingMaxBytes = envNumber('RECORDING_MAX_BYTES', {
  defaultValue: 50 * 1024 * 1024 * 1024, min: 0, allowZero: true, onWarn: configWarn,
});
const recordingMaxCameras = envNumber('RECORDING_MAX_CAMERAS', {
  defaultValue: 24, min: 1, max: 512, onWarn: configWarn,
});
const previewDir = path.join(dataDir, 'previews');
// 运行期目录统一权限：仅属主可读写执行（抓拍/录像/数据库等私有目录）。
const DIR_MODE = 0o700;
const portArgIndex = process.argv.indexOf('--port');
// CLI --port 优先于环境变量：脚本/测试显式指定的端口不应被宿主环境覆盖。
const portArg = portArgIndex >= 0 ? process.argv[portArgIndex + 1] : undefined;
const portSource = portArg ?? process.env.PORT ?? 4173;
const normalizedPort = normalizePort(portSource, 4173);
if (normalizedPort.error) configWarn(normalizedPort.error);
const port = normalizedPort.port;
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
  // P0-2：未捕获 rejection / 未捕获异常计数。
  // 这两个计数不为 0 就意味着「系统正在偷偷坏掉」——是最优先级的告警信号。
  unhandledRejections: 0,
  uncaughtExceptions: 0,
};
const sseClients = new Set();
// main() 创建 Store 后赋值；SSE 长连接期间权限可能变更，广播时按实时状态校验。
let activeStore = null;
// SSE 广播的「用户 + 可见站点」缓存：同一用户开多个标签页时，旧实现对每个
// client 各查一次 getUser + siteMemberSiteIds（500 clients = 1000 次同步查询，
// 实测约 25ms 事件循环阻塞）。
// 缓存键绑定 store.authRevision —— 任何账号/站点授权写入都会递增它，
// 因此撤权/停用后长连接在**下一次广播**立即停止收到新告警，安全语义不变。
let sseAuthCache = { revision: -1, users: new Map() };

function broadcastEvent(event, data, siteId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // 修订号变化时整表失效（比逐用户失效更简单，也覆盖新增/删除账号）。
  if (activeStore && sseAuthCache.revision !== activeStore.authRevision) {
    sseAuthCache = { revision: activeStore.authRevision, users: new Map() };
  }
  for (const client of sseClients) {
    // 会话级撤销：登出的标签页不应继续收到告警（登出时会主动 end 连接，
    // 这里再校验一次以覆盖其它撤销路径，如账号被管理员强制下线）。
    if (
      activeStore &&
      client.sid &&
      activeStore.isSessionRevoked?.(client.userId, client.sid)
    ) {
      try { client.res.end(); } catch { /* 已断开 */ }
      sseClients.delete(client);
      continue;
    }
    // 不使用建连时的站点快照：撤权/停用后的长连接不应继续收到其它站点告警。
    if (activeStore) {
      let allowed;
      try {
        let entry = sseAuthCache.users.get(client.userId);
        if (!entry) {
          const user = activeStore.getUser(client.userId);
          if (!user || user.disabled) {
            sseAuthCache.users.set(client.userId, { invalid: true });
            sseClients.delete(client);
            continue;
          }
          entry = { user, allowed: allowedSiteIdsFor(user, activeStore) };
          sseAuthCache.users.set(client.userId, entry);
        }
        if (entry.invalid) {
          sseClients.delete(client);
          continue;
        }
        allowed = entry.allowed;
      } catch {
        // 查询失败时保守跳过，不按过期快照投递。
        continue;
      }
      if (siteId && allowed !== null && !allowed.includes(siteId)) continue;
    } else if (
      siteId &&
      Array.isArray(client.siteIds) &&
      !client.siteIds.includes(siteId)
    ) {
      continue;
    }
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

/* 文件日志。
 *
 * 现场部署时窗口一关，控制台输出就没了；只靠 stdout 会让「服务起不来」「转码
 * 失败」这类问题无从排查。统一写到 <dataDir>/logs/server.log：
 * - 同步追加：崩溃前最后几行一定落盘（日志量小，代价可忽略）；
 * - 超过 5 MB 轮转为 server.log.1，只保留一份，避免无限增长吃满磁盘；
 * - 任何写盘异常都只是关掉文件日志，绝不影响主流程。
 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logFilePath = null;
let logBytes = 0;

/** @param {string} dir 数据目录。 */
function initLogFile(dir) {
  try {
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    logFilePath = path.join(logsDir, 'server.log');
    logBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
  } catch {
    logFilePath = null;
  }
}

function rotateLogFile() {
  if (!logFilePath || logBytes < LOG_MAX_BYTES) return;
  try {
    fs.renameSync(logFilePath, `${logFilePath}.1`);
    logBytes = 0;
  } catch {
    // 轮转失败继续追加，不能因为日志把服务拖垮。
  }
}

/** @param {string} line 已序列化的单行日志。 */
function writeLogLine(line) {
  if (!logFilePath) return;
  try {
    rotateLogFile();
    fs.appendFileSync(logFilePath, `${line}\n`);
    logBytes += Buffer.byteLength(line) + 1;
  } catch {
    logFilePath = null;
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
  writeLogLine(line);
}

// 文件日志目录随数据目录：便携包为 <包>/data/logs，安装形态为 <数据目录>/logs。
// 必须放在上面 let logFilePath 之后调用——函数声明会提升，但 let 变量处于 TDZ。
// 初始化失败只影响文件日志，服务本身照常启动。
initLogFile(dataDir);

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

/** 点位名称上限。
 *
 * 原为 24 字符，对「A 区 3 号楼 B1 消防通道」这类现场命名不够用；
 * 放宽到 60。超出时**明确报错**而不是静默截断——静默截断会让用户以为
 * 全名已保存，直到在大屏上看到被砍掉的名字才发现。
 */
const CAMERA_NAME_MAX = 60;
const CAMERA_PROTOCOLS = ['none', 'hls', 'http', 'rtsp', 'edge'];

function validateCameraInput(body) {
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  if (rawName.length > CAMERA_NAME_MAX) {
    return {
      error: `点位名称最多 ${CAMERA_NAME_MAX} 个字符（当前 ${rawName.length} 个）`,
    };
  }
  const name = normalizeText(rawName, CAMERA_NAME_MAX);
  const zone = normalizeText(body.zone, 32);
  // 缺省或空串仍视为 none（兼容既有客户端）；传了白名单外的值则明确报错，
  // 不再静默降级为 none——否则前端的配置错误会被悄悄吞掉。
  const rawProtocol =
    body.protocol === undefined || body.protocol === null || body.protocol === ''
      ? 'none'
      : body.protocol;
  if (!CAMERA_PROTOCOLS.includes(rawProtocol)) {
    return { error: `不支持的协议类型：${String(rawProtocol).slice(0, 32)}` };
  }
  const protocol = rawProtocol;
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
    // 出网主机校验：拦截链路本地（含云元数据）与未指定地址。
    // 这些地址对「视频流」没有正当用途，却是 SSRF 最有价值的探测目标。
    const blockedHost = blockedCameraSourceHost(sourceUrl);
    if (blockedHost) return { error: blockedHost };
  }
  const detectSensitivity = ['low', 'standard', 'high'].includes(body.detectSensitivity)
    ? body.detectSensitivity
    : null;
  const detectRoi = parseRoi(
    Array.isArray(body.detectRoi) ? JSON.stringify(body.detectRoi) : body.detectRoi,
  );
  // 布防时间表：非法输入由 parseSchedule 回退为全天候布防（serializeSchedule 落库时归一化）。
  const scheduleInput =
    body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
      ? body.schedule
      : null;
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
      schedule: scheduleInput,
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
    schedule: toClientSchedule(camera.schedule),
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
 *
 * 判定实现统一到 net-guard，避免各处各写一套正则而出现绕过差异。
 */
function isBlockedNotifyHost(hostname) {
  const strict = process.env.NOTIFY_BLOCK_PRIVATE === '1';
  return blockedOutboundHost(hostname, {
    allowPrivate: !strict,
    allowLoopback: !strict,
    allowLinkLocal: false,
  });
}

/**
 * 相机视频源主机校验（SSRF 缓解）。
 *
 * 与通知渠道的差异：摄像头本身就部署在内网，甚至可能自组网使用
 * 169.254.x.x 自分配地址，因此**默认放行私网、环回与链路本地**，
 * 只恒定拦截云元数据地址（169.254.169.254 等）与未指定地址——
 * 这两类地址对「视频流」没有任何正当用途，却是 SSRF 最有价值的探测目标。
 * 公网部署可设 CAMERA_BLOCK_PRIVATE=1 额外收紧到与通知渠道一致。
 *
 * @param {string} sourceUrl 视频源地址（http/https/rtsp/rtsps）。
 * @returns {string|null} 拒绝原因；null 表示放行。
 */
function blockedCameraSourceHost(sourceUrl) {
  const strict = process.env.CAMERA_BLOCK_PRIVATE === '1';
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null; // 协议不合法的情况交由 validateCameraInput 报错。
  }
  return blockedOutboundHost(parsed.hostname, {
    allowPrivate: !strict,
    allowLoopback: !strict,
    allowLinkLocal: true,
  });
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
  // TRUST_PROXY 开启时 req.ip 取自 X-Forwarded-For。攻击者可伪造超长链
  // 让每一跳都是新 IP，绕过按 IP 的限流维度；超过 2 跳直接回退到 socket 地址。
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.split(',').length > 2) {
    return String(req.socket?.remoteAddress ?? '').slice(0, 128);
  }
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
  // 先写临时文件再原子改名：失败时磁盘上不会留下「不完整的 jpg」，
  // 否则后续请求会在 60 秒缓存期内把损坏的半成品当作预览图返回。
  // 临时名保留原扩展名——FFmpeg 依据扩展名推断封装格式。
  const temp = path.join(path.dirname(target), `.tmp-${path.basename(target)}`);
  const args = ['-v', 'error', '-nostdin', '-y'];
  if (camera.protocol === 'rtsp') args.push('-rtsp_transport', 'tcp');
  args.push('-i', camera.sourceUrl, '-frames:v', '1', '-q:v', '4', '-an', temp);
  return runFfmpegOnce({
    spawnImpl: spawn,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    args,
    timeoutMs: 8_000,
    stdio: ['ignore', 'ignore', 'ignore'],
    failureValue: false,
    onExit: (code) => {
      try {
        if (code !== 0 || !fs.existsSync(temp)) {
          try {
            fs.unlinkSync(temp);
          } catch {
            // ignore
          }
          return false;
        }
        fs.renameSync(temp, target);
        return true;
      } catch {
        try {
          fs.unlinkSync(temp);
        } catch {
          // ignore
        }
        return false;
      }
    },
  });
}

async function main() {
  // 兼容以 index.mjs 直接启动的场景（如既有守护脚本）：同样补齐 ffmpeg/ffprobe 路径。
  // 已通过 boot.mjs 启动时这里是幂等的（环境变量已设置则不再改动）。
  applyResolvedBinaries();

  // 全进程共享的运行期配置：同一变量只解析一次，避免不同 manager 得到不同值
  // （改造前 MAX_CONCURRENT_STREAMS 在 StreamManager 得到 NaN、在回放得到 8）。
  const maxConcurrentStreams = envNumber('MAX_CONCURRENT_STREAMS', {
    defaultValue: 8, min: 1, max: 64, onWarn: configWarn,
  });
  const detectionWidth = envNumber('DETECTION_WIDTH', {
    defaultValue: 160, min: 32, max: 1920, onWarn: configWarn,
  });
  const detectionHeight = envNumber('DETECTION_HEIGHT', {
    defaultValue: 90, min: 32, max: 1080, onWarn: configWarn,
  });
  const detectionFps = envNumber('DETECTION_FPS', {
    defaultValue: 1, min: 1, max: 30, onWarn: configWarn,
  });
  // P0-2：进程级异常兜底。必须在任何异步任务启动之前安装，
  // 否则一次未捕获的 rejection 就会让整个监控平台静默退出。
  // shutdown 在下方定义，这里用引用占位，装配完成后回填。
  let fatalHandler = null;
  const processGuards = installProcessGuards({
    log,
    onCount: (state) => {
      // 计数器同步到 /api/metrics：这两个计数不为 0 即表示有异常被吞掉过。
      metrics.unhandledRejections = state.unhandledRejections;
      metrics.uncaughtExceptions = state.uncaughtExceptions;
    },
    onFatal: (error) => {
      log('error', 'fatal_shutdown', { message: error.message });
      if (typeof fatalHandler !== 'function') {
        // 装配早期发生 uncaughtException：优雅停机尚未就绪，进程状态已不可信。
        // 此时绝不能既不停机也不退出（Node 默认退出被我们的 handler 覆盖）。
        process.exit(1);
      }
      try {
        void fatalHandler('uncaughtException');
      } catch (shutdownError) {
        log('error', 'fatal_shutdown_failed', { message: shutdownError.message });
        process.exit(1);
      }
    },
  });

  await fsp.mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  await fsp.mkdir(snapshotDir, { recursive: true, mode: DIR_MODE });
  await fsp.mkdir(recordingsDir, { recursive: true, mode: DIR_MODE });
  await fsp.mkdir(continuousDir, { recursive: true, mode: DIR_MODE });
  await fsp.mkdir(previewDir, { recursive: true, mode: DIR_MODE });

  // 媒体磁盘水位：抓拍 + 短视频总量超过 MEDIA_MAX_BYTES 时自动清理（0 关闭）。
  // 修正：旧写法 `Number(env) > 0 ? ... : 2GB` 把 0 也回退成 2GB，
  // 使 README 承诺的「0 关闭」与 enforceMediaWatermarkInner 的关闭分支成为死代码。
  const mediaMaxBytes = envNumber('MEDIA_MAX_BYTES', {
    defaultValue: 2 * 1024 * 1024 * 1024, min: 0, allowZero: true, onWarn: configWarn,
  });
  // 备份策略：份数上限 + 目录总量上限（双约束）。
  // 仅按份数轮转时，备份目录会随库体积线性放大（14 份 × 库大小），
  // 而它此前完全不计入任何磁盘统计 —— 运维在看板上看不到它，直到磁盘写满。
  const backupDir = path.join(dataDir, 'backups');
  const backupRetain = envNumber('BACKUP_RETAIN', {
    defaultValue: 14, min: 1, max: 200, onWarn: configWarn,
  });
  const backupMaxBytes = envNumber('BACKUP_MAX_BYTES', {
    defaultValue: 0, min: 0, allowZero: true, onWarn: configWarn,
  });
  const streamsDir = path.join(dataDir, 'streams');
  let mediaUsageCache = {
    at: 0,
    snapshots: { files: 0, bytes: 0 },
    recordings: { files: 0, bytes: 0 },
    continuous: { files: 0, bytes: 0, protectedFiles: 0 },
    backups: { files: 0, bytes: 0 },
    streams: { files: 0, bytes: 0 },
  };
  const scanMediaDir = async (dir) => {
    let files = 0;
    let bytes = 0;
    try {
      // PERF-3：withFileTypes 直接给出文件类型，省掉「先 readdir 再逐个 stat」
      // 里对每个条目的一次 stat；随后并发 stat 取大小（串行 stat 在几千文件时
      // 会明显拖慢整个事件循环）。
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const names = [];
      for (const entry of entries) {
        if (entry.isFile()) names.push(entry.name);
      }
      files = names.length;
      const sizes = await Promise.all(
        names.map(async (name) => {
          try {
            return (await fsp.stat(path.join(dir, name))).size;
          } catch {
            // 扫描间隙文件可能被删除
            return 0;
          }
        }),
      );
      for (const size of sizes) bytes += size;
    } catch {
      // 目录不存在视为空
    }
    return { files, bytes };
  };
  const computeMediaUsage = async (force = false) => {
    if (!force && Date.now() - mediaUsageCache.at < 5 * 60_000) return mediaUsageCache;
    const [snapshots, recordings, backups] = await Promise.all([
      scanMediaDir(snapshotDir),
      scanMediaDir(recordingsDir),
      scanMediaDir(backupDir),
    ]);
    // 录像段按点位/日期分目录，递归扫盘代价高且索引就是事实源，直接取索引用量。
    let continuous = { files: 0, bytes: 0, protectedFiles: 0 };
    try {
      continuous = store.recordingUsage();
    } catch {
      // schema 尚未就绪时降级为 0，不影响 /api/system 其它字段。
    }
    // HLS 分片目录按点位分子目录，递归扫代价高，这里只统计顶层目录条目，
    // 用于让运维知道「分片占了多少空间」，不参与水位判定。
    let streams = { files: 0, bytes: 0 };
    try {
      const entries = await fsp.readdir(streamsDir);
      streams = { files: entries.length, bytes: 0 };
    } catch {
      // 目录不存在视为空
    }
    mediaUsageCache = { at: Date.now(), snapshots, recordings, continuous, backups, streams };
    return mediaUsageCache;
  };
  const releaseLock = await acquireInstanceLock();
  // 回放/导出目录只存本次运行的临时产物；拿到实例锁后清空，避免多实例互删。
  for (const dir of [continuousPlayDir, continuousExportDir]) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  }
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
  let recordingTimer;
  let recordingRotateTimer;
  let recordingRetentionTimer;
  let captureManager;
  let playbackManager;
  // 首次延迟触发的定时器：此前只 .unref() 不保存 handle，停机窗口内仍会触发，
  // 且 startup 失败时无法清理。统一收集，在 shutdown / catch 两处清掉。
  const startupTimers = [];
  const scheduleStartup = (fn, delay) => {
    const handle = setTimeout(fn, delay);
    handle.unref?.();
    startupTimers.push(handle);
    return handle;
  };
  // async 定时任务的 in-flight 保护：磁盘卡慢时上一轮未结束、下一轮又进入，
  // 会并发删除/写库。以任务名为键串行化，重复触发直接跳过本轮。
  const runningTasks = new Set();
  const withInFlight = (name, fn) => async () => {
    if (runningTasks.has(name)) return;
    runningTasks.add(name);
    try {
      await fn();
    } finally {
      runningTasks.delete(name);
    }
  };

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
    activeStore = store;
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

    // 转码编码器不能假定 libx264 一定存在：现场 FFmpeg 可能是裁剪版/发行版包。
    // 启动时探测一次，选可用编码器并记录降级原因，避免前端只看到「一直转圈」。
    const ffmpegCapabilities = await detectFfmpegCapabilities({
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    });
    if (!ffmpegCapabilities.ok) {
      log('warn', 'ffmpeg_capabilities_unavailable', {
        message: ffmpegCapabilities.reason,
        error: ffmpegCapabilities.error,
      });
    } else if (ffmpegCapabilities.degraded) {
      log('warn', 'ffmpeg_codec_degraded', {
        message: ffmpegCapabilities.reason,
        codec: ffmpegCapabilities.codec,
      });
    } else {
      log('info', 'ffmpeg_codec_ready', { codec: ffmpegCapabilities.codec });
    }

    streamManager = new StreamManager({
      dataDir,
      maxStreams: maxConcurrentStreams,
      videoCodec: ffmpegCapabilities.codec,
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
    // 录像段实际时长校准：ffprobe 缺失或探测失败时保持名义段长行为。
    const recordingProbe = ffprobeOk
      ? (segments) =>
          probeSegmentDurations({
            segments,
            rootDir: continuousDir,
            nominalMs: recordingSegmentSeconds * 1000,
          })
      : null;

    // 共享源模式（默认关闭）：RECORDING=1 且显式开启时，检测与录像复用同一 FFmpeg 进程。
    // 必须先于 DetectionEngine 构造创建，并在首次 sync 前建立会话，检测引擎才会跳过自己的进程。
    const sharedHub =
      recordingEnabled &&
      streamManager.ffmpegAvailable &&
      envBoolean('RECORDING_SHARED_SOURCE', false, { onWarn: configWarn })
        ? new SharedSourceHub({
            rootDir: continuousDir,
            segmentSeconds: recordingSegmentSeconds,
            width: detectionWidth,
            height: detectionHeight,
            fps: detectionFps,
            logger: { warn: (event, fields) => log('warn', event, fields) },
          })
        : null;
    if (sharedHub) log('info', 'recording_shared_source_enabled', {});

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
      enabled: envBoolean('SERVER_DETECTION', true, { onWarn: configWarn }),
      // 演示点位记录的是站内相对地址，服务端解码时补成回环绝对地址。
      resolveSourceUrl: (url) =>
        typeof url === 'string' && url.startsWith('/')
          ? `http://127.0.0.1:${port}${url}`
          : url,
      onQualityEvent: handleQualityEvent,
      frameSource: sharedHub,
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
      // RES-2：抓拍改为异步补齐，完成后广播一次告警更新，
      // 让前端无需轮询就能看到抓拍图出现。
      onSnapshot: (alarm, camera) => {
        store.recordAudit({
          action: 'alarm.snapshot',
          targetType: 'alarm',
          targetId: alarm.id,
          detail: `${camera.code} 抓拍已生成`,
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
        // 保护段联动已下沉到 store.createAlarm 事务内，覆盖全部告警来源。
      },
    });
    detectionEngine.init();
    log('info', 'server_detection_ready', {
      active: detectionEngine.active,
      fps: detectionEngine.fps,
      sensitivity: detectionEngine.sensitivity,
      size: `${detectionEngine.width}x${detectionEngine.height}`,
    });
    if (sharedHub) await sharedHub.sync(store.listCameras());
    detectionEngine.sync(store.listCameras());

    // 持续录像采集：仅 RECORDING=1 时启动，默认不产生任何 FFmpeg 进程。
    captureManager = new RecordingCaptureManager({
      rootDir: continuousDir,
      enabled: recordingEnabled,
      segmentSeconds: recordingSegmentSeconds,
      maxCameras: recordingMaxCameras,
      sharedHub,
      // 与检测引擎一致：演示点位存的是站内相对地址，补成回环绝对地址。
      resolveSourceUrl: (url) =>
        typeof url === 'string' && url.startsWith('/')
          ? `http://127.0.0.1:${port}${url}`
          : url,
      logger: {
        warn: (event, fields) => log('warn', event, fields),
        info: (event, fields) => log('info', event, fields),
      },
    });
    const captureFfmpegOk = captureManager.init();
    if (recordingEnabled && !captureFfmpegOk) {
      log('warn', 'recording_ffmpeg_missing', {
        message: '未找到 FFmpeg，持续录像采集未启动',
      });
    }
    playbackManager = new PlaybackSessionManager({
      rootDir: continuousPlayDir,
      continuousDir,
      maxSessions: maxConcurrentStreams,
      logger: { warn: (event, fields) => log('warn', event, fields) },
    });
    captureManager.sync(store.listCameras());

    // 定时对齐点位变化（检测 + 录像）、换日切目录、回收空闲回放会话。
    detectionTimer = setInterval(syncDetection, 20_000);
    detectionTimer.unref?.();
    recordingRotateTimer = setInterval(() => {
      // 补 .catch：rotate() 内部对共享源 rotate 的调用可能同步抛错，
      // 裸 void 会形成 unhandledRejection 并触发进程守卫。
      void captureManager?.rotate()?.catch(() => undefined);
      playbackManager?.cleanupIdle();
    }, 60_000);
    recordingRotateTimer.unref?.();

    function syncDetection() {
      try {
        if (sharedHub) {
          void sharedHub.sync(store.listCameras()).catch(() => undefined);
        }
        detectionEngine?.sync(store.listCameras());
        captureManager?.sync(store.listCameras());
      } catch (error) {
        log('warn', 'server_detection_sync_failed', { error: error.message });
      }
    }

    // 离线巡检：worker 超过阈值没有新帧即生成离线告警；画面恢复后自动归档。
    // 负数会让 `now - last > -1` 恒真，导致全点位离线告警风暴，必须设下界。
    const offlineTimeoutMs = envNumber('OFFLINE_TIMEOUT_MS', {
      defaultValue: 60_000, min: 1_000, max: 3_600_000, onWarn: configWarn,
    });
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
      envNumber('OFFLINE_CHECK_INTERVAL_MS', {
        defaultValue: 15_000, min: 100, max: 600_000, onWarn: configWarn,
      });
    offlineTimer = setInterval(offlineCheck, offlineCheckEveryMs);
    offlineTimer.unref?.();
    setTimeout(offlineCheck, Math.min(8_000, offlineCheckEveryMs)).unref?.();

    // 画面异常巡检：流在线但画面无效（遮挡/过暗/过曝）持续超阈值即告警，恢复自动归档。
    // 函数声明（非 const 箭头函数）：引擎在上方构造时就引用此回调，依赖提升。
    const qualityReasonText = {
      dark: '画面过暗或无光',
      bright: '画面过曝（强光直射）',
      covered: '疑似镜头被遮挡或严重失焦',
    };
    function handleQualityEvent(camera, event) {
      const actor = offlineActor;
      try {
        if (event.kind === 'abnormal') {
          const active = store.activeAlarmForCamera(camera.id);
          if (active) return; // 已有未处置告警（离线/火情）时不叠加画面异常
          const reasonText = qualityReasonText[event.reason] ?? '画面异常';
          const alarm = store.createAlarm({
            id: crypto.randomUUID(),
            cameraId: camera.id,
            cameraName: camera.name,
            zone: camera.zone,
            siteId: camera.siteId || store.defaultSiteId,
            level: 'camera_abnormal',
            confidence: 88,
            hotspot: { x: 50, y: 50 },
            actor,
            eventDetail: `${reasonText}，持续 ${Math.round(event.durationMs / 1000)}s`,
          });
          store.recordAudit({
            action: 'alarm.create',
            targetType: 'alarm',
            targetId: alarm.id,
            detail: `${camera.code} camera_abnormal（${event.reason}）`,
            ip: 'server-monitor',
          });
          broadcastEvent('alarm.created', { alarm }, alarm.siteId);
          void notifier
            ?.notifyAlarm(alarm, 'created', { camera })
            .catch(() => undefined);
          log('warn', 'camera_quality_abnormal', {
            cameraId: camera.id,
            code: camera.code,
            reason: event.reason,
          });
        } else {
          const active = store.activeAlarmForCamera(camera.id);
          if (!active || active.level !== 'camera_abnormal') return;
          const updated = store.updateAlarm(
            active.id,
            { status: 'archived', archivedAt: Date.now() },
            actor,
          );
          store.addAlarmEvent(active.id, actor, 'archived', '画面恢复正常，自动归档');
          broadcastEvent('alarm.updated', { alarm: updated }, updated.siteId);
          void notifier
            ?.notifyAlarm(updated, 'recovered', { camera })
            .catch(() => undefined);
          log('info', 'camera_quality_recovered', {
            cameraId: camera.id,
            code: camera.code,
          });
        }
      } catch (error) {
        log('warn', 'camera_quality_event_failed', {
          cameraId: camera.id,
          error: error.message,
        });
      }
    };

    // 数据保留：清理超期的已关闭告警、抓拍/短视频、推送日志与审计日志。
    // 负数会把 cutoff 算到未来，删光全库告警/日志；必须设下界 1。
    const alarmRetentionDays = envNumber('ALARM_RETENTION_DAYS', {
      defaultValue: 180, min: 1, max: 3650, onWarn: configWarn,
    });
    const notifyRetentionDays = envNumber('NOTIFY_RETENTION_DAYS', {
      defaultValue: 30, min: 1, max: 3650, onWarn: configWarn,
    });
    const auditRetentionDays = envNumber('AUDIT_RETENTION_DAYS', {
      defaultValue: 180, min: 1, max: 3650, onWarn: configWarn,
    });
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
        // PERF-2：刷新查询统计信息。数据量变化后 sqlite_stat1 会失真，
        // 规划器可能退回全表扫描 + 临时排序（媒体水位清理实测慢 40 倍）。
        // ANALYZE 只读全表统计，20 万行量级约 100 毫秒，放在每日保留任务里足够。
        const analyzed = store.analyze();
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
        if (!analyzed) {
          log('warn', 'analyze_failed', { message: '查询统计信息刷新失败' });
        }
      } catch (error) {
        log('warn', 'retention_failed', { error: error.message });
      }
    };
    const guardedRetention = withInFlight('retention', retentionRun);
    retentionTimer = setInterval(() => void guardedRetention(), 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
    scheduleStartup(() => void guardedRetention(), 90_000);

    // 磁盘水位：抓拍 + 短视频超过上限时，从最老的已关闭告警开始清媒体（保留记录）。
    const enforceMediaWatermarkInner = async () => {
      if (!(mediaMaxBytes > 0)) return;
      const usage = await computeMediaUsage(true);
      // 磁盘总占用（含备份与持续录像）超阈值时告警：备份目录此前完全不在
      // 视野内，写满磁盘会让 SQLite 写入失败 —— 那意味着火情告警记不下来。
      const dataBytes =
        usage.snapshots.bytes +
        usage.recordings.bytes +
        (usage.continuous?.bytes ?? 0) +
        (usage.backups?.bytes ?? 0);
      if (dataBytes > mediaMaxBytes) {
        log('warn', 'disk_pressure', {
          dataBytes,
          mediaMaxBytes,
          backups: usage.backups?.bytes ?? 0,
          continuous: usage.continuous?.bytes ?? 0,
        });
      }
      let over = usage.snapshots.bytes + usage.recordings.bytes - mediaMaxBytes;
      if (over <= 0) return;
      let prunedFiles = 0;
      let prunedAlarms = 0;
      // PERF-3：原实现在循环里每轮都 await computeMediaUsage(true)，
      // 而 computeMediaUsage 会对三个媒体目录做一次 readdir + 逐个 stat 的全量扫描。
      // 20 轮循环 = 60 次全盘遍历，正是「单次 1.2 秒 × 20 轮 = 24 秒冻结」的成因。
      // 改为：删除量按 stat 到的真实字节本地累加，循环结束后统一重算一次用量。
      const MEDIA_BATCH = 1000;
      for (let round = 0; round < 20 && over > 0; round += 1) {
        const cleared = store.clearOldestAlarmMedia(MEDIA_BATCH);
        if (cleared.files.length === 0) break;
        // 并发删除：原来 2000 次 stat+rm 完全串行，等待时间叠加明显。
        const removed = await Promise.all(
          cleared.files.map(async (file) => {
            const target = path.join(
              String(file).toLowerCase().endsWith('.mp4') ? recordingsDir : snapshotDir,
              path.basename(file),
            );
            try {
              const stat = await fsp.stat(target).catch(() => null);
              await fsp.rm(target, { force: true });
              return { ok: true, size: stat?.size ?? 0 };
            } catch {
              return { ok: false, size: 0 };
            }
          }),
        );
        for (const item of removed) {
          if (!item.ok) continue;
          over -= item.size;
          prunedFiles += 1;
        }
        prunedAlarms += cleared.alarms;
      }
      // 收尾重算一次：既刷新缓存，也让看板上的用量回到真实值。
      await computeMediaUsage(true);
      if (prunedFiles > 0) {
        log('warn', 'media_watermark_pruned', {
          prunedFiles,
          prunedAlarms,
          mediaMaxBytes,
        });
      }
    };
    const enforceMediaWatermark = async () => {
      try {
        await enforceMediaWatermarkInner();
      } catch (error) {
        // P0-2：清理失败不能拖垮整个进程（未捕获 rejection 会终止 Node 进程），
        // 下一轮定时任务会重试；这里只记录明确日志。
        log('warn', 'media_watermark_failed', { message: error.message });
      }
    };
    const guardedWatermark = withInFlight('media-watermark', enforceMediaWatermark);
    mediaTimer = setInterval(
      () => void guardedWatermark(),
      10 * 60_000,
    );
    mediaTimer.unref?.();
    scheduleStartup(() => void guardedWatermark(), 30_000);

    // 磁盘余量预警：写满后再报错已经影响用户，这里在剩余 <1GB 时提前写 warn，
    // 让运维在日志里就能发现（/healthz 的 diskOk 阈值是 50MB，只用于守卫）。
    const diskWarnTimer = setInterval(() => {
      void (async () => {
        try {
          const stats = await fsp.statfs(dataDir);
          const free = Number(stats.bfree) * Number(stats.bsize);
          if (free < 1024 * 1024 * 1024) {
            log('warn', 'disk_low', { freeBytes: free });
          }
        } catch {
          // statfs 不可用（部分文件系统）时静默跳过。
        }
      })();
    }, 15 * 60_000);
    diskWarnTimer.unref?.();

    // 告警升级：超过 N 分钟仍未确认的告警再推一次，避免值班员漏看后沉底。
    const escalationMinutes = envNumber('ESCALATION_MINUTES', {
      defaultValue: 5, min: 0.001, max: 1440, allowZero: true, onWarn: configWarn,
    });
    const escalationIntervalMs =
      envNumber('ESCALATION_CHECK_INTERVAL_MS', {
        defaultValue: 60_000, min: 100, max: 3_600_000, onWarn: configWarn,
      });
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
        // 单条告警的异常不能中断整轮扫描：否则剩余待升级告警永远不会被处理，
        // 且已加入 in-flight 的 ID 不会被清理，导致这些告警今后永远不再升级。
        try {
          const camera = store.getCamera(alarm.cameraId);
          void notifier
            ?.notifyAlarm(alarm, 'escalated', { camera, minutes: escalationMinutes })
            .then((result) => {
              if (!result) return;
              // 事件记录的是「投递成功」而非「尝试过」：失败时写 escalated 会让
              // 下轮 hasAlarmEvent 判重而跳过重试，导致值班员实际未收到却显示已升级。
              // 无渠道（sent=0 且 failed=0）同样不写，留给后续渠道配置后重试。
              if (result.sent > 0) {
                store.addAlarmEvent(
                  alarm.id,
                  { id: null, username: 'server-monitor' },
                  'escalated',
                  `超过 ${escalationMinutes} 分钟未确认，已升级通知`,
                );
              }
              log('warn', 'alarm_escalated', {
                alarmId: alarm.id,
                cameraId: alarm.cameraId,
                sent: result.sent,
                failed: result.failed,
              });
            })
            .catch(() => undefined)
            .finally(() => escalationInFlight.delete(alarm.id));
        } catch (error) {
          escalationInFlight.delete(alarm.id);
          log('warn', 'escalation_item_failed', {
            alarmId: alarm.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    escalationTimer = setInterval(escalationCheck, escalationIntervalMs);
    escalationTimer.unref?.();
    scheduleStartup(escalationCheck, Math.min(15_000, escalationIntervalMs));

    // 每日值守摘要：固定时间把昨日告警统计推送到通知渠道（DAILY_SUMMARY_AT 为空时关闭）。
    // 旧写法只截断 5 字符：'25:99' 会让摘要永不触发，'08:00:30' 被静默截成 '08:00'。
    // 显式空串保留「关闭」语义，不能回退成默认时刻。
    const summaryRaw = process.env.DAILY_SUMMARY_AT;
    const summaryDisabled = summaryRaw !== undefined && String(summaryRaw).trim() === '';
    const summaryClock = normalizeClock(
      summaryRaw ?? '08:00', '08:00', { onWarn: configWarn },
    );
    const summaryAt = summaryDisabled ? '' : summaryClock.value;
    const summaryForce = envBoolean('DAILY_SUMMARY_FORCE', false, { onWarn: configWarn });
    const pad2 = (value) => String(value).padStart(2, '0');
    // 上海时区口径统一走 time.mjs（与告警日聚合、布防判定、通知文案同源）。
    const shanghaiParts = (ts) => toShanghaiParts(ts);
    const shanghaiDayStart = (parts) =>
      Date.UTC(parts.y, parts.m - 1, parts.d) - SHANGHAI_OFFSET_MS;
    const summaryLevelNames = {
      fire: '火焰',
      smoke: '烟雾',
      offline: '设备离线',
      camera_abnormal: '画面异常',
    };
    const dailySummaryCheck = () => {
      if (!summaryAt || !notifier) return;
      const nowParts = shanghaiParts(Date.now());
      const runKey = `${nowParts.y}-${pad2(nowParts.m)}-${pad2(nowParts.d)}`;
      if (store.getMeta('daily_summary_last') === runKey && !summaryForce) return;
      if (!summaryForce) {
        const [hh, mm] = summaryAt.split(':').map((value) => Number(value));
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
        // 宽窗口触发：目标时刻之后 120 分钟内只要「今天还没发过」就补发。
        // 原实现要求「小时与分钟完全相等」，进程若在目标分钟内重启或被
        // 同步 DB 操作阻塞超过 60 秒，当天摘要就永远不会再发出。
        const targetMinutes = hh * 60 + mm;
        const currentMinutes = nowParts.hh * 60 + nowParts.mm;
        const delta = currentMinutes - targetMinutes;
        if (delta < 0 || delta > 120) return;
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
          // 无可用渠道时 notifyBroadcast 返回 { sent: 0 }：不能记为「已送达」，
          // 否则 meta 被写入后当天不再补发，看板却显示 0 投递。
          if (result?.sent > 0) {
            store.setMeta('daily_summary_last', runKey);
            log('info', 'daily_summary_sent', { date: dateKey, ...result });
          } else {
            log('warn', 'daily_summary_no_delivery', { date: dateKey, ...result });
          }
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
    // 非 JSON Content-Type 时 body-parser 不会给 req.body 赋值，写接口解构会抛 TypeError。
    app.use((req, _res, next) => {
      if (req.body === undefined) req.body = {};
      next();
    });

    const {
      currentUser,
      setSessionCookie,
      clearSessionCookie,
      checkLoginBlocked,
      recordLoginFailure,
      clearLoginFailures,
      readSessionToken,
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
      requireCapability,
      requireManager,
      adminSiteIdsFor,
      canManageSite,
      canManageCamera,
      fallbackSiteIdFor,
    } = createGuards(store, currentUser);

    const setupGuard = { inFlight: false };

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

    registerAuthRoutes(app, {
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
      passwordIssue,
      passwordHash,
      verifyPassword,
      clientIp,
      defaultCameras,
      setupGuard,
      requireAuth,
      requireCapability,
      allowedSiteIdsFor,
      sseClients,
      detectionEngine,
      // 供登出时按 sid 精确撤销当前会话（而非账号级全端下线）。
      sessionCookie,
      parseCookies,
      readSessionToken,
    });
    registerDemoRoutes(app, {
      store,
      demoSource,
      demoPurgeFilter,
      rememberDemoCameraId,
      computeMediaUsage,
      recordingStatus: () => {
        const state = captureManager?.status?.() ?? {};
        return {
          enabled: recordingEnabled,
          active: state.active ?? 0,
          skipped: state.skipped ?? 0,
          ffmpegAvailable: Boolean(state.ffmpegAvailable),
          retentionDays: recordingRetentionDays,
          maxBytes: recordingMaxBytes,
        };
      },
      syncDetection,
      streamManager,
      detectionEngine,
      edgeHub,
      ffprobeOk,
      mediaMaxBytes,
      edgeGatewayToken,
      snapshotDir,
      recordingsDir,
      databaseFile,
      DEMO_CAMERA_CODE,
      DEMO_CAMERA_NAME,
      DEMO_CAMERA_ZONE,
      normalizeText,
      clientIp,
      log,
      adminSiteIdsFor,
      requireAuth,
      requireCapability,
    });
    registerMediaRoutes(app, {
      store,
      demoSource,
      edgeHub,
      streamManager,
      canAccessCameraSite,
      requireAuth,
      log,
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
      requireCapability,
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
      requireCapability,
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
      requireCapability,
      normalizeText,
      mapAudit,
      clientIp,
    });

    // ---------------- 站点（多租户/分组） ----------------
    registerSiteRoutes(app, {
      store,
      allowedSiteIdsFor,
      requireAuth,
      requireCapability,
      canManageSite,
      normalizeText,
      clientIp,
    });
    registerUserRoutes(app, {
      store,
      publicUser,
      passwordHash,
      validUsername,
      validatePassword,
      passwordIssue,
      requireAuth,
      requireRole,
      requireCapability,
      normalizeText,
      clientIp,
    });
    registerNotifyRoutes(app, {
      store,
      notifier,
      requireAuth,
      requireCapability,
      adminSiteIdsFor,
      canManageSite,
      normalizeText,
      clientIp,
      notifyChannelForClient,
      parseNotifyChannelInput,
    });
    registerRecordingRoutes(app, {
      store,
      continuousDir,
      recordingEnabled,
      canAccessCameraSite,
      requireAuth,
      requireCapability,
      normalizeText,
      playbackManager,
      captureManager,
      exportDir: continuousExportDir,
      exportRecording: ({ files, continuousDir: dir, exportDir }) =>
        exportRecordingToMp4({ files, continuousDir: dir, exportDir }),
      ffmpegAvailable: captureFfmpegOk,
      retentionDays: recordingRetentionDays,
      recordingProbe: recordingProbe ?? undefined,
      logger: { warn: (event, fields) => log('warn', event, fields) },
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
          spaReservedPaths.some((prefix) => req.path.startsWith(prefix)) ||
          spaReservedExactPaths.includes(req.path) ||
          reservedExactPaths.includes(req.path)
        ) {
          return next();
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(distDir, 'index.html'));
      });
    }

    app.use((req, res) => {
      if (
        commonReservedPaths.some((prefix) => req.path.startsWith(prefix)) ||
        reservedExactPaths.includes(req.path)
      ) {
        return res.status(404).json({ error: '接口不存在' });
      }
      return res.status(404).send('Not found');
    });

    app.use((error, req, res, next) => {
      metrics.errors += 1;
      const status = Number(error?.status ?? error?.statusCode ?? 500);
      if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '请求体不是有效的 JSON' });
      }
      if (error?.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
      }
      // 磁盘写满：SQLite 抛 SQLITE_FULL，文件写入抛 ENOSPC/EDQUOT。
      // 旧实现把它归到 500「服务器内部错误」，运维只能看到"页面报错"，
      // 无法判断是磁盘问题。这里单独识别并返回 507 + 可操作提示。
      const diskFullText = `${error?.code ?? ''} ${error?.message ?? ''}`;
      if (/SQLITE_FULL|database or disk is full|ENOSPC|EDQUOT|no space left/i.test(diskFullText)) {
        log('error', 'disk_full', {
          path: req.path,
          method: req.method,
          message: String(error?.message ?? error).slice(0, 300),
        });
        if (res.headersSent) return next(error);
        return res.status(507).json({ error: '服务器磁盘空间不足，请清理磁盘后重试' });
      }
      log('error', 'unhandled_error', {
        path: req.path,
        method: req.method,
        status,
        message: String(error?.message ?? error).slice(0, 500),
      });
      // 响应头已发出时交给框架默认处理（会终止连接），不能静默返回让 socket 悬挂。
      if (res.headersSent) return next(error);
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: status >= 500 ? '服务器内部错误' : String(error?.message ?? '请求失败'),
      });
    });

    const backupTimerRun = async () => {
      try {
        const pruned = store.pruneAuditLogs();
        if (pruned > 0) log('info', 'audit_logs_pruned', { count: pruned });
        const file = await store.backup(undefined, backupRetain, backupMaxBytes);
        log('info', 'database_backup', { file: path.basename(file) });
      } catch (error) {
        log('error', 'database_backup_failed', { message: error.message });
        // 记录失败状态：备份是唯一的灾难恢复手段，它失败必须能被监控看到。
        try {
          store.setMeta('last_backup_status', `failed: ${error.message}`.slice(0, 200));
          store.setMeta('last_backup_at', String(Date.now()));
        } catch {
          // 元数据写入失败不掩盖原始错误
        }
      }
    };
    const guardedBackup = withInFlight('backup', backupTimerRun);
    scheduleStartup(() => void guardedBackup(), 15_000);
    backupTimer = setInterval(() => void guardedBackup(), 24 * 60 * 60 * 1000);
    backupTimer.unref();

    // 持续录像索引每 5 分钟对账一次：文件系统是事实源，崩溃后自动补录缺失段。
    const recordingReconcileRun = async () => {
      try {
        const result = await reconcileRecordingSegments(store, continuousDir, {
          probe: recordingProbe ?? undefined,
        });
        if (result.inserted || result.updated || result.orphansRemoved) {
          log('info', 'recording_index_reconciled', result);
        }
      } catch (error) {
        log('error', 'recording_index_reconcile_failed', { message: error.message });
      }
    };
    scheduleStartup(() => void recordingReconcileRun(), 20_000);
    recordingTimer = setInterval(() => void recordingReconcileRun(), 5 * 60 * 1000);
    recordingTimer.unref();

    // 录像保留：先解除过期保护，再按保留天数与配额淘汰最旧的非保护段并删文件。
    const recordingRetentionRun = async () => {
      try {
        const dayMs = 24 * 60 * 60 * 1000;
        const at = Date.now();
        const unprotected = store.unprotectExpiredSegments(
          at - recordingProtectDays * dayMs,
        );
        const files = store.pruneRecordingSegments({
          before: at - recordingRetentionDays * dayMs,
          limit: 500,
        });
        const usage = store.recordingUsage();
        // 仍超配额时再淘汰一批最旧段，限制单轮 IO，剩余留给下一轮。
        // 这里允许淘汰受保护的段：保护期（默认 30 天）长于保留期（默认 14 天），
        // 若始终跳过保护段，recordingMaxBytes 这道磁盘保险对「有过告警的摄像头」
        // 完全失效——而那正是段最多、占用最大的点位。
        if (recordingMaxBytes > 0 && usage.bytes > recordingMaxBytes) {
          files.push(
            ...store.pruneRecordingSegments({ before: at, limit: 100, includeProtected: true }),
          );
        }
        let removed = 0;
        for (const file of new Set(files)) {
          const full = safeSegmentPath(continuousDir, file);
          if (!full) continue;
          try {
            await fsp.rm(full, { force: true });
            removed += 1;
          } catch {
            // 采集进程可能仍持有该文件；下轮对账会把仍存在的段补回索引。
          }
        }
        // 临时产物兜底：下载中断会留下 export 文件，会话异常退出会留下孤儿 play 目录。
        // 仅清理超过 30 分钟、且不属于活跃回放会话的条目，避免误删正在播放的分片。
        let tempRemoved = 0;
        const cutoff = at - 30 * 60_000;
        for (const dir of [continuousExportDir, continuousPlayDir]) {
          let entries = [];
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (dir === continuousPlayDir && playbackManager?.sessions.has(entry.name)) {
              continue;
            }
            const full = path.join(dir, entry.name);
            try {
              const stat = await fsp.stat(full);
              if (stat.mtimeMs >= cutoff) continue;
              await fsp.rm(full, { recursive: true, force: true });
              tempRemoved += 1;
            } catch {
              // 文件可能正被下载，下一轮再试。
            }
          }
        }
        if (unprotected || files.length || tempRemoved) {
          log('info', 'recording_retention_applied', {
            unprotected,
            pruned: files.length,
            filesRemoved: removed,
            tempRemoved,
            retentionDays: recordingRetentionDays,
            maxBytes: recordingMaxBytes,
          });
        }
      } catch (error) {
        log('warn', 'recording_retention_failed', { error: error.message });
      }
    };
    const guardedRecordingRetention = withInFlight('recording-retention', recordingRetentionRun);
    recordingRetentionTimer = setInterval(() => void guardedRecordingRetention(), 60 * 60 * 1000);
    recordingRetentionTimer.unref?.();
    scheduleStartup(() => void guardedRecordingRetention(), 120_000);

    const server = app.listen(port, '0.0.0.0', () => {
      log('info', 'server_started', {
        port,
        dataDir,
        dataDirSource: layout.reason,
        layoutMode: layout.mode,
        node: process.versions.node,
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
      if (recordingTimer) clearInterval(recordingTimer);
      if (recordingRotateTimer) clearInterval(recordingRotateTimer);
      if (recordingRetentionTimer) clearInterval(recordingRetentionTimer);
      if (detectionTimer) clearInterval(detectionTimer);
      if (offlineTimer) clearInterval(offlineTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (escalationTimer) clearInterval(escalationTimer);
      if (summaryTimer) clearInterval(summaryTimer);
      if (mediaTimer) clearInterval(mediaTimer);
      for (const handle of startupTimers) clearTimeout(handle);
      startupTimers.length = 0;
      demoSource?.stop();
      detectionEngine?.stopAll();
      captureManager?.stopAll();
      void playbackManager?.stopAll().catch(() => undefined);
      for (const client of sseClients) {
        try {
          // 告别事件：让前端知道「服务正在重启」而不是「网络断了」，
          // 否则客户端会在重启瞬间集体立即重连，形成重连风暴。
          client.res.write('event: server.shutdown\ndata: {"reason":"restart"}\n\n');
          client.res.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      streamManager.stopAll();
      edgeHub.close();
      // 顺序要紧：先 server.close()（停止接受新连接并标记已有连接待关闭），
      // 再 closeAllConnections()（强制销毁残留的 SSE / WebSocket 长连接）。
      // 反过来调用时，SSE 长连接会让 close 回调迟迟不触发，
      // 结果是 store.close() 永不执行、数据库连接与 WAL 得不到收尾。
      server.close(async () => {
        try {
          store.close();
        } finally {
          await releaseLock();
          process.exit(0);
        }
      });
      server.closeAllConnections?.();
      setTimeout(() => {
        // 活跃 SSE/WebSocket 可能让 server.close 迟迟不回调；强制退出前仍要释放锁与连接。
        log('warn', 'server_shutdown_forced', { timeoutMs: 8_000 });
        try {
          store?.close();
        } catch {
          // 已关闭则忽略
        }
        // 这是**主动停机**路径：数据已收尾、锁已释放，退出码应为 0，
        // 否则编排系统会把它当成异常退出并触发无意义的重启。
        void releaseLock().finally(() => process.exit(0));
      }, 8_000).unref();
    };
    // 回填致命异常回调：uncaughtException 时走同一条优雅停机路径。
    fatalHandler = shutdown;
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    // 启动失败时给出可操作的恢复指引：watchdog 会把 stderr 落到
    // data/server.err.log，连续失败后停止重试，运维需要明确知道下一步做什么。
    const corrupt = /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(
      String(error?.message ?? ''),
    );
    log('error', 'startup_failed', {
      message: error.message,
      ...(corrupt
        ? {
            hint:
              '数据库文件损坏：已保留 *.corrupt-* 备份。请确认无其它实例占用后，' +
              '用 data/backups/ 内最近一份备份替换 data/app.db（需同时移走 app.db-wal 与 app.db-shm），' +
              '或联系管理员评估数据恢复；修复后删除 data/startup-failed.marker 并重启守护。',
          }
        : {}),
    });
    try {
      if (backupTimer) clearInterval(backupTimer);
      if (recordingTimer) clearInterval(recordingTimer);
      if (recordingRotateTimer) clearInterval(recordingRotateTimer);
      if (recordingRetentionTimer) clearInterval(recordingRetentionTimer);
      if (detectionTimer) clearInterval(detectionTimer);
      if (offlineTimer) clearInterval(offlineTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      if (escalationTimer) clearInterval(escalationTimer);
      if (summaryTimer) clearInterval(summaryTimer);
      if (mediaTimer) clearInterval(mediaTimer);
      for (const handle of startupTimers) clearTimeout(handle);
      startupTimers.length = 0;
      detectionEngine?.stopAll();
      captureManager?.stopAll();
      void playbackManager?.stopAll().catch(() => undefined);
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

main().catch((error) => {
  // mkdir / 实例锁等前置步骤位于 try 之外，失败时也要留下结构化日志而非裸堆栈。
  log('error', 'startup_failed', { message: String(error?.message ?? error) });
  process.exit(1);
});

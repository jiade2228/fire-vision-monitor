import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { StreamManager } from './streams.mjs';

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

function sanitize(value) {
  return String(value ?? '')
    .replace(/rtsps?:\/\/[^\s@]+@/gi, 'rtsp://***@')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export async function loadEdgeConfig(configPath) {
  const absolute = path.resolve(configPath);
  const config = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const token = config.tokenEnv ? process.env[config.tokenEnv] : config.token;
  if (!token || String(token).length < 16) {
    throw new Error(`边缘网关 token 缺失或过短：${config.tokenEnv ?? 'token'}`);
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(config.gatewayId ?? '')) {
    throw new Error('gatewayId 必须是 1-64 位字母、数字、点、横线或下划线');
  }
  if (!config.centralUrl || !/^wss?:\/\//i.test(config.centralUrl)) {
    throw new Error('centralUrl 必须以 ws:// 或 wss:// 开头');
  }
  if (!config.cameras || typeof config.cameras !== 'object') {
    throw new Error('cameras 必须是对象');
  }
  const cameras = new Map();
  for (const [key, camera] of Object.entries(config.cameras)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(key)) {
      throw new Error(`摄像头标识无效：${key}`);
    }
    const sourceUrl = camera.sourceUrlEnv
      ? process.env[camera.sourceUrlEnv]
      : camera.sourceUrl;
    // RTSP 是主场景；http/https 源（网络摄像头、本地演示流）同样交给 FFmpeg 处理，
    // 便于在没有 NVR 的机器上联调隧道。
    if (!sourceUrl || !/^(rtsps?|https?):\/\//i.test(sourceUrl)) {
      throw new Error(
        `摄像头 ${key} 缺少 RTSP/HTTP 地址（sourceUrl 或 ${camera.sourceUrlEnv ?? 'sourceUrlEnv'}）`,
      );
    }
    cameras.set(key, {
      key,
      label: String(camera.label ?? key).slice(0, 64),
      sourceUrl,
      camera: { id: key, sourceUrl },
    });
  }
  if (cameras.size === 0) throw new Error('cameras 不能为空');
  const dataDir = config.dataDir
    ? path.resolve(path.dirname(absolute), config.dataDir)
    : path.join(path.dirname(absolute), 'edge-data');
  return {
    centralUrl: config.centralUrl,
    gatewayId: config.gatewayId,
    name: String(config.name ?? config.gatewayId).slice(0, 64),
    token: String(token),
    cameras,
    dataDir,
  };
}

async function handleRequest(manager, config, message, send) {
  const cameraConfig = config.cameras.get(String(message.cameraKey ?? ''));
  if (!cameraConfig) {
    send({
      type: 'response',
      id: message.id,
      ok: false,
      error: '未知摄像头标识',
    });
    return;
  }
  const resource = String(message.resource ?? '');
  try {
    if (resource === 'index.m3u8') {
      const playlist = await manager.playlist(cameraConfig.camera);
      send({
        type: 'response',
        id: message.id,
        ok: true,
        body: Buffer.from(playlist, 'utf8').toString('base64'),
      });
      return;
    }
    if (!/^[a-zA-Z0-9._-]+\.ts$/.test(resource)) {
      throw new Error('资源名无效');
    }
    const file = manager.segmentPath(cameraConfig.key, resource);
    if (!file) throw new Error('资源名无效');
    manager.touch(cameraConfig.key);
    const body = await fs.readFile(file);
    send({
      type: 'response',
      id: message.id,
      ok: true,
      body: body.toString('base64'),
    });
  } catch (error) {
    send({
      type: 'response',
      id: message.id,
      ok: false,
      error: sanitize(error instanceof Error ? error.message : '边缘网关请求失败'),
    });
  }
}

async function main() {
  const configIndex = process.argv.indexOf('--config');
  const configPath =
    configIndex >= 0
      ? process.argv[configIndex + 1]
      : process.env.EDGE_GATEWAY_CONFIG;
  if (!configPath) {
    console.error(
      '用法: node server/edge-gateway.mjs --config edge-gateway.json',
    );
    process.exit(2);
  }
  const config = await loadEdgeConfig(configPath);
  const manager = new StreamManager({
    dataDir: config.dataDir,
    maxStreams: Number(process.env.MAX_CONCURRENT_STREAMS || 8),
    logger: {
      warn: (event, fields) => log('warn', event, fields),
      info: (event, fields) => log('info', event, fields),
    },
  });
  if (!manager.init()) {
    throw new Error('现场网关未找到 FFmpeg');
  }

  const endpoint = new URL(config.centralUrl);
  endpoint.searchParams.set('gatewayId', config.gatewayId);
  endpoint.searchParams.set('token', config.token);
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;

  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(endpoint);
    socket.on('open', () => {
      attempt = 0;
      send({
        type: 'hello',
        gatewayId: config.gatewayId,
        name: config.name,
        cameras: [...config.cameras.values()].map((camera) => ({
          key: camera.key,
          label: camera.label,
        })),
      });
      log('info', 'edge_connected', {
        central: endpoint.origin,
        gatewayId: config.gatewayId,
        cameras: config.cameras.size,
      });
    });
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'hello-ack') {
        log('info', 'edge_registered', {
          gatewayId: config.gatewayId,
          cameras: message.cameras?.length ?? 0,
        });
        return;
      }
      if (message.type === 'hls') {
        // P0-2：裸 void 的 rejection 会变成未捕获异常并终止进程，显式兜住。
        void handleRequest(manager, config, message, send).catch((error) => {
          log('warn', 'edge_hls_request_failed', {
            gatewayId: config.gatewayId,
            message: error.message,
          });
        });
      }
    });
    socket.on('close', () => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(2000 * 2 ** Math.min(attempt - 1, 4), 30_000);
      log('warn', 'edge_disconnected', {
        gatewayId: config.gatewayId,
        retryMs: delay,
      });
      reconnectTimer = setTimeout(connect, delay);
      reconnectTimer.unref?.();
    });
    socket.on('error', (error) => {
      log('warn', 'edge_socket_error', {
        gatewayId: config.gatewayId,
        message: sanitize(error.message),
      });
    });
  };

  connect();
  const shutdown = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      socket?.close(1001, 'edge gateway shutdown');
    } catch {
      // ignore
    }
    manager.stopAll();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log('error', 'edge_startup_failed', { message: sanitize(error.message) });
    process.exit(1);
  });
}

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseEdgeSource(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'edge:') return null;
    const gatewayId = url.hostname;
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!gatewayId || !key) return null;
    return { gatewayId, key };
  } catch {
    return null;
  }
}

export class EdgeHub {
  constructor({ token, logger = console, requestTimeoutMs = 25_000 }) {
    this.token = String(token ?? '');
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.gateways = new Map();
    this.pending = new Map();
    this.wss = null;
    this.heartbeat = null;
  }

  get enabled() {
    return this.token.length >= 16;
  }

  attach(httpServer) {
    if (!this.enabled) return false;
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== '/gateway') {
        socket.destroy();
        return;
      }
      const token =
        url.searchParams.get('token') ??
        String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(token, this.token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const gatewayId =
        url.searchParams.get('gatewayId') ??
        String(request.headers['x-gateway-id'] ?? '');
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(gatewayId)) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request, gatewayId);
      });
    });
    this.wss.on('connection', (ws, _request, gatewayId) => this.handleConnection(ws, gatewayId));
    this.heartbeat = setInterval(() => {
      for (const gateway of this.gateways.values()) {
        if (gateway.alive === false) {
          gateway.ws.terminate();
          continue;
        }
        gateway.alive = false;
        try {
          gateway.ws.ping();
        } catch {
          gateway.ws.terminate();
        }
      }
    }, 20_000);
    this.heartbeat.unref?.();
    return true;
  }

  handleConnection(ws, gatewayId) {
    const previous = this.gateways.get(gatewayId);
    if (previous) previous.ws.close(4001, 'replaced by a new gateway connection');
    const gateway = {
      ws,
      gatewayId,
      name: gatewayId,
      cameras: new Map(),
      connectedAt: Date.now(),
      alive: true,
    };
    this.gateways.set(gatewayId, gateway);
    ws.on('pong', () => {
      gateway.alive = true;
    });
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'hello') {
        gateway.name = String(message.name ?? gatewayId).slice(0, 64);
        const cameras = Array.isArray(message.cameras) ? message.cameras : [];
        gateway.cameras = new Map(
          cameras
            .filter(
              (camera) =>
                camera &&
                /^[a-zA-Z0-9._-]{1,64}$/.test(String(camera.key ?? '')),
            )
            .map((camera) => [
              String(camera.key),
              String(camera.label ?? camera.key).slice(0, 64),
            ]),
        );
        ws.send(
          JSON.stringify({
            type: 'hello-ack',
            gatewayId,
            cameras: [...gateway.cameras.keys()],
          }),
        );
        this.logger.info?.('edge_connected', {
          gatewayId,
          name: gateway.name,
          cameras: gateway.cameras.size,
        });
        return;
      }
      if (message.type === 'response') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) {
          const body = String(message.body ?? '');
          if (body.length > 8_000_000) {
            pending.reject(new Error('边缘网关返回资源过大'));
          } else {
            pending.resolve(Buffer.from(body, 'base64'));
          }
        } else {
          pending.reject(new Error(String(message.error ?? '边缘网关返回错误')));
        }
      }
    });
    ws.on('close', () => {
      if (this.gateways.get(gatewayId) !== gateway) return;
      this.gateways.delete(gatewayId);
      for (const [id, pending] of this.pending) {
        if (pending.gatewayId === gatewayId) {
          clearTimeout(pending.timer);
          pending.reject(new Error('边缘网关连接已断开'));
          this.pending.delete(id);
        }
      }
      this.logger.info?.('edge_disconnected', { gatewayId });
    });
    ws.on('error', () => {
      ws.terminate();
    });
  }

  status() {
    return [...this.gateways.values()].map((gateway) => ({
      gatewayId: gateway.gatewayId,
      name: gateway.name,
      connectedAt: gateway.connectedAt,
      cameras: [...gateway.cameras.entries()].map(([key, label]) => ({ key, label })),
    }));
  }

  resolveSource(sourceUrl) {
    const source = parseEdgeSource(sourceUrl);
    if (!source) return { error: '边缘网关地址格式无效' };
    const gateway = this.gateways.get(source.gatewayId);
    if (!gateway) return { error: '现场网关未连接' };
    if (!gateway.cameras.has(source.key)) return { error: '网关未声明该摄像头' };
    return { gateway, ...source };
  }

  request(sourceUrl, resource, timeoutMs = this.requestTimeoutMs) {
    const resolved = this.resolveSource(sourceUrl);
    if (resolved.error) return Promise.reject(new Error(resolved.error));
    if (!/^[a-zA-Z0-9._-]+$/.test(resource)) {
      return Promise.reject(new Error('无效的网关资源名'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('等待现场网关响应超时'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        gatewayId: resolved.gatewayId,
      });
      try {
        resolved.gateway.ws.send(
          JSON.stringify({
            type: 'hls',
            id,
            cameraKey: resolved.key,
            resource,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  cameraState(sourceUrl) {
    const resolved = this.resolveSource(sourceUrl);
    if (resolved.error) return { connected: false, error: resolved.error };
    return {
      connected: true,
      gatewayId: resolved.gatewayId,
      key: resolved.key,
    };
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('边缘网关服务已关闭'));
    }
    this.pending.clear();
    for (const gateway of this.gateways.values()) gateway.ws.close(1001, 'server shutdown');
    this.gateways.clear();
    this.wss?.close();
  }
}

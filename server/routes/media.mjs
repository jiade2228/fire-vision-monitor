import { apiNotFound } from '../http/not-found.mjs';
import fsp from 'node:fs/promises';

import { StreamError } from '../streams.mjs';

/**
 * 媒体流服务接口：跨域 HLS/HTTP 视频代理（/proxy/*）、演示播放列表与分片
 * （/demo/:token/*）、RTSP/边缘网关转码后的 HLS 播放列表与分片（/streams/:cameraId/*）。
 *
 * 采用 deps 注入模式：main() 作用域内创建的 store/streamManager/edgeHub/demoSource
 * 与守卫、模块级辅助，统一通过 deps 传入；node 内建与第一方 StreamError 直接
 * import，避免与 index.mjs 循环依赖。行为与原内联路由完全一致。
 */

/**
 * @param {import('express').Express} app
 * @param {import('./deps.mjs').RouteDeps} deps
 */
export function registerMediaRoutes(app, deps) {
  const {
    store,
    demoSource,
    edgeHub,
    streamManager,
    canAccessCameraSite,
    requireAuth,
    log,
  } = deps;

  // 媒体点位守卫：取点位并校验协议白名单、源地址（可选）与站点访问权限。
  // 校验不通过返回 null，由各调用点发送各自的 404 响应（JSON / 文本 / 空体），
  // 以保持三处原有的响应形态与校验短路顺序。
  const mediaCameraFor = (req, cameraId, { protocols, requireSourceUrl = false }) => {
    const camera = store.getCamera(cameraId);
    if (
      !camera ||
      !protocols.includes(camera.protocol) ||
      (requireSourceUrl && !camera.sourceUrl) ||
      !canAccessCameraSite(req.user, camera, store)
    ) {
      return null;
    }
    return camera;
  };

  // 跨域 HLS/HTTP 视频代理：浏览器只连中心，解决跨域无法读帧识别的问题。
  // 仅允许代理与该点位已配置源站同源的资源，杜绝被当作通用代理（SSRF）。
  // 只暴露 GET/HEAD：HLS 播放列表与分片均不需要其它方法，缩小代理面。
  app.get(
    /^\/proxy\/(?<cameraId>[^/]+)(?:\/(?<tail>.*))?$/,
    requireAuth,
    async (req, res) => {
      const cameraId = req.params.cameraId;
      const tail = req.params.tail || '';
      const camera = mediaCameraFor(req, cameraId, { protocols: ['hls', 'http'] });
      if (!camera) {
        return apiNotFound(res, '该点位不支持代理取流或不存在');
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
    },
  );

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
    const camera = mediaCameraFor(req, req.params.cameraId, {
      protocols: ['rtsp', 'edge'],
      requireSourceUrl: true,
    });
    if (!camera) {
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
    const camera = mediaCameraFor(req, req.params.cameraId, {
      protocols: ['rtsp', 'edge'],
    });
    if (!camera) {
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
      if (!error) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).end();
    });
  });
}

import net from 'node:net';

/**
 * 测试专用：取一个系统当前空闲的 TCP 端口。
 *
 * 测试用固定端口会与「出站连接的临时源端口」随机相撞（Windows 上出站连接
 * 会占用本地端口，例如到 GitHub 的 HTTPS 连接恰好占住 4415），导致被测服务
 * 启动后立即退出（exit 0）且无任何错误日志。listen(0) 由操作系统挑选空闲端口，
 * 从根本上避免这类冲突。理论上 close 后到被测服务真正 listen 之间有极小竞态，
 * 但远低于固定端口撞出站连接的概率。
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

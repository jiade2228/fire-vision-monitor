import net from 'node:net';

/**
 * 测试专用：取一个系统当前空闲的 TCP 端口。
 *
 * 背景与三层防护：
 * 1. 测试用固定端口会与「出站连接的临时源端口」随机相撞（Windows 上出站连接
 *    会占用本地端口，例如到 GitHub 的 HTTPS 连接恰好占住 4415），导致被测服务
 *    启动后立即退出（exit 0）且无任何错误日志。因此改为 listen(0) 由操作系统挑选。
 * 2. listen(0) 释放端口后，操作系统可能**立即把同一个端口再分配给下一次调用**，
 *    于是同一测试文件里先后取到的 port 与 receiverPort 可能是同一个值，
 *    两个服务抢同一个端口 → 偶发失败（实测约 1/8 概率）。这里用本进程内的
 *    handedOut 集合保证同一进程不会重复分配同一端口。
 * 3. listen(0) 与子进程真正 bind 之间存在极小竞态窗口，期间若有出站连接抢占了
 *    该端口，子进程会以 EADDRINUSE 退出。因此取到端口后再验证一次「仍可绑定」，
 *    不可绑定就换一个端口重试，把偶发失败压到可忽略。
 */

/** 本进程已分配出去的端口，避免重复分配。 */
const handedOut = new Set();

/** 尝试绑定一次指定端口（成功后立即释放），返回该端口当前是否可用。 */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/** 让操作系统分配一个端口并立即释放。 */
function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 取一个当前空闲、且本进程未使用过的 TCP 端口。
 * @returns {Promise<number>} 端口号。
 */
export async function getFreePort() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let port;
    try {
      port = await pickPort();
    } catch {
      continue;
    }
    if (handedOut.has(port)) continue;
    if (!(await canBind(port))) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error('无法分配可用端口：连续 30 次取到的端口均不可用');
}

/**
 * 启动包装器（唯一推荐入口）。
 *
 * 为什么需要它：`server/index.mjs` 静态导入了 `node:sqlite`（22.5+ 才有）。
 * ES 模块在「链接阶段」就会解析该内置模块，因此任何写在 index.mjs 顶部的
 * 版本判断都来不及执行 —— 低版本 Node 会直接抛
 * `Cannot find module 'node:sqlite'`，与真实原因（Node 太旧）无关。
 *
 * 本文件只依赖 process / console，先做版本校验，再动态导入真正入口，
 * 从而把晦涩报错换成可操作的中文提示。
 *
 * 用法：
 *   node server/boot.mjs --port 4173
 */
import { assertNodeVersion, checkLongPathRisk } from './runtime-check.mjs';
import path from 'node:path';

try {
  const { version } = assertNodeVersion();
  // 长路径风险只在 Windows 成立，且不阻断启动，仅提示。
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const risk = checkLongPathRisk(dataDir);
  if (risk.risky) {
    console.warn(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'long_path_risk',
        message:
          `数据目录路径长度 ${risk.length} 超过 ${risk.limit}（Windows MAX_PATH 限制）。` +
          '录像文件路径会继续拼接约 60 字符，可能导致写入失败。建议把项目移动到更短的路径（如 D:\\fire\\）。',
        dataDir,
      }),
    );
  }
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      event: 'boot_precheck_ok',
      node: version,
    }),
  );
  await import('./index.mjs');
} catch (error) {
  // 版本不足时给出明确指引并以非 0 退出，让 watchdog / 部署脚本能据此熔断。
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      event: 'boot_precheck_failed',
      message: String(error?.message ?? error),
      code: error?.code ?? null,
    }),
  );
  process.exit(1);
}

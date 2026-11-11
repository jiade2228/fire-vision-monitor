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
import { applyResolvedBinaries, readFileDescriptorLimit } from './binary-locate.mjs';
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
  // macOS 经 launchd 启动时 PATH 不含 Homebrew 目录，这里仅在 PATH 未命中时
  // 用常见安装目录补位；显式配置与「PATH 能找到」两种情形行为完全不变。
  const binaries = applyResolvedBinaries();
  if (binaries.changed.length) {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'binary_resolved_from_default_dir',
        message:
          `PATH 中未找到 ${binaries.changed.join('/')}，已改用常见安装目录。` +
          '若目录不固定，建议在启动环境中显式设置 FFMPEG_PATH / FFPROBE_PATH。',
        ffmpeg: binaries.ffmpeg.command,
        ffprobe: binaries.ffprobe.command,
      }),
    );
  }

  // macOS 默认文件描述符软上限偏低（常见 256），多路流/SSE/录像并发时可能 EMFILE。
  // 只提示不修改：调整需在 launchd plist 或 shell 里设置。
  const fdLimit = await readFileDescriptorLimit();
  if (fdLimit !== null && fdLimit < 1024) {
    console.warn(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'fd_limit_low',
        message:
          `文件描述符软上限为 ${fdLimit}，多路视频/长连接场景可能耗尽（EMFILE）。` +
          '建议提升到 4096 以上（macOS 见 docs/MACOS-COMPAT.md）。',
        limit: fdLimit,
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

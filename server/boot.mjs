/**
 * 启动包装器（唯一推荐入口）。
 *
 * 为什么需要它：`server/index.mjs` 静态导入了 `node:sqlite`（22.5+ 才有）。
 * ES 模块在「链接阶段」就会解析该内置模块，因此任何写在 index.mjs 顶部的
 * 版本判断都来不及执行 —— 低版本 Node 会直接抛
 * `Cannot find module 'node:sqlite'`，与真实原因（Node 太旧）无关。
 *
 * 本文件只依赖 Node 内置模块，先做环境准备，再动态导入真正入口：
 *   1. Node 版本校验
 *   2. 读取配置文件（`--config`），注入环境变量（不覆盖已有值）
 *   3. 解析目录布局（源码 / 便携包 / 安装包），确定数据目录
 *   4. 定位 ffmpeg/ffprobe、检查长路径与文件描述符上限
 *   5. 打印生效配置，便于现场截图排障
 *
 * 用法：
 *   node server/boot.mjs --port 4173
 *   node server/boot.mjs --port 4173 --config config/fire-vision.env
 *   node server/boot.mjs --data-dir /var/lib/fire-vision
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, checkLongPathRisk } from './runtime-check.mjs';
import { applyResolvedBinaries, readFileDescriptorLimit } from './binary-locate.mjs';
import { resolveLayout, LAYOUT_REASON_ENV } from './app-paths.mjs';
import { loadEnvFile } from './env-file.mjs';

const argv = process.argv;
const argValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

try {
  const { version } = assertNodeVersion();

  // 1) 配置文件（--config）。必须在业务模块加载前完成：多个模块在 import
  //    阶段就读取 process.env 作为默认值。
  const configPath = argValue('--config');
  const configResult = configPath ? loadEnvFile(path.resolve(configPath)) : null;
  if (configResult?.missing) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'config_file_missing',
      message: `指定的配置文件不存在，已忽略：${path.resolve(configPath)}`,
    }));
  }
  if (configResult?.errors?.length) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'config_file_invalid_lines',
      message: '配置文件中有无法解析的行，已跳过',
      errors: configResult.errors.slice(0, 10),
    }));
  }

  // 2) 命令行 --data-dir 优先级高于环境变量与配置文件。
  const dataDirArg = argValue('--data-dir');
  if (dataDirArg) process.env.DATA_DIR = dataDirArg;

  // 3) 目录布局（无布局标记时与改造前行为一致）。
  const programRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const layout = resolveLayout({ projectRoot: programRoot, argv, env: process.env });
  // 统一由这里决定数据目录，index.mjs 与长路径检查共用同一结果。
  process.env.DATA_DIR = layout.dataDir;
  // D-07：把首次解析出的来源一并传下去，index.mjs 不再二次判定成「环境变量」。
  process.env[LAYOUT_REASON_ENV] = layout.reason;

  let appVersion = 'unknown';
  try {
    appVersion = JSON.parse(readFileSync(path.join(programRoot, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    // 打包裁剪掉 package.json 也不应阻断启动。
  }

  // 4) 长路径风险（仅 Windows 成立，不阻断启动）。
  const risk = checkLongPathRisk(layout.dataDir);
  if (risk.risky) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'long_path_risk',
      message:
        `数据目录路径长度 ${risk.length} 超过 ${risk.limit}（Windows MAX_PATH 限制）。` +
        '录像文件路径会继续拼接约 60 字符，可能导致写入失败。建议把数据目录放到更短的路径。',
      dataDir: layout.dataDir,
    }));
  }

  // 数据目录回退时必须显式告知：用户以为数据在安装目录，实际在别处。
  if (layout.fallback) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'data_dir_fallback',
      message: '默认数据目录不可写，已回退到备用位置。请确认磁盘空间与备份策略覆盖该路径。',
      dataDir: layout.dataDir,
      reason: layout.reason,
    }));
  }

  // 5) ffmpeg/ffprobe 定位：仅在 PATH 未命中时用常见安装目录补位。
  const binaries = applyResolvedBinaries();
  if (binaries.changed.length) {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'binary_resolved_from_default_dir',
      message:
        `PATH 中未找到 ${binaries.changed.join('/')}，已改用常见安装目录。` +
        '若目录不固定，建议在配置文件中显式设置 FFMPEG_PATH / FFPROBE_PATH。',
      ffmpeg: binaries.ffmpeg.command,
      ffprobe: binaries.ffprobe.command,
    }));
  }

  // 6) 文件描述符上限（macOS 默认偏低，多路流易 EMFILE）。只提示不修改。
  const fdLimit = await readFileDescriptorLimit();
  if (fdLimit !== null && fdLimit < 1024) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'fd_limit_low',
      message:
        `文件描述符软上限为 ${fdLimit}，多路视频/长连接场景可能耗尽（EMFILE）。` +
        '建议提升到 4096 以上（macOS 见 docs/MACOS-COMPAT.md）。',
      limit: fdLimit,
    }));
  }

  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level: 'info',
    event: 'boot_precheck_ok',
    node: version,
    version: appVersion,
    mode: layout.mode,
    programRoot,
    dataDir: layout.dataDir,
    dataDirSource: layout.reason,
    config: configPath ? path.resolve(configPath) : null,
    configLoaded: configResult?.loaded ?? 0,
    configSkipped: configResult?.skipped ?? [],
    port: argValue('--port') ?? process.env.PORT ?? '4173',
  }));

  await import('./index.mjs');
} catch (error) {
  // 版本不足/布局解析失败时给出明确指引并以非 0 退出，让守护与部署脚本能据此熔断。
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    event: 'boot_precheck_failed',
    message: String(error?.message ?? error),
    code: error?.code ?? null,
  }));
  process.exit(1);
}

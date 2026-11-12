/**
 * 便携包构建脚本。
 *
 * 产出结构（程序与数据分离，升级只替换 program/）：
 *   fire-vision-<version>-<platform>-<arch>/
 *   ├─ program/            可执行运行时 + 应用代码（升级时整体替换）
 *   │  ├─ node[.exe]
 *   │  ├─ ffmpeg[.exe] ffprobe[.exe]     （若找到）
 *   │  ├─ server/ dist/ node_modules/ package.json
 *   ├─ config/fire-vision.env.example
 *   ├─ data/               运行期数据（升级不动）
 *   ├─ logs/
 *   ├─ start.cmd / start.sh
 *   ├─ README-QUICKSTART.txt
 *   └─ .fire-vision-layout.json          （运行期据此选择布局）
 *
 * 为什么不做单文件可执行（Node SEA）：需要把 ESM 全量打成 CJS、把 dist 作为
 * asset 嵌入，且现场无法看日志排查。本项目无原生模块，自带运行时的改造成本
 * 几乎为零，且完全保留可诊断性。
 *
 * 用法：
 *   node scripts/package/portable.mjs                 # 当前平台，自动找 ffmpeg
 *   node scripts/package/portable.mjs --no-ffmpeg     # 不含 FFmpeg（体积小，需自备）
 *   node scripts/package/portable.mjs --ffmpeg-dir /path/to/bin
 *   node scripts/package/portable.mjs --out dist-packages --archive
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const argv = process.argv;
const hasFlag = (name) => argv.includes(name);
const argValue = (name, fallback = '') => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const platform = argValue('--platform', process.platform); // win32 / darwin / linux
const arch = argValue('--arch', process.arch);
const outRoot = path.resolve(argValue('--out', path.join(repoRoot, 'dist-packages')));
const withFfmpeg = !hasFlag('--no-ffmpeg');
const wantArchive = hasFlag('--archive');
const ffmpegDirArg = argValue('--ffmpeg-dir');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const suffix = platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : 'linux';
const bundleName = `fire-vision-${version}-${suffix}-${arch}`;
const bundleDir = path.join(outRoot, bundleName);
const programDir = path.join(bundleDir, 'program');

const log = (level, message) => {
  const prefix = level === 'error' ? '✖' : level === 'warn' ? '!' : '·';
  console.log(`${prefix} ${message}`);
};

/** 递归复制目录（保留文件内容；不跟随符号链接，避免把系统库拖进来）。 */
async function copyDir(from, to, { filter } = {}) {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (filter && !filter(src, entry)) continue;
    if (entry.isDirectory()) {
      await copyDir(src, dest, { filter });
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dest);
    }
  }
}

/** 在 PATH 或指定目录中找可执行文件。 */
function findBinary(name) {
  const ext = platform === 'win32' ? '.exe' : '';
  const candidates = [];
  if (ffmpegDirArg) candidates.push(path.join(ffmpegDirArg, name + ext));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name + ext));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 继续 */ }
  }
  return null;
}

/** 运行时依赖白名单：只带生产依赖，避免把 vite/react 等开发包打进包里。 */
function productionDeps() {
  return Object.keys(pkg.dependencies || {});
}

/** 递归收集某个包及其传递依赖的目录名。 */
async function collectDependencyTree(names) {
  const seen = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const pkgFile = path.join(repoRoot, 'node_modules', name, 'package.json');
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(pkgFile, 'utf8'));
    } catch {
      log('warn', `依赖缺失，跳过：${name}`);
      continue;
    }
    seen.add(name);
    for (const dep of Object.keys(meta.dependencies || {})) queue.push(dep);
  }
  return [...seen];
}

async function main() {
  log('info', `构建便携包：${bundleName}`);
  log('info', `输出目录：${outRoot}`);

  // 1) 清理旧产物，避免残留文件混入
  await fsp.rm(bundleDir, { recursive: true, force: true });

  // 2) program/：Node 运行时
  await fsp.mkdir(programDir, { recursive: true });
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const nodeSource = process.execPath;
  if (platform !== process.platform) {
    throw new Error(`跨平台打包需要对应平台的 Node 二进制；当前只能为 ${process.platform} 打包`);
  }
  await fsp.copyFile(nodeSource, path.join(programDir, nodeName));
  if (platform !== 'win32') await fsp.chmod(path.join(programDir, nodeName), 0o755);
  log('ok', `Node 运行时：${nodeName} (${(fs.statSync(nodeSource).size / 1048576).toFixed(1)} MB)`);

  // 3) program/：应用代码与前端产物
  await copyDir(path.join(repoRoot, 'server'), path.join(programDir, 'server'), {
    // 测试文件与测试辅助不随包分发
    filter: (src, entry) => !entry.name.endsWith('.test.mjs'),
  });
  await copyDir(path.join(repoRoot, 'dist'), path.join(programDir, 'dist'));
  await fsp.copyFile(path.join(repoRoot, 'package.json'), path.join(programDir, 'package.json'));
  log('ok', '应用代码与前端产物已复制');

  // 4) program/node_modules：仅生产依赖（含传递依赖）
  const deps = await collectDependencyTree(productionDeps());
  for (const name of deps) {
    await copyDir(
      path.join(repoRoot, 'node_modules', name),
      path.join(programDir, 'node_modules', name),
    );
  }
  log('ok', `运行时依赖 ${deps.length} 个：${deps.join(', ')}`);

  // 5) program/：FFmpeg
  if (withFfmpeg) {
    const ffmpeg = findBinary('ffmpeg');
    const ffprobe = findBinary('ffprobe');
    if (ffmpeg) {
      const mb = fs.statSync(ffmpeg).size / 1048576;
      await fsp.copyFile(ffmpeg, path.join(programDir, path.basename(ffmpeg)));
      log('ok', `FFmpeg：${mb.toFixed(1)} MB`);
      // 实测：Gyan "full" 构建单个可执行约 217MB，ffmpeg+ffprobe 会让包膨胀到 500MB+，
      // 不适合分发。正式发布请使用 essentials/精简构建（各约 30-40MB）。
      if (mb > 80) {
        log('warn', `FFmpeg 体积偏大（${mb.toFixed(0)}MB）。建议改用精简构建（essentials，约 30-40MB），`);
        log('warn', '  否则含 ffprobe 的完整包将超过 500MB。可用 --ffmpeg-dir 指定精简版目录。');
      }
    } else {
      log('warn', '未找到 ffmpeg，包内将不含转码能力（可用 --ffmpeg-dir 指定）');
    }
    if (ffprobe) {
      await fsp.copyFile(ffprobe, path.join(programDir, path.basename(ffprobe)));
      log('ok', 'ffprobe 已包含');
    } else {
      log('warn', '未找到 ffprobe：测流与段时长校准不可用');
    }
  } else {
    log('warn', '已指定 --no-ffmpeg：目标机需自行安装 FFmpeg 并加入 PATH');
  }

  // 6) 目录骨架：config / data / logs
  await fsp.mkdir(path.join(bundleDir, 'config'), { recursive: true });
  await fsp.mkdir(path.join(bundleDir, 'data'), { recursive: true });
  await fsp.mkdir(path.join(bundleDir, 'logs'), { recursive: true });

  // 7) 布局标记：运行期据此选择「数据落在包内」
  await fsp.writeFile(
    path.join(bundleDir, '.fire-vision-layout.json'),
    `${JSON.stringify({ mode: 'portable', bundledAt: new Date().toISOString(), version }, null, 2)}\n`,
    'utf8',
  );

  // 8) 配置模板
  await fsp.writeFile(
    path.join(bundleDir, 'config', 'fire-vision.env.example'),
    [
      '# 火情视频识别监控平台 · 配置示例',
      '# 复制为 fire-vision.env 后修改；环境变量优先级高于本文件。',
      '# 所有项均为可选，留空即使用默认值。',
      '',
      'PORT=4173',
      '# DATA_DIR 留空则使用包内 data/ 目录',
      '# DATA_DIR=',
      '',
      '# 服务端 7×24 检测（0 关闭）',
      'SERVER_DETECTION=1',
      '# 持续录像总闸（1 开启）',
      'RECORDING=0',
      '',
      '# FFmpeg 已随包提供；如需使用系统版本可显式指定',
      '# FFMPEG_PATH=',
      '# FFPROBE_PATH=',
      '',
      '# 公网部署建议开启（拦截环回/私网 Webhook 目标）',
      '# NOTIFY_BLOCK_PRIVATE=1',
      '',
      '# 反代后按层数信任 X-Forwarded-For',
      '# TRUST_PROXY=1',
      '',
    ].join('\n'),
    'utf8',
  );

  // 9) 启动脚本
  if (platform === 'win32') {
    await fsp.writeFile(
      path.join(bundleDir, 'start.cmd'),
      [
        '@echo off',
        'chcp 65001 >nul',
        'cd /d "%~dp0"',
        'set NODE_ENV=production',
        'if exist "config\\fire-vision.env" (',
        '  "program\\node.exe" "program\\server\\boot.mjs" --config "config\\fire-vision.env" %*',
        ') else (',
        '  "program\\node.exe" "program\\server\\boot.mjs" %*',
        ')',
        'echo.',
        'echo 服务已退出。按任意键关闭窗口。',
        'pause >nul',
        '',
      ].join('\r\n'),
      'utf8',
    );
  } else {
    const launcher = [
      '#!/usr/bin/env bash',
      '# 便携包启动脚本：定位到脚本所在目录，避免依赖调用者的 cwd。',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      'export NODE_ENV=production',
      'if [[ -f "config/fire-vision.env" ]]; then',
      '  exec "./program/node" "./program/server/boot.mjs" --config "config/fire-vision.env" "$@"',
      'else',
      '  exec "./program/node" "./program/server/boot.mjs" "$@"',
      'fi',
      '',
    ].join('\n');
    const shPath = path.join(bundleDir, 'start.sh');
    await fsp.writeFile(shPath, launcher, 'utf8');
    await fsp.chmod(shPath, 0o755);
  }

  // 10) 快速开始（D-08：目录说明按实际打包内容渲染，不再硬编码「含 FFmpeg」）
  const startHint = platform === 'win32' ? '双击 start.cmd' : './start.sh';
  // D-08：按包内实际是否存在 FFmpeg 渲染文案（不引用上方 if 块内的局部变量）。
  const bundledFfmpeg = fs.existsSync(path.join(programDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  const programDesc = bundledFfmpeg
    ? 'program/   程序（Node 运行时 + 应用 + FFmpeg），升级时整体替换'
    : 'program/   程序（Node 运行时 + 应用；本包不含 FFmpeg），升级时整体替换';
  const unixHints = platform === 'win32'
    ? []
    : [
        '  · 若提示「Permission denied」，执行一次：chmod +x start.sh program/node',
        '    （个别环境的 umask 会让解压后的可执行位丢失）。',
      ];
  const ffmpegHints = bundledFfmpeg
    ? []
    : [
        '  · 本包不含 FFmpeg：HLS/HTTP 点位可直接播放，但 RTSP 转码、持续录像、',
        '    告警短视频、一键测流、回放导出均不可用。需要这些能力时请安装 FFmpeg',
        '    并加入 PATH（或在 config 中设置 FFMPEG_PATH），重新启动即可。',
      ];
  await fsp.writeFile(
    path.join(bundleDir, 'README-QUICKSTART.txt'),
    [
      `火情视频识别监控平台 v${version}（便携版 ${suffix}-${arch}）`,
      '',
      '一、启动',
      `  1. ${startHint}`,
      '  2. 浏览器打开 http://127.0.0.1:4173',
      '  3. 首次访问会引导创建管理员账号',
      '',
      '二、目录说明',
      programDesc,
      '  config/    配置文件（复制 fire-vision.env.example 为 fire-vision.env）',
      '  data/      全部运行数据（数据库、凭据密钥、录像、备份）',
      '  logs/      日志（logs/server.log；控制台同步输出）',
      '',
      '三、重要提醒',
      ...unixHints,
      ...ffmpegHints,
      '  · data/ 与 config/ 请定期备份；迁移时整个目录一起拷贝。',
      '  · data/credentials.key 与 data/app.db 必须成对保存，否则已加密的渠道配置无法解密。',
      '  · 如需放到 Program Files 等只读目录，请在 config 中显式设置 DATA_DIR，',
      '    否则启动会自动回退到用户目录并打印 data_dir_fallback 警告。',
      '  · 不要同时启动多个实例（SQLite 单写，data/instance.lock 会阻止）。',
      '',
      `四、详细文档：见仓库 README.md / DELIVERY.md / docs/MACOS-COMPAT.md`,
      '',
    ].join('\n'),
    'utf8',
  );

  // 11) 体积统计
  const dirSize = async (dir) => {
    let total = 0;
    const walk = async (current) => {
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) total += (await fsp.stat(full)).size;
      }
    };
    await walk(dir);
    return total;
  };
  const totalBytes = await dirSize(bundleDir);
  log('ok', `产物体积：${(totalBytes / 1048576).toFixed(1)} MB → ${bundleDir}`);

  // 12) 可选压缩
  if (wantArchive) {
    const zipPath = path.join(outRoot, `${bundleName}.zip`);
    try {
      // 自带 ZIP 写入：系统 tar 行为不一致 —— Git Bash 的 GNU tar 用 -a 不会
      // 生成 zip，只会生成 tar 却叫 .zip，用户双击解压会失败。
      const startedAt = Date.now();
      const result = zipDirectory({ sourceDir: bundleDir, outFile: zipPath, rootName: bundleName });
      log('ok', `压缩包：${zipPath} (${(result.bytes / 1048576).toFixed(1)} MB, ${result.files} 个文件, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (error) {
      log('warn', `压缩失败（可手动压缩目录）：${error.message}`);
    }
  }

  console.log('');
  log('ok', '完成。验证建议：把整个目录拷到一台未装 Node/FFmpeg 的机器，双击启动。');
}

main().catch((error) => {
  console.error(`✖ 打包失败：${error?.message ?? error}`);
  process.exit(1);
});

/**
 * 安装器工程生成与构建（P2）。
 *
 * 设计取舍：
 *   - 复用便携包产物（`portable.mjs`），安装器只负责「放置 + 写配置 + 注册自启 + 卸载信息」，
 *     避免两套文件布局导致行为漂移。
 *   - 不内置 WinSW 等需要额外下载的二进制：Windows 开机自启用「启动文件夹快捷方式」实现，
 *     无需管理员权限、无外部依赖、行为可预期。系统级服务（SYSTEM 账户）留作文档说明。
 *   - 工具链缺失时不假装成功：明确打印安装命令并以非 0 退出（可用 --dry-run 只生成工程）。
 *
 * 用法：
 *   node scripts/package/installer.mjs --target win --dry-run
 *   node scripts/package/installer.mjs --target win --port 4173
 *   node scripts/package/installer.mjs --target linux --format deb
 *   node scripts/package/installer.mjs --target macos --format pkg --dry-run
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertArtifactComplete } from './verify-artifacts.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const templateDir = path.join(scriptDir, 'templates');
const argv = process.argv;
const hasFlag = (name) => argv.includes(name);
const argValue = (name, fallback = '') => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const target = argValue('--target', process.platform);
const dryRun = hasFlag('--dry-run');
const outRoot = path.resolve(argValue('--out', path.join(repoRoot, 'dist-packages')));
const port = Number(argValue('--port', '4173'));
const publisher = argValue('--publisher', 'Fire Vision');
const skipBundle = hasFlag('--skip-bundle');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const arch = argValue('--arch', process.arch);

const log = (level, message) => {
  const prefix = level === 'error' ? '✖' : level === 'warn' ? '!' : level === 'ok' ? '✔' : '·';
  console.log(`${prefix} ${message}`);
};

/** 读取模板并替换 {{KEY}} 占位符。 */
function render(templateName, vars) {
  const file = path.join(templateDir, templateName);
  let text = fs.readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(String(value));
  }
  const left = text.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) throw new Error(`${templateName} 存在未替换占位符：${[...new Set(left)].join(', ')}`);
  return text;
}

/** 便携包目录名（与 portable.mjs 保持一致）。 */
function bundleNameFor(t) {
  const suffix = t === 'win32' || t === 'win' ? 'win' : t === 'darwin' || t === 'macos' ? 'macos' : 'linux';
  return `fire-vision-${version}-${suffix}-${arch}`;
}

/** 确保便携包产物存在；不存在则调用打包脚本。 */
async function ensureBundle(t) {
  if (skipBundle) {
    const dir = path.join(outRoot, bundleNameFor(t));
    if (!fs.existsSync(dir)) throw new Error(`指定 --skip-bundle 但找不到产物目录：${dir}`);
    return dir;
  }
  log('info', '先构建便携包产物…');
  const platformArg = t === 'win' || t === 'win32' ? 'win32' : t === 'macos' || t === 'darwin' ? 'darwin' : 'linux';
  execFileSync(process.execPath, [
    path.join(scriptDir, 'portable.mjs'),
    '--platform', platformArg,
    '--arch', arch,
    '--out', outRoot,
  ], { stdio: 'inherit' });
  return path.join(outRoot, bundleNameFor(t));
}

function toolAvailable(cmd, extraPaths = []) {
  for (const candidate of extraPaths) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { encoding: 'utf8' });
  if (result.status === 0) {
    return String(result.stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || cmd;
  }
  return null;
}

// ---------------- Windows (NSIS) ----------------
async function buildWindows(bundleDir) {
  const nsis = toolAvailable('makensis', [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]);
  const projectDir = path.join(outRoot, 'installer-win');
  await fsp.rm(projectDir, { recursive: true, force: true });
  await fsp.mkdir(projectDir, { recursive: true });

  const outFile = path.join(outRoot, `fire-vision-${version}-win-${arch}-setup.exe`);
  // VIProductVersion 要求四段数字：1.2.0 → 1.2.0.0
  const version4 = `${version.replace(/[^0-9.].*$/, '')}`.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
  const script = render('installer.nsi.tpl', {
    APP_VERSION: version,
    APP_VERSION_4: version4,
    APP_PUBLISHER: publisher,
    APP_ARCH: arch === 'arm64' ? 'arm64' : 'x64',
    BUNDLE_DIR: bundleDir,
    OUTFILE: outFile,
    DEFAULT_PORT: port,
    PRODUCT_NAME: 'Fire Vision',
  });
  const scriptPath = path.join(projectDir, 'installer.nsi');
  // NSIS 3 Unicode 版要求脚本带 UTF-8 BOM，否则中文字符串会乱码或编译报错。
  // 其它模板（shell / XML）不能加 BOM：会破坏 shebang 或 XML 声明。
  await fsp.writeFile(scriptPath, `\uFEFF${script}`, 'utf8');
  log('ok', `NSIS 工程已生成：${scriptPath}`);

  if (!nsis) {
    log('warn', '未找到 makensis，仅生成工程文件（未编译）。安装 NSIS 后重跑即可：');
    log('warn', '  winget install --id NSIS.NSIS -e   或   https://nsis.sourceforge.io/Download');
    return { ok: false, reason: 'missing-makensis', artifact: scriptPath };
  }
  if (dryRun) {
    log('info', '--dry-run：跳过实际编译');
    return { ok: true, dryRun: true, artifact: scriptPath };
  }
  log('info', `调用 makensis 编译…`);
  const result = spawnSync(nsis, ['/V2', scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`makensis 失败（退出码 ${result.status}）`);
  log('ok', `安装包：${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
  return { ok: true, artifact: outFile };
}

// ---------------- Linux (deb/rpm via nfpm) ----------------

/**
 * 打包前确认便携包本身完整。
 * v1.2.6 的 P0 教训：nfpm 配置写成 type: dir 时只会创建空目录，
 * 产物看起来“打包成功”，装完却没有应用代码。先卡住输入，再校验输出。
 */
function assertBundleComplete(bundleDir) {
  const required = [
    'program/node',
    'program/package.json',
    'program/server/boot.mjs',
    'program/dist/index.html',
    'start.sh',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(bundleDir, rel)));
  if (missing.length) {
    throw new Error(`便携包不完整，缺少：${missing.join('、')}（请先重新构建 portable 包）`);
  }
  // POSIX 上 node 必须带执行位；Windows 的 NTFS 没有 Unix 执行位语义，跳过。
  if (process.platform !== 'win32') {
    const nodePath = path.join(bundleDir, 'program/node');
    if ((fs.statSync(nodePath).mode & 0o111) === 0) {
      throw new Error('便携包不完整：program/node 缺少可执行位（请重新构建 portable 包）');
    }
  }
}

/**
 * 打包后校验安装包内容。
 *
 * v1.2.8 起改为直接解析归档结构（见 verify-artifacts.mjs），不再依赖
 * dpkg-deb / rpm 是否存在：工具缺失时旧实现只告警并跳过，等于闸门形同虚设。
 * 现在任一必备文件缺失或 node 无执行位都会抛错，中止打包。
 *
 * @param {string} file 产物路径。
 * @param {string} format deb / rpm。
 */
function verifyLinuxPackage(file, format) {
  let result;
  try {
    result = assertArtifactComplete(file);
  } catch (error) {
    // 不留坏包：校验失败立即删除产物，避免被误上传。
    fs.rmSync(file, { force: true });
    throw error;
  }
  log('ok', `${format} 内容校验通过（${result.total} 条目，四项必备文件齐全，node 可执行）`);
}

async function buildLinux(bundleDir) {
  assertBundleComplete(bundleDir);
  const nfpm = toolAvailable('nfpm', [path.join(repoRoot, 'tools', 'nfpm')]);
  const projectDir = path.join(outRoot, 'installer-linux');
  await fsp.rm(projectDir, { recursive: true, force: true });
  await fsp.mkdir(projectDir, { recursive: true });

  const unit = render('systemd.service.tpl', {
    SERVICE_NAME: 'fire-vision',
    INSTALL_DIR: '/opt/fire-vision',
    DATA_DIR: '/var/lib/fire-vision',
    PORT: port,
  });
  const unitPath = path.join(projectDir, 'fire-vision.service');
  await fsp.writeFile(unitPath, unit, 'utf8');
  log('ok', `systemd unit 已生成：${unitPath}`);

  const postinstall = render('postinstall.sh.tpl', {
    INSTALL_DIR: '/opt/fire-vision',
    DATA_DIR: '/var/lib/fire-vision',
    SERVICE_NAME: 'fire-vision',
    PORT: port,
  });
  await fsp.writeFile(path.join(projectDir, 'postinstall.sh'), postinstall, 'utf8');
  await fsp.chmod(path.join(projectDir, 'postinstall.sh'), 0o755);

  const nfpmConfig = render('nfpm.yaml.tpl', {
    APP_VERSION: version,
    APP_ARCH: arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch,
    BUNDLE_DIR: bundleDir,
    PROJECT_DIR: projectDir,
    MAINTAINER: publisher,
  });
  const nfpmPath = path.join(projectDir, 'nfpm.yaml');
  await fsp.writeFile(nfpmPath, nfpmConfig, 'utf8');
  log('ok', `nfpm 配置已生成：${nfpmPath}`);

  if (!nfpm) {
    log('warn', '未找到 nfpm，仅生成工程文件（未打包）。安装后重跑即可：');
    log('warn', '  go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest');
    log('warn', '  或下载：https://github.com/goreleaser/nfpm/releases');
    return { ok: false, reason: 'missing-nfpm', artifact: nfpmPath };
  }
  if (dryRun) {
    log('info', '--dry-run：跳过实际打包');
    return { ok: true, dryRun: true, artifact: nfpmPath };
  }
  for (const format of ['deb', 'rpm']) {
    const out = path.join(outRoot, `fire-vision_${version}_${arch}.${format}`);
    log('info', `打包 ${format}…`);
    const result = spawnSync(nfpm, ['package', '--config', nfpmPath, '--packager', format, '--target', out], {
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`nfpm ${format} 失败（退出码 ${result.status}）`);
    verifyLinuxPackage(out, format);
    log('ok', `${format}：${out}`);
  }
  return { ok: true, artifact: path.join(outRoot, `fire-vision_${version}_${arch}.deb`) };
}

// ---------------- macOS (pkgbuild) ----------------
async function buildMacos(bundleDir) {
  if (process.platform !== 'darwin') {
    log('warn', 'macOS 安装包必须在 macOS 上构建（pkgbuild 仅随 Xcode 命令行工具提供）');
    log('warn', '  安装工具：xcode-select --install');
  }
  const pkgbuild = toolAvailable('pkgbuild');
  const projectDir = path.join(outRoot, 'installer-macos');
  await fsp.rm(projectDir, { recursive: true, force: true });
  await fsp.mkdir(projectDir, { recursive: true });

  const scriptsDir = path.join(projectDir, 'scripts');
  await fsp.mkdir(scriptsDir, { recursive: true });
  const postinstall = render('macos-postinstall.sh.tpl', {
    INSTALL_DIR: '/usr/local/fire-vision',
    DATA_DIR: '/usr/local/fire-vision/data',
    LABEL: 'com.flamevision.monitor',
    PORT: port,
  });
  const postinstallPath = path.join(scriptsDir, 'postinstall');
  await fsp.writeFile(postinstallPath, postinstall, 'utf8');
  await fsp.chmod(postinstallPath, 0o755);

  // 组装 payload：/usr/local/fire-vision/{program,config,data,logs}
  const payloadRoot = path.join(projectDir, 'payload');
  await fsp.mkdir(path.join(payloadRoot, 'usr', 'local', 'fire-vision'), { recursive: true });
  await fsp.cp(bundleDir, path.join(payloadRoot, 'usr', 'local', 'fire-vision'), {
    recursive: true,
    force: true,
  });
  log('ok', `payload 已组装：${payloadRoot}`);

  const outFile = path.join(outRoot, `fire-vision-${version}-macos-${arch}.pkg`);
  const args = [
    '--root', payloadRoot,
    '--identifier', 'com.flamevision.monitor.pkg',
    '--version', version,
    '--install-location', '/',
    '--scripts', scriptsDir,
    outFile,
  ];
  const cmdLine = `pkgbuild ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  await fsp.writeFile(path.join(projectDir, 'build-command.txt'), `${cmdLine}\n`, 'utf8');
  log('ok', `pkgbuild 命令已生成：${path.join(projectDir, 'build-command.txt')}`);

  if (!pkgbuild) {
    log('warn', '当前环境无 pkgbuild（需 macOS + Xcode 命令行工具），仅生成工程与命令');
    return { ok: false, reason: 'missing-pkgbuild', artifact: projectDir };
  }
  if (dryRun) {
    log('info', '--dry-run：跳过实际打包');
    return { ok: true, dryRun: true, artifact: projectDir };
  }
  log('info', '调用 pkgbuild…');
  const result = spawnSync(pkgbuild, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pkgbuild 失败（退出码 ${result.status}）`);
  log('ok', `安装包：${outFile}`);
  return { ok: true, artifact: outFile };
}

async function main() {
  log('info', `目标平台：${target} | 版本：${version} | 端口：${port}${dryRun ? ' | DRY-RUN' : ''}`);
  const bundleDir = await ensureBundle(target);
  let result;
  if (target === 'win' || target === 'win32') result = await buildWindows(bundleDir);
  else if (target === 'linux') result = await buildLinux(bundleDir);
  else if (target === 'macos' || target === 'darwin') result = await buildMacos(bundleDir);
  else throw new Error(`不支持的目标平台：${target}（可选 win / linux / macos）`);

  if (!result.ok) {
    log('warn', '工程已生成但未产出安装包，原因：' + result.reason);
    log('warn', '这是环境缺少工具链，不是脚本错误。按上方提示安装后重跑。');
    process.exit(2);
  }
  log('ok', `完成：${result.artifact}`);
}

main().catch((error) => {
  console.error(`✖ 构建失败：${error?.message ?? error}`);
  process.exit(1);
});

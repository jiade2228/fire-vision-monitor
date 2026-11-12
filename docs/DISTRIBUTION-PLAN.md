# 部署流程评估与发行版打包方案

> 状态：**P0 + P1 + P2 已实施**（便携包可用、Windows 安装包已编译通过），P3–P4 待实施 · 基线：v1.2.0 · 2026-11-12
> 本文评估当前部署方式的复杂度，并给出可分发发行版的设计；文中"体积/耗时"均为实测或明确标注的估算，未实施项已注明。

---

## 1. 现状评估

### 1.1 部署路径与步骤数

当前只有一条正式路径：**源码部署**。以全新机器为例：

| # | 步骤 | 是否需管理员/额外下载 | 失败后果 |
|---|---|---|---|
| 1 | 安装 Node.js ≥ 22.5 | 是（下载安装包） | 版本不足直接启动失败 |
| 2 | 安装 FFmpeg 并加入 PATH | 是（下载/解压/配 PATH） | 转码、录像、抓拍全部不可用 |
| 3 | 获取代码（git clone 或解压） | — | — |
| 4 | `npm ci` | 需联网 | 内网/代理环境易失败 |
| 5 | `npm run build` | — | 缺 dist 则只能调 API，无界面 |
| 6 | 配置环境变量（端口/数据目录等） | 可选 | 配错走默认，难察觉 |
| 7 | 启动服务（`npm start`） | — | 端口占用/权限问题 |
| 8 | 配置守护与开机自启 | 是（Windows 需手工放启动项） | 断电/崩溃后不自恢复 |
| 9 | 放行防火墙端口 | 是（需提权） | 局域网其他机器访问不了 |

**结论：9 步，其中 4 步需要额外下载或提权。** 目标用户是消防/安防现场人员与集成商，不是开发者，这条路径的门槛明显过高。

### 1.2 真实踩坑记录（本项目开发与部署中实际发生）

这些问题不是假设，而是过去几轮真实遇到并修复的，说明"环境差异"是当前最大的部署风险源：

| 类别 | 具体现象 | 当前缓解手段 | 打包能否根除 |
|---|---|---|---|
| Node 版本 | 低版本报 `Cannot find module 'node:sqlite'`，与真实原因无关 | `boot.mjs` 前置校验 | ✅ 内嵌运行时后彻底消失 |
| FFmpeg 路径 | macOS 经 launchd 启动时 PATH 无 Homebrew，全站转码失败 | 探测常见安装目录 | ✅ 内嵌后不依赖系统 PATH |
| 编码器缺失 | 裁剪版 ffmpeg 无 `libx264`，前端只表现为"一直转圈" | 启动探测 + 回退 | ✅ 可固定随包版本 |
| 数据目录权限 | 安装到 `Program Files` 后不可写 | 文档提醒 | ⚠️ 需安装器引导选目录 |
| 端口占用 | 与其它程序冲突，启动即退 | 部署脚本做归属判定 | ⚠️ 安装时检测+可改端口 |
| 长路径 | Windows MAX_PATH 导致录像写入失败 | 启动告警 | ⚠️ 安装器限制目录长度 |
| 文件描述符 | macOS 默认 256，多路流触发 `EMFILE` | 启动告警 | ⚠️ 守护配置调高 |
| 证书/代理 | 内网 TLS 拦截导致拉依赖失败 | 无（需现场处理） | ✅ 离线包规避 |

### 1.3 配置面过宽

代码中有 **101 处** `process.env` 引用，README 列出的环境变量约 40 项。对现场人员而言，用环境变量配置既不可发现也不可校验。

**结论**：发行版必须提供**配置文件 + 图形化引导**，环境变量仅作为高级覆盖手段保留。

### 1.4 已具备的有利条件

| 条件 | 实测/核对结果 | 对打包的意义 |
|---|---|---|
| 无原生模块 | 运行时依赖仅 `express`/`fast-xml-parser`/`ws`，共 82 个文件，无 `.node`/`binding.gyp` | **不需要 per-platform 重编译**，同一份代码可在所有平台运行 |
| 静态资源定位 | `__dirname` 取自 `import.meta.url`，`dist` 相对代码位置解析 | 不依赖 cwd，打包后目录结构固定即可 |
| 已实测"任意 cwd 启动" | 从 `C:\` 启动 `server/boot.mjs`，`GET /` 返回 200（index.html），`/assets/*.js` 返回 200 | 印证目录包可整体搬迁，只要 `server/` 与 `dist/` 保持相对位置 |
| 数据库 | `node:sqlite` 为 Node 内置 | 无需带 SQLite 动态库 |
| 前端产物 | `dist` 仅 1.1 MB | 体积可忽略 |
| 已有迁移与备份 | schema 自动迁移 + `VACUUM INTO` 备份 | 升级可保留数据 |

这三点（无原生模块、路径不依赖 cwd、SQLite 内置）意味着**打包容错率高、不需要改业务代码**。

### 1.5 体积构成（实测）

| 组件 | 实测体积 | 说明 |
|---|---|---|
| Node 运行时（win-x64 22.22.2） | **83.0 MB** | 可用 small-icu 版本进一步压缩 |
| FFmpeg（full build） | **217.3 MB** | 太大，必须换精简构建 |
| FFmpeg（essentials 类构建） | 约 30–40 MB | 覆盖 RTSP/H.264/HEVC/TS/MP4/HLS/libx264 |
| 前端 `dist` | 1.1 MB | — |
| 运行时依赖 | 约 3–5 MB | 82 个文件 |
| **合计（精简后）** | **约 120–130 MB** | 压缩后安装包约 50–65 MB |

**2026-11-12 实测修正**（打包脚本上线后验证）：

| 组合 | 实测体积 | 说明 |
|---|---|---|
| Node + 应用 + 依赖（不含 FFmpeg） | **88.9 MB** | 压缩后 **34.7 MB**，803 个文件 |
| 上述 + FFmpeg full + ffprobe full | **523.2 MB** | 单个可执行各 217 MB，**不适合分发** |
| 目标组合（essentials 构建） | 约 130 MB | 需下载精简构建，脚本已加体积告警（>80 MB 提示） |

---

## 2. 目标平台范围

| 层级 | 平台 | 架构 | 场景 | 优先级 |
|---|---|---|---|---|
| **Tier 1** | Windows 10 / 11 | x64 | 现场工控机、值班室主机（当前主力） | P0 |
| **Tier 1** | Linux（Ubuntu 22.04+/Debian 12+/CentOS Stream 9+） | x64 | 机房服务器 | P0 |
| **Tier 1** | macOS 12+ | arm64（Apple Silicon） | 值班/演示机 | P0 |
| **Tier 2** | Linux | arm64 | 边缘盒子、树莓派 4/5（64 位系统）、Jetson | P1 |
| **Tier 2** | macOS 12+ | x64（Intel） | 存量设备 | P1 |
| **Tier 2** | Windows | arm64 | Surface 等 | P2 |
| **不支持** | Windows 32 位、Android/iOS、MIPS 嵌入式 | — | Node 22 无对应官方运行时或算力不足 | — |

> 说明：Tier 1 必须有签名安装包；Tier 2 提供压缩包与 Docker 镜像即可，不单独做安装器。
> 树莓派需注明：**必须 64 位系统**，且建议关闭桌面环境以留出算力。

---

## 3. 分发形式选型

### 3.1 候选方案对比

| 方案 | 体积 | 改造量 | 跨平台 | 可调试 | 结论 |
|---|---|---|---|---|---|
| **A. 自带运行时目录包**（node + ffmpeg + 代码） | 120–130 MB | **极小**（现有代码直接跑） | 同一份代码 | ✅ 可看日志、可加参数 | ✅ **主力方案** |
| B. Node SEA 单文件可执行 | ~90 MB | **大**：需打包成 CJS、嵌入 dist、处理动态 import | 每平台分别构建 | ❌ 现场难排查 | ❌ 不采用 |
| C. Docker 镜像 | ~200 MB | 小（已有 Dockerfile） | buildx 多架构 | 中 | ✅ 辅助（服务器/边缘） |
| D. Electron/Tauri 桌面壳 | 150 MB+ | **大**：要重做窗口与生命周期 | 中 | 中 | ❌ 当前是 B/S 架构，无需 |
| E. 维持源码部署 | — | 无 | 需用户装 Node/FFmpeg | ✅ | ⚠️ 仅保留给开发者 |

**选择 A 的核心理由**：本项目**没有原生模块**，Node 运行时与业务代码完全解耦；用自带运行时不需要改一行业务代码，风险最低、可维护性最好。SEA 虽然产物更"干净"，但要求把 ESM 全量打成 CJS、把 `dist` 作为 asset 嵌入、且失去现场可诊断性——收益不抵成本。

### 3.2 各平台分发形态

| 平台 | 主分发 | 备用 | 说明 |
|---|---|---|---|
| Windows | `.msi`（WiX）或 `.exe`（NSIS）安装包 | 便携 `.zip` | 安装包负责服务注册、防火墙规则、开始菜单 |
| Linux | `.deb` + `.rpm` | `AppImage`、`tar.gz` | deb/rpm 走 systemd；AppImage 免安装 |
| macOS | `.dmg`（拖拽）+ `.pkg`（安装器） | `.tar.gz` | 需 Developer ID 签名 + 公证 |
| 服务器/边缘 | Docker 镜像（amd64/arm64） | `tar.gz` | 复用现有 Dockerfile |
| 全部 | 版本清单 `latest.json` | — | 供自动更新检查 |

---

## 4. 包内布局（程序与数据分离）

这是升级能否安全的前提：

```
fire-vision/                     # 安装根目录
├─ program/                     # ← 升级时整体替换
│  ├─ node[.exe]
│  ├─ ffmpeg[.exe] / ffprobe[.exe]
│  ├─ server/  dist/  node_modules/  package.json
│  └─ VERSION
├─ config/
│  └─ fire-vision.env           # 端口、数据目录、检测参数（安装器生成）
├─ data/                        # ← 升级绝不触碰
│  ├─ app.db  credentials.key  session.secret
│  ├─ recordings/  continuous/  snapshots/  backups/
└─ logs/
   ├─ server.out.log  server.err.log
   └─ deploy-*.log
```

**需要的最小改造**（当前代码里 `dataDir` 默认取 `projectRoot/data`）：

1. 引入 `APP_HOME` 概念：优先取可执行文件所在目录，而非 `process.cwd()`；
2. `data` 默认位置按平台调整为可写目录（Windows `%ProgramData%\FireVision`，macOS `/Library/Application Support/FireVision`，Linux `/var/lib/fire-vision`），并保留 `--data-dir` 覆盖；
3. 增加 `--config <file>` 读取配置文件，启动时与 `server/config.mjs` 的解析规则共用同一套校验；
4. 启动日志打印**最终生效的路径与端口**（便于现场截图排障）。

> 这四处改动都是"加默认值与参数解析"，不触碰业务逻辑，风险可控。

---

## 5. 安装、升级与卸载

### 5.1 安装流程（以 Windows 安装包为例）

1. 双击安装包 → 选择安装目录（限制路径长度 < 120 字符，避免 MAX_PATH）
2. 选择**数据目录**（默认 `%ProgramData%\FireVision`，提示所需空间与预计录像占用）
3. 设置端口（默认 4173，检测占用并允许修改）
4. 勾选：注册为系统服务（默认勾选）/ 开机自启 / 添加防火墙规则（需提权）
5. 安装完成 → 自动打开浏览器 `http://127.0.0.1:<port>` → 走现有的首次引导创建管理员
6. 安装器写 `config/fire-vision.env`，服务以该文件启动

**关键点**：安装器只负责"放文件 + 写配置 + 注册服务"，**业务初始化仍走现有 `/api/setup` 引导**，避免两套初始化逻辑。

### 5.2 升级流程

- 检查更新：管理端「系统信息」显示版本；`latest.json` 提供新版本号、平台包地址、SHA-256、签名
- 升级动作：停服务 → 备份 `data/app.db`（复用 `scripts/db-backup.mjs`）→ 解压新 `program/` 到 `program.new/` → 原子切换 → 启动 → `/healthz` 校验 → 失败则切回 `program.old/`
- 数据迁移：现有的 V1→V10 自动迁移链直接生效，无需额外脚本
- **跨大版本回退**：保留上一版 `program.old/`，并提示"回退需同时恢复对应备份"

### 5.3 卸载

- 默认**保留** `data/`（询问用户），卸载程序只删 `program/`、服务注册与快捷方式
- 提供"同时删除全部数据"二次确认

---

## 6. 关键依赖与兼容性问题（逐项解法）

| # | 问题 | 风险 | 解法 |
|---|---|---|---|
| 1 | **FFmpeg 体积与能力差异** | full build 217 MB；不同构建编解码器不同 | 固定随包使用"精简但覆盖 RTSP/H.264/HEVC/TS/MP4/HLS/libx264"的构建；启动仍走既有的编码器探测与回退，双保险 |
| 2 | **FFmpeg 许可** | 含 libx264 属 GPL，随包分发需遵守 GPL 条款 | 随包附 `LICENSE.ffmpeg`、提供对应源码获取方式；或在商业授权场景改用系统 FFmpeg（提供"外部 FFmpeg"选项） |
| 3 | **Node 运行时架构** | 错架构直接无法启动 | 安装包按架构分别构建；启动脚本校验 `process.arch` 并在不匹配时给出明确提示 |
| 4 | **数据目录不可写** | 装到 `Program Files` 后库写不进去 | 默认数据目录改到可写位置；首次启动做写探测，失败则退回用户目录并告警 |
| 5 | **端口被占用 / 防火墙** | 局域网访问不了 | 安装时检测端口并允许修改；可选添加防火墙规则（提权）；`/healthz` 附带监听地址 |
| 6 | **服务注册与自启** | 断电/崩溃后不自恢复 | Win：WinSW 或 `sc.exe` 注册，配失败重启；macOS：`launchd` plist（含 fd 上限）；Linux：systemd unit |
| 7 | **代码签名 / 公证** | Windows SmartScreen 拦截；macOS Gatekeeper 拒绝运行 | Windows：Authenticode 证书签名（EV 证书可即时建立信誉）；macOS：Developer ID Application 签名 + `notarytool` 公证 + hardened runtime |
| 8 | **macOS 目录与执行权限** | 双击后提示"无法验证开发者" | 公证后可消除；未公证时在文档给出 `xattr -d com.apple.quarantine` 的临时办法（仅内部使用） |
| 9 | **多架构产物** | arm64 设备装 x64 包 | CI 矩阵构建：win-x64/win-arm64、darwin-arm64/darwin-x64、linux-x64/linux-arm64 |
| 10 | **单实例约束** | 安装/升级时旧实例仍在跑 | 安装器与升级器先读 `instance.lock` 停实例；服务管理器保证只有一个进程 |
| 11 | **配置面过宽（101 处 env）** | 现场配错难发现 | 提供 `config/fire-vision.env` 模板 + 管理端可视化配置；`config_invalid` 日志已有 |
| 12 | **升级中途断电** | 程序目录损坏 | 解压到 `program.new/` 后原子重命名；保留 `program.old/`；启动失败自动回退 |
| 13 | **杀毒软件误报** | 打包后的 node.exe 被拦截 | 签名 + 提交厂商白名单；文档说明添加信任目录 |
| 14 | **离线环境** | 无法下载依赖 | 安装包完全自包含（含 node/ffmpeg/dist/node_modules），不联网即可安装 |

---

## 7. 实施步骤

### ✅ P0：目录布局改造（已完成，v1.2.0）

实现：`server/app-paths.mjs`（布局标记 + 三形态解析 + 可写回退）、
`server/env-file.mjs`（配置文件解析）、`boot.mjs`（`--config`/`--data-dir` + 生效信息日志）、
`index.mjs`（直接启动时同样走布局解析）。测试：`server/app-paths.test.mjs` 15 条。

**实测**：源码形态 `dataDir` 与改造前完全一致（`<项目根>/data`）；便携包为 `<包>/data`。

#### 原计划（保留供追溯）


1. 新增 `APP_HOME` 解析（exe 所在目录）与 `--data-dir`/`--config` 参数
2. 按平台确定默认数据目录，首次启动做可写探测与回退
3. 启动日志打印生效路径/端口/版本
4. 回归：`npm test`（含 `TZ=UTC`）、`npm run build`

**验收**：从任意 cwd 启动都能找到 `dist` 与 `data`；数据目录不可写时给出明确错误而非崩溃。

### ✅ P1：便携包（已完成，v1.2.0）

实现：`scripts/package/portable.mjs`（收集运行时/代码/依赖/FFmpeg、生成启动脚本与快速开始）、
`scripts/package/zip.mjs`（自带 ZIP 写入，规避各方 tar 行为差异）、
`npm run build:portable` / `build:portable:zip`。

**实测**：解压后 `mode=portable`、数据落包内、`/healthz` ok、页面 200。

> 踩坑记录：Git Bash 的 GNU tar 用 `-a -c -f x.zip` **不会**生成 zip，而是生成 tar
> 却用 `.zip` 扩展名（文件头是文件名而非 `PK`），用户双击解压会失败。已改为自带实现。

#### 原计划（保留供追溯）


1. 编写 `scripts/package/portable.mjs`：按平台收集 `node`、`ffmpeg`、`server`、`dist`、`node_modules`、`config` 模板
2. 生成 `fire-vision-<version>-<platform>-<arch>.zip`（含 `README-QUICKSTART.txt` 与 `start.cmd`/`start.sh`）
3. CI 增加打包 job（矩阵：win-x64、linux-x64、darwin-arm64）
4. 在干净虚拟机验证：解压→双击→浏览器打开→创建管理员→演示模式出告警

**验收**：全新 Windows 机器**不装 Node/FFmpeg**，解压后 3 分钟内跑通演示模式全链路。

### ✅ P2：原生安装包（已完成，v1.2.0；签名留待 P3）

实现：`scripts/package/installer.mjs` + `templates/`（NSIS / systemd / nfpm / macOS postinstall）。
`npm run package:win` / `package:linux` / `package:macos`。

- **Windows**：NSIS 工程，`File /r` 复用便携包产物；数据目录固定 `%LOCALAPPDATA%\FireVision`
  （避开 Program Files 不可写）；开机自启为「启动文件夹快捷方式」（当前用户，无需管理员、
  无 WinSW 依赖）；卸载保留数据并明确提示路径；含完整 VERSIONINFO。
  **实测：makensis 编译成功，22.4 MB，版本信息正确。**
- **Linux**：systemd unit（`LimitNOFILE=4096`、`ProtectSystem=strict`、`ReadWritePaths` 放行数据与日志）
  + nfpm 配置（deb/rpm）+ postinstall（建 `fire-vision` 系统用户、`/etc/fire-vision` 配置仅首次写入）。
- **macOS**：pkgbuild payload 组装 + postinstall 写 LaunchDaemon（`KeepAlive SuccessfulExit=false`、
  `SoftResourceLimits 4096`、PATH 含 Homebrew）。plist 经 XML 解析器校验合法。

**未验证项**：Linux 的 nfpm 打包与真机安装、macOS 的 pkgbuild、
Windows 安装包的完整安装/卸载流程（需管理员权限，避免污染开发机）。

#### 原计划（保留供追溯）


1. Windows：NSIS 或 WiX 脚本（服务注册用 WinSW）
2. Linux：`.deb`（`nfpm` 生成）+ systemd unit
3. macOS：`.pkg`/`.dmg` + `launchd` plist
4. 安装器内做：端口检测、目录长度校验、数据目录选择、防火墙规则（可选）
5. 卸载程序保留数据

**验收**：三种系统上「双击安装 → 浏览器自动打开 → 创建管理员」全程无需命令行；卸载后 `data/` 保留。

### 阶段 P3：签名、公证与自动更新（3–5 天，依赖证书采购）

1. Windows Authenticode 签名接入 CI；macOS 签名 + `notarytool` 公证
2. 生成 `latest.json`（版本、平台包、SHA-256、签名）
3. 管理端增加"检查更新"入口，展示当前版本与可用版本（下载与安装仍由运维执行）
4. Docker 多架构镜像（`buildx`）

**验收**：Windows 上安装包无 SmartScreen 警告；macOS 双击无 Gatekeeper 拦截；`latest.json` 校验通过。

### 阶段 P4：多架构与边缘（2–3 天）

1. 增加 linux-arm64 / win-arm64 / darwin-x64 产物
2. 树莓派验证：64 位系统 + 关闭桌面，跑通 1 路 RTSP 检测与录像

**验收**：树莓派 4B（4GB）单路 HLS 播放 + 检测稳定 24 小时。

---

## 8. 预期产出

| 产物 | 目标体积 | 备注 |
|---|---|---|
| `fire-vision-1.2.0-win-x64-setup.exe` | 50–65 MB | 含服务注册与防火墙选项 |
| `fire-vision-1.2.0-win-x64-portable.zip` | 55–70 MB | 免安装 |
| `fire-vision-1.2.0-linux-x64.deb` / `.rpm` | 50–65 MB | 含 systemd unit |
| `fire-vision-1.2.0-linux-x64.AppImage` | 60–75 MB | 通用免安装 |
| `fire-vision-1.2.0-macos-arm64.dmg` | 55–70 MB | 已签名与公证 |
| `fire-vision-1.2.0-linux-arm64.tar.gz` | 50–65 MB | 树莓派/边缘盒子 |
| `ghcr.io/<org>/fire-vision:1.2.0`（amd64/arm64） | ~200 MB | 服务器场景 |
| `latest.json` + `SHA256SUMS` | < 10 KB | 更新与校验 |
| `docs/INSTALL-<platform>.md`（中英） | — | 安装/升级/卸载/排障 |

---

## 9. 风险与暂不做的部分

| 项 | 说明 |
|---|---|
| 自动静默更新 | 本方案只做"检查更新 + 提示"，不做后台自动替换。消防场景下未经确认的重启风险过高 |
| 32 位 Windows | Node 22 已弱化 32 位支持，且现场算力不足，不支持 |
| 移动端 | 现有是响应式 Web，手机通过浏览器访问即可，不做原生 App |
| 代码混淆 | 不做。保留可读源码便于现场排障；如确需保护，可后续单独评估 bytecode 方案 |
| P3–P4 未实施 | 代码签名与 macOS 公证、多架构产物、自动更新仍未落地；安装包当前未签名 |

---

---

## 10. 移交说明（接手需知）

**本项目在 P2 结束处移交。** P3（签名/公证）与 P4（多架构/自动更新）未实施，原因是需要证书采购与对应平台的构建机，属于组织决策而非技术阻塞。以下是接手所需的全部信息。

### 10.1 已交付且可直接使用

| 产物 | 生成命令 | 验证状态 |
|---|---|---|
| 便携包（zip / 目录） | `npm run build:portable:zip` | 解压后端到端验证通过 |
| Windows 安装包 | `npm run package:win` | **已实际编译**（NSIS 3.13），22.4 MB |
| Linux 安装工程 | `npm run package:linux` | 工程渲染通过，未打包 |
| macOS 安装工程 | `npm run package:macos` | 工程渲染通过，未打包 |

构建产物输出到 `dist-packages/`（已 gitignore，可随时删除重建）。

### 10.2 未完成项与前提条件

| 项 | 需要什么 | 入口 |
|---|---|---|
| Windows 代码签名 | Authenticode 证书（OV 或 EV）。EV 证书可立即建立 SmartScreen 信誉 | `installer.nsi.tpl` 编译后对 exe 执行 `signtool sign /fd sha256 /tr <时间戳URL> /td sha256 /f cert.pfx /p <密码> <exe>` |
| macOS 签名与公证 | Apple Developer Program（99 美元/年）、Developer ID Application 证书 | `codesign --deep --options runtime --sign "Developer ID Application: ..." <app>` → `xcrun notarytool submit` → `xcrun stapler staple` |
| Linux 实际打包 | `nfpm`（`go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest`）+ Linux 构建机 | `npm run package:linux`（脚本会检测 nfpm） |
| macOS 实际打包 | macOS + `xcode-select --install` | `npm run package:macos`（脚本会生成 pkgbuild 命令） |
| 多架构（arm64） | 对应平台的 Node 运行时；`portable.mjs` 只允许宿主架构 | 在目标架构机器上执行 `--arch arm64` |
| 自动更新 | 一个可公网访问的 `latest.json` 托管位置 | 当前只做了版本可见性，未做下载安装 |

### 10.3 接手时不要重复踩的坑

1. **FFmpeg 体积**：Gyan "full" 构建单个可执行 217 MB，`ffmpeg`+`ffprobe` 会让包到 **523 MB**。分发必须用 essentials/精简构建（各 30–40 MB），用 `--ffmpeg-dir` 指定。
2. **NSIS 脚本必须带 UTF-8 BOM**，否则中文乱码；但 shell 脚本与 XML **不能**带 BOM（会破坏 shebang / 声明）。生成逻辑已处理，手改时注意。
3. **`portable.mjs` 拒绝跨平台打包**（需要目标平台的 Node 二进制），Linux/macOS 产物必须在对应系统构建。
4. **不要用 `tar -a -c -f x.zip`**：Git Bash 的 GNU tar 会生成 tar 归档却用 `.zip` 扩展名，用户解压失败。项目已用自带 ZIP 实现（`scripts/package/zip.mjs`）。
5. **Windows 安装包未签名时会被 SmartScreen 拦截**，这是预期行为，不是安装包损坏。
6. **数据目录不能放 Program Files**：安装器已固定到 `%LOCALAPPDATA%\FireVision`，改动前先看 `server/app-paths.mjs` 的可写回退逻辑。

### 10.4 分发前的自检

- [ ] `npm test`（304 条）与 `TZ=UTC npm test` 均通过
- [ ] `npm run build` 与 `npm run e2e` 通过
- [ ] 便携包在**未安装 Node/FFmpeg** 的干净机器上解压可用
- [ ] 安装包在测试机完成「安装 → 浏览器创建管理员 → 卸载」全流程
- [ ] 卸载后数据目录仍在（确认没有误删用户数据）
- [ ] 若已签名：`Get-AuthenticodeSignature` 显示 `Valid`；macOS 上 `spctl -a -vv` 通过

---

## English summary

**Current state**: deployment is source-only — 9 steps, 4 of which need extra downloads or admin rights (Node ≥ 22.5, FFmpeg, `npm ci`, build, service/autostart, firewall). Targeted users are on-site safety staff, not developers.

**Recommended approach**: ship a **bundled-runtime directory layout** (Node + FFmpeg + app) wrapped in native installers per platform, plus a portable zip and multi-arch Docker images. This works because the project has **no native modules** (only `express`, `fast-xml-parser`, `ws` — 82 files), resolves `dist` via `import.meta.url` (not cwd), and uses built-in `node:sqlite`. Node SEA single-binary is **not** recommended: it would require bundling ESM to CJS and embedding assets, at the cost of on-site diagnosability.

**Platforms**: Tier 1 — Windows 10/11 x64, Linux x64, macOS 12+ arm64; Tier 2 — Linux arm64 (Raspberry Pi 64-bit), macOS x64, Windows arm64. No 32-bit Windows, no native mobile app.

**Key problems to solve**: FFmpeg size (217 MB full → ~30–40 MB trimmed) and GPL compliance; per-arch Node binaries; writable data directory (Program Files is not writable); port/firewall; service registration (WinSW / launchd / systemd); code signing and macOS notarization; multi-arch CI; atomic upgrade with rollback (`program/` replaceable, `data/` untouched).

**Expected output**: ~50–70 MB installers per platform, portable zips, `.deb`/`.rpm`/AppImage, signed `.dmg`, multi-arch container image, `latest.json` + checksums, and per-platform install docs.

**Status**: P0, P1 and P2 are implemented in v1.2.0. `npm run build:portable:zip` produces a portable zip (bundled Node, optional FFmpeg, data inside the bundle); `npm run package:win` produces an NSIS installer (compiled and verified at 22.4 MB, unsigned); Linux and macOS installer projects are generated (systemd/nfpm and pkgbuild). P3 (code signing, macOS notarization) and P4 (multi-arch, auto-update) are **handed over** — see §10 for prerequisites, entry points and pitfalls; they were not implemented because they require certificate purchase and per-platform build machines.

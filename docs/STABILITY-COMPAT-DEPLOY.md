# 稳定性加固、兼容性增强与一键部署

> 版本：**v1.1.1**（在 v1.1.0 基础上）
> 时间：2026-11-12 00:25 GMT+8
> 验证：`npm test` **271/271** · `npm run build` 通过 · `npm run e2e` 全通过 · 对比度 0 违规 · `git diff --check` 干净

---

## 一、修复的已知问题（逐项说明依据与影响范围）

### 1. Node 版本过低时报错晦涩

- **依据**：项目依赖内置 `node:sqlite`（22.5.0 起提供）。ES 模块在**链接阶段**就解析该内置模块，任何写在 `index.mjs` 顶部的版本判断都来不及执行。实测用 Node 20 启动只会得到 `Cannot find module 'node:sqlite'`，与真实原因无关。
- **改动**：新增 `server/boot.mjs`（唯一推荐入口）与 `server/runtime-check.mjs`。boot 只依赖 `process`，先校验版本，再动态导入真正入口。`package.json` 的 `start`/`dev:api`、守护脚本、E2E/对比度脚本、systemd 示例统一改为 `boot.mjs`。
- **影响范围**：启动入口变更；`server/index.mjs` 仍可直接运行（兼容旧脚本），但低版本下仍会先崩在 sqlite。版本判断含 `22.4.x` 必须拒绝的边界测试。
- **实测**：`boot_precheck_ok` 日志 + `/healthz` 200；Node 20 场景由单测覆盖（`runtime-check.test.mjs` 6 条）。

### 2. 转码编码器硬编码 `libx264`，裁剪版 FFmpeg 直接失败

- **依据**：`streams.mjs` 原先把编码器写死为 `libx264`（仅允许环境变量覆盖）。现场 FFmpeg 来源不一（便携包、发行版仓库包、Docker 镜像、厂商随附裁剪版），不少**不含 libx264**（GPL 组件被裁）。此时转 HLS 会以 `Unknown encoder 'libx264'` 失败，前端只表现为「点位一直转圈」。
- **改动**：新增 `server/ffmpeg-capabilities.mjs`：启动时执行 `ffmpeg -encoders` 探测，按 `libx264 → h264 → mpeg4` 回退链选择，并记录 `ffmpeg_codec_ready` / `ffmpeg_codec_degraded` / `ffmpeg_capabilities_unavailable` 日志。编码器经构造参数注入 `StreamManager`，不再读全局环境。
- **影响范围**：转码画质可能下降（回退到 `mpeg4` 时）；启动多一次约几十毫秒的探测（有 5 秒超时与失败兜底，不阻断启动）。`FFMPEG_VIDEO_CODEC` 仍具最高优先级；显式指定但不可用时会回退并 warn。
- **实测**：11 条单测覆盖表头过滤、5/6 位 flags、CRLF、回退链、环境变量不可用、探测失败兜底。

### 3. 老设备 ONVIF 只支持 SOAP 1.1，扫描不到

- **依据**：ONVIF 早期规范基于 SOAP 1.1（`schemas.xmlsoap.org` + `text/xml` + SOAPAction 头），2.0 起改 SOAP 1.2（`w3.org/2003/05` + `application/soap+xml`）。原实现只发 1.2，老款/部分国产设备返回 400/415，表现为「一键扫描发现不了设备」。
- **改动**：`soapRequest` 先按 1.2 发送；仅当返回 `400/415/500/501` 时用 1.1 重试一次。**认证失败（401/403）不回退**——回退无意义且会掩盖凭据问题。
- **影响范围**：单次失败最多多一个请求；错误信息会注明「已尝试 SOAP 1.2/1.1」。
- **实测**：`onvif` + `onvif-discovery` 5 条既有测试全过（未破坏原有解析与鉴权路径）。

### 4. Windows 长路径风险无提示

- **依据**：录像路径形如 `<dataDir>/continuous/<cameraId>/<yyyymmdd>/<hhmmss>.ts`，比 dataDir 长约 60 字符；Node 的 fs 在未加 `\\?\` 前缀时受 MAX_PATH 260 限制。
- **改动**：`boot.mjs` 在 win32 且 dataDir 超过 180 字符时输出 `long_path_risk` 警告，提示把项目移到更短路径。
- **影响范围**：仅告警，不阻断；不改动任何文件读写路径（避免大范围改动引入新风险）。
- **实测**：`checkLongPathRisk` 单测覆盖阈值与非 Windows 平台分支。

### 5. 部署脚本原先无（手工步骤易错）

- **依据**：升级流程散落在 README（`git pull → npm ci → build → 重启`），无前置检查、无备份、无失败回滚指引。实测直接复制 `app.db` 会漏掉 WAL 中未 checkpoint 的事务（曾漏 1.4MB，告警从 2 条变 0 条）。
- **改动**：新增 `scripts/deploy.ps1`、`scripts/deploy.sh`、`scripts/db-backup.mjs`（详见 §3）。
- **影响范围**：新增文件；不改变现有启动方式（守护继续可用）。

### 6. 部署脚本初版的三个自身缺陷（实施中发现并修正）

| 缺陷 | 现象 | 修正 |
|---|---|---|
| 内联 JS 模板被脚本宿主二次解释 | 备份步骤报语法错误、退出码 1 | 抽出 `scripts/db-backup.mjs` 独立脚本，两个部署脚本共用 |
| 未设置控制台 UTF-8 | 中文路径在日志里变乱码（`鐏儏瑙嗛...`），失去可诊断性 | 启动即设置 `OutputEncoding`；实测日志文件 0 处伪影 |
| 守护进程识别正则只匹配 `index.mjs` | 切到 `boot.mjs` 后守护会「认不出自己的实例」，可能重复拉起 | 正则改为 `(index|boot)\.mjs` |

---

## 二、稳定性与健壮性提升

| 改动 | 依据 | 影响 |
|---|---|---|
| 启动前置校验（版本/目录可写/磁盘余量/端口占用归属） | 这些问题在旧流程里都要等到「启动后报错」才发现 | 部署阶段即失败并给出中文原因与下一步动作 |
| 部署失败退出码分级（1 检查 / 2 备份 / 3 构建 / 4 重启 / 5 健康） | 便于脚本化与监控接入 | 自动化可据此决定是否继续 |
| 部署日志落盘 `data/logs/deploy-<时间戳>.log` | 事后追查需要 | 与 `server.out.log` / `server.err.log` 互补 |
| 备份走 `VACUUM INTO` + `integrity_check` + 行数统计 | 直接复制会漏 WAL | 备份可信，且能验证「内容是否真的在」 |
| 守护脚本升级为「熔断 + 输出落盘」（v1.1.0 已改） | 启动即崩会无限重启且无日志 | 连续 5 次失败进入长退避并写标记文件 |

---

## 三、一键部署方案

### 3.1 入口与参数

| 平台 | 命令 |
|---|---|
| Windows | `scripts\deploy.ps1` |
| Linux/macOS | `scripts\deploy.sh` |

两者参数同名、退出码一致：

| 参数 | 用途 |
|---|---|
| `-DryRun` / `--dry-run` | 只做前置检查，不写入 |
| `-NoRestart` / `--no-restart` | 只准备代码与产物 |
| `-SkipInstall` / `--skip-install` | 离线内网（node_modules 已就绪；缺失时直接失败） |
| `-SkipBuild` / `--skip-build` | 仅后端热修 |
| `-SkipTests` / `--skip-tests` | 紧急修复（不建议常规使用） |
| `-SkipBackup` / `--skip-backup` | 已有外部备份 |
| `-DataDir` / `--data-dir`、`-Port` / `--port` | 数据目录与端口 |

### 3.2 执行顺序（幂等）

1. **前置检查**：仓库结构 → Node ≥22.5 → npm → FFmpeg/ffprobe（缺失仅告警）→ 数据目录可写 → 磁盘 ≥500MB → 端口占用**归属判定**
   - 端口被占时区分「本项目实例（稍后平滑重启）」与「其它程序（直接失败并给出排查命令）」
2. **数据库备份**：`VACUUM INTO` + 完整性校验；失败即中止（退出码 2），不继续后续步骤
3. **依赖**：有 lock 用 `npm ci`，否则 `npm install`
4. **构建**：`npm run build`
5. **测试**：`npm test`
6. **重启**：优先让守护拉起（最多等 90 秒）；无守护则直接启动并重定向日志
7. **健康校验**：轮询 `/healthz` 90 秒，要求 `ok:true`；并检查 `database/ffmpeg/diskOk` 子状态

**可重复执行**：每一步都是幂等的——备份按时间戳新建、`npm ci` 重建依赖、`build` 覆盖产物、重启前先停旧实例并等待端口释放。

### 3.3 错误处理与回滚

- 任一步失败：写 `ERROR` 日志 + 逐条 `WARN` 提示下一步动作 + 非 0 退出码。
- 失败时**已完成的备份仍保留**，并打印回滚步骤：
  1. 停止服务
  2. `git checkout <上一个 tag>`
  3. 用备份覆盖 `app.db`（同时删除 `app.db-wal` / `app.db-shm`）
- 数据目录、端口、日志路径均在开头打印，便于复制到工单。

### 3.4 配置说明

- **必需**：Node ≥22.5、npm。
- **建议**：FFmpeg + ffprobe（缺失时 RTSP 转码/录像/抓拍/测流不可用，HLS/http 点位仍可播）。
- **环境变量**：沿用项目既有变量（`DATA_DIR`、`FFMPEG_PATH`、`FFPROBE_PATH`、`FFMPEG_VIDEO_CODEC` 等），部署脚本不新增必需变量；`DATA_DIR` 由 `-DataDir` 参数优先。
- **Linux systemd**：脚本检测到 `fire-monitor.service`（可用 `SERVICE_NAME` 覆盖）时用 `systemctl restart`，否则后台拉起。

---

## 四、验证结果（本机实测）

| 项目 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | **271/271** 通过（v1.1.0 为 251，新增 20 条） |
| 构建 | `npm run build` | 通过（79 modules） |
| 端到端 | `npm run e2e` | 全通过（已切换为 `boot.mjs` 入口，覆盖新启动链路） |
| 对比度 | `node scripts/contrast-scan.mjs` | 10 场景 0 违规 |
| 空白检查 | `git diff --check` | 干净 |
| 部署脚本语法 | 静态解析 | `deploy.ps1` 2462 tokens 通过；`deploy.sh` `bash -n` 通过 |
| 预演模式 | `deploy.ps1 -DryRun` | 全部通过；正确识别端口占用者为本项目 PID 23820 |
| 真实路径 | `deploy.ps1 -SkipInstall -SkipTests -NoRestart` | 备份 integrity=ok（1/6/2）、构建成功、退出码 0 |
| 备份脚本 | `node scripts/db-backup.mjs --data-dir ./data` | `ok:true`、`integrity:ok`、258KB |
| 新启动入口 | `node server/boot.mjs --port 9993` | `boot_precheck_ok` + `/healthz` 200 |
| 备份链路测试 | `db-backup.test.mjs` | 2 条通过（含「库不存在」错误路径） |

---

## 五、兼容性矩阵与剩余风险

| 维度 | 状态 |
|---|---|
| Node 22.5+ | ✅ 前置校验 + 明确提示 |
| Node 20 及以下 | ✅ 明确拒绝并给出升级指引（不再抛 sqlite 模块错误） |
| Windows | ✅ 主要目标平台，实测通过（含守护、路径、编码） |
| Linux/macOS | ⚠️ 脚本语法与逻辑已对齐，**未在真实 Linux 上跑过完整重启链路**（本机无 Linux 环境） |
| 裁剪版 FFmpeg（无 libx264） | ✅ 自动回退 `h264`/`mpeg4` 并告警 |
| 无 FFmpeg | ✅ 部署继续，转码/录像/抓拍不可用（明确告警） |
| ONVIF SOAP 1.1 老设备 | ✅ 自动回退重试 |
| 长路径（Windows） | ⚠️ 仅预警，未做 `\\?\` 前缀改写 |
| 反代 / `TRUST_PROXY` | ⚠️ 未验证（需部署拓扑） |
| 真机 RTSP/HLS/ONVIF 设备 | ⚠️ 未验证（需现场设备） |

**明确的已知限制**（未做，不建议臆测为已支持）：
- Linux 的 systemd 重启分支与 `setsid` 后台拉起未实测。
- 部署脚本的重启分支在本机未实际触发（我的执行环境禁止启动外部进程），仅通过 `-NoRestart` 验证了备份/构建/流程控制；重启行为此前已用「停实例 + 守护拉起」方式验证过一次。
- 长路径只做预警，未改写文件路径。
- 识别准确率、真机协议兼容性不在本轮范围。

---

## 六、文件清单

**新增**
- `server/boot.mjs` — 启动包装器（版本前置校验）
- `server/runtime-check.mjs` + `.test.mjs` — 版本/长路径判定
- `server/ffmpeg-capabilities.mjs` + `.test.mjs` — 编码器探测与回退
- `scripts/deploy.ps1` / `scripts/deploy.sh` — 一键部署
- `scripts/db-backup.mjs` + `server/db-backup.test.mjs` — 一致性备份
- `docs/STABILITY-COMPAT-DEPLOY.md` — 本文档

**修改**
- `package.json`（start/dev:api 入口）
- `server/streams.mjs`（编码器注入）
- `server/index.mjs`（启动时探测能力并记录）
- `server/onvif.mjs`（SOAP 1.1 回退）
- `scripts/fire-watchdog.ps1`（启动路径 + 进程识别正则）
- `scripts/e2e-smoke.mjs` / `scripts/contrast-scan.mjs`（改用 boot 入口）
- `README.md`（4.0 一键部署章节、systemd 示例）

# 火情视频识别监控平台（Flame Vision）

**简体中文** · [English](./README.en.md)

> **部署与交付**：一键部署参数见下文 §4，交付物与验收基线见 [DELIVERY.md](./DELIVERY.md)，macOS 适配见 [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md)，GitHub 推送见 [docs/GITHUB.md](./docs/GITHUB.md)。

浏览器与服务器双栈的火焰 / 烟雾视频识别监控平台：接入现场摄像头（RTSP / ONVIF / 网络摄像头 / 边缘网关），7×24 自动识别火焰与烟雾，命中即告警、抓拍、录短视频，并按站点推送给企业微信 / 钉钉 / Webhook。支持多租户站点隔离、多角色账号、告警处置闭环、趋势看板与审计日志。

无真实摄像头时，可用内置**演示模式**（FFmpeg 合成火焰直播流）跑通全链路。

---

## 1. 功能总览

| 层 | 能力 |
|---|---|
| 接入 | RTSP 转 HLS 低延迟播放；ONVIF 自动发现与导入；WS-Discovery 一键扫描全网段；13+ 品牌 NVR 批量导入（海康 / 大华 / 宇视 / Axis 等）；边缘网关隧道（现场无公网时主动外连） |
| 识别 | 服务端 7×24 检测引擎（每路一个 FFmpeg 抽帧进程，160×90@1fps，ROI 屏蔽、亮度闪烁判据、分点位灵敏度）；画面异常检测（镜头遮挡/过暗/过曝，持续超阈值自动告警、恢复自动归档）；浏览器本地识别兜底；两者自动去重（服务端接管时浏览器让位） |
| 告警 | SSE 实时推送；超时未确认自动升级；设备离线告警与恢复归档；抓拍 + H.264 短视频；告警短视频按时间轴回放（点击播放、前后跳转、自动连播）；每日值守摘要（滚动 24h） |
| 录像回放 | `RECORDING=1` 开启 7×24 子码流 copy 分段录像（60s/段 TS，按 UTC 分目录）；5 分钟自动对账补录；24h 时间线显示有录像 / 告警保护 / 缺口；点击时段按需转 HLS 回放，或拼接 MP4 导出；告警前后窗口自动保护、保留天数与容量双淘汰 |
| 通知 | 企业微信 / 钉钉 / 通用 Webhook（HMAC-SHA256 签名）；告警文案模板可配（站点/点位/时间/置信度/处置链接变量）；渠道密钥加密落库；推送按「告警+渠道+事件」去重；连续失败自动停用并广播提醒（渠道自愈） |
| 权限 | 全局管理员 / 站点管理员 / 值班员 / 只读；站点级数据隔离，逐请求校验；SSE 按站点投递 |
| 观测 | 告警趋势看板（按天 / 分站点 / 误报率）；审计日志（筛选 + 分页 + 导出）；磁盘水位保护（按天数 + 按容量双保险） |
| 值守 | 大屏自动轮巡（已接入点位逐路全屏，10/15/30/60 秒可调，支持暂停、上一路/下一路、无源自动跳过） |
| 管理 | 点位批量操作（批量启停检测 / 批量灵敏度 / 批量删除）；布防时间表（按点位分时段布防，撤防时段仅停检测、播放不受影响，支持跨零点时段）；误报治理提示（7 天误报热点点位给出调灵敏度/屏蔽区建议）；新用户空状态三步引导（看演示 → 接摄像头 → 配通知） |
| 演示 | 演示模式：FFmpeg 合成火焰流，无硬件跑通播放→识别→告警→抓拍→推送→统计；演示数据一键清除 |

## 2. 系统要求

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`，Experimental）
- **FFmpeg**（必须，加入 PATH 或用 `FFMPEG_PATH` 指定；FFprobe 可选，用于一键测流）
  - 无需 `libx264`：启动时自动探测编码器并回退（`libx264 → h264 → mpeg4`）
  - macOS 会自动探测 Homebrew 的 `/opt/homebrew/bin` 与 `/usr/local/bin`
- 操作系统：**Windows 10/11**、**Linux**、**macOS 11 (Big Sur) 及以上**
  - macOS 适配范围与安装步骤（含 launchd 守护）见 [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md)
- 内存 / CPU：每路检测约一个 FFmpeg 抽帧进程（160×90@1fps，CPU 占用低）；每路观看转码一个 FFmpeg 进程。单路演示 + 观看总计 3 个进程，普通服务器无压力
- Chrome（可选）：仅 E2E 测试与对比度扫描需要（macOS/Linux/Windows 路径均已支持）

## 3. 快速开始

```bash
npm ci                # 安装依赖
npm run build         # 类型检查 + 构建前端产物到 dist/
npm start             # 生产运行，默认 0.0.0.0:4173
```

首次打开 `http://服务器IP:4173` 会引导创建管理员账号（仅一次，之后 `/api/setup` 关闭）。

开发模式（前后端分离热更新）：

```bash
npm run dev           # Vite 5173 + API 8787
```

## 4. 部署

### 4.0 便携包（免装 Node/FFmpeg，推荐现场使用）

打包后自带 Node 运行时与 FFmpeg，目标机**无需安装任何依赖**：

```bash
npm run build:portable:zip        # 生成 dist-packages/fire-vision-<版本>-<平台>-<架构>.zip
npm run build:portable            # 只生成目录，不压缩
```

常用参数（`node scripts/package/portable.mjs`）：

| 参数 | 用途 |
|---|---|
| `--out <dir>` | 输出目录（默认 `dist-packages/`） |
| `--no-ffmpeg` | 不含 FFmpeg（体积小，需目标机自备） |
| `--ffmpeg-dir <dir>` | 指定 FFmpeg 目录（**建议用 essentials 精简构建**，见下） |
| `--archive` | 同时生成 zip |
| `--platform` / `--arch` | 交叉打包（需对应平台的 Node 二进制） |

产物结构（**程序与数据分离**，升级只替换 `program/`）：

```
fire-vision-<版本>-<平台>-<架构>/
├─ program/     Node 运行时 + FFmpeg + 应用代码（升级时整体替换）
├─ config/      配置模板（复制 fire-vision.env.example 为 fire-vision.env）
├─ data/        全部运行数据（升级不动）
├─ logs/
├─ start.cmd    Windows 双击启动
├─ start.sh     Linux/macOS
└─ README-QUICKSTART.txt
```

使用：解压 → 双击 `start.cmd`（或 `./start.sh`）→ 浏览器打开 `http://127.0.0.1:4173`。

> ⚠️ **FFmpeg 体积**：Gyan "full" 构建单个可执行约 217 MB，`ffmpeg`+`ffprobe` 会让包达到 **523 MB**（实测）。分发请使用 **essentials / 精简构建**（各约 30–40 MB），包体积可控制在 **120–130 MB**（压缩后约 55–70 MB）。脚本在检测到 FFmpeg > 80 MB 时会告警提示。

### 4.1 安装包（Windows）

```bash
npm run package:win          # 生成 dist-packages/fire-vision-<版本>-win-<架构>-setup.exe
```

- 安装到 `Program Files\FireVision`，**运行数据放在 `%LOCALAPPDATA%\FireVision`**（该目录可写，避免装到只读目录后数据库写失败）
- 可选「开机自启（当前用户）」，用启动文件夹快捷方式实现，**不需要管理员常驻、不依赖第三方服务包装器**
- 卸载**保留运行数据**，并在完成时提示数据路径（`credentials.key` 与 `app.db` 必须成对处理）
- 安装包当前**未做代码签名**，Windows SmartScreen 会提示「未知发布者」；正式分发前需完成签名（见发行版方案 P3）

Linux（`npm run package:linux`，生成 deb/rpm 工程 + systemd unit）与 macOS（`npm run package:macos`，生成 pkg 工程 + LaunchDaemon）**必须在对应操作系统上构建**。

### 4.2 一键部署（源码方式，推荐开发/服务器）

仓库内置幂等部署脚本，**可重复执行**，失败会保留备份并打印回滚步骤。

- Windows：`scripts\deploy.ps1`（参数示例见脚本头部注释或 `-Help`）
- Linux / macOS：`scripts\deploy.sh --help`

常用参数（两者同名）：`-DryRun/--dry-run` 只检查、`-NoRestart/--no-restart` 只准备不重启、`-SkipInstall/--skip-install` 离线环境、`-SkipBuild/--skip-build`、`-SkipTests/--skip-tests`、`-SkipBackup/--skip-backup`、`-DataDir/--data-dir`、`-Port/--port`。

脚本按固定顺序执行：**前置检查 → 数据库备份（VACUUM INTO + integrity_check）→ 依赖安装 → 构建 → 测试 → 重启 → 健康校验**，日志写入 `data/logs/deploy-<时间戳>.log`。

退出码：`0` 成功、`1` 前置检查失败、`2` 备份失败、`3` 依赖/构建/测试失败、`4` 重启失败、`5` 健康检查失败。

前置要求：**Node >= 22.5**（内置 `node:sqlite`）、npm；FFmpeg/ffprobe 缺失不阻断部署，但对应的转码/录像/测流能力不可用（脚本会明确告警）。

### 4.3 裸机 + 守护（当前现场在用）

`scripts/fire-watchdog.ps1` 每 30 秒健康检查 `/healthz`，失败自动重启实例；`scripts/start-fire-watchdog.cmd` 已可放入用户启动文件夹实现登录自启（本项目 Windows 机器已配置）。Linux 可用 systemd 包装同样命令：

```ini
[Unit]
Description=Flame Vision
After=network.target

[Service]
WorkingDirectory=/opt/fire-vision
ExecStart=/usr/bin/node server/boot.mjs --port 4173
Restart=always
Environment=DATA_DIR=/var/lib/fire-vision

[Install]
WantedBy=multi-user.target
```

### 4.4 Docker（推荐有 Docker 的现场）

```bash
docker compose up -d     # 构建时自动跑 npm test，数据落命名卷 fire-data
```

镜像内已含 FFmpeg；健康检查、只读根文件系统、`no-new-privileges`、资源上限均已配置。

### 4.5 公网访问

- 现场有公网 IP：HTTPS 反向代理（Nginx / Caddy）到 4173，务必开启 TLS
- 现场无公网 IP（多数内网）：用**边缘网关**——现场跑 `npm run edge -- --config edge-gateway.json`，主动外连到公网中心服务，手机只访问中心。配置文件见 `edge-gateway.example.json`
- 数据必须留在机房的场景：需要把隧道扩展为「任意 HTTP + SSE 透传」（当前版本只透传摄像头 HLS 流），动手前先评估

> 单实例约束：SQLite 单写多读，同一 `DATA_DIR` **只能起一个服务进程**（启动有实例锁保护）。

## 5. 摄像头接入

| 方式 | 操作路径 | 适用 |
|---|---|---|
| RTSP 手动 | 系统管理 → 点位与视频流 → 新增单个点位 | 已知地址 |
| ONVIF 自动发现 | ONVIF 自动发现 → 填 IP / 账号密码 → 发现 → 勾选通道导入 | 支持 ONVIF 的设备 |
| WS-Discovery 扫描 | ONVIF 表单 → 「扫描全网段」→ 自动回填 IP → 再走 ONVIF 流程 | 同网段批量找设备（交换机未禁组播时） |
| 品牌 NVR 批量 | 品牌设备批量接入 → 选品牌 / 填 NVR 与通道范围 | 海康、大华等 13+ 品牌 |
| 边缘网关 | 点位协议选「边缘网关」，地址 `edge://网关ID/摄像头标识` | 现场无公网、走隧道 |

接入后建议：先点「测流」确认可解码 → 用「预览抓图」配置 ROI 屏蔽（路灯、显示屏等常亮区域）→ 按场景选灵敏度（稳健 / 标准 / 灵敏）。

**http/https 源的额外要求**：源站必须支持 Range 请求（206）。FFmpeg 解码需要 seek；`python -m http.server` 不支持 Range，会导致检测worker 起不来并产生离线告警。

## 5.1 大屏自动轮巡

实时监控页右上「自动轮巡」按钮：按顺序把已接入视频源的点位逐路全屏播放，默认 15 秒切换，可改为 10/30/60 秒；全屏控制条支持暂停、上一路/下一路、退出。无视频源的点位自动跳过；轮巡期间每路仍照常做识别与告警（告警照常弹卡并推送）。关闭大屏（ESC）即退出轮巡。

## 6. 演示模式（无硬件验收 / 培训 / 演示）

超管 → 系统管理 → 点位与视频流 → 演示模式卡片 →「启动演示」。几秒后监控大屏出现「演示点位（合成火焰）」并自动产生火焰告警（置信度 90+），抓拍与短视频齐全，可走完整处置流程。「停止演示」会清理点位、流与目录。

演示产生的告警**会真实推送**到已配置的通知渠道，也会计入趋势看板与每日摘要——正式汇报前用「清除演示数据」一键清理（只清演示告警及其媒体 / 事件 / 推送日志，真实数据与审计日志不动）。

## 7. 日常运维

| 任务 | 操作 |
|---|---|
| 忘记管理员密码 | 项目目录执行 `npm run reset-password -- --username admin`（不传 `--password` 自动生成随机强密码；重置后所有设备需重新登录） |
| 数据库备份 | 每日自动备份到 `data/backups/`；也可管理端「系统备份」或调 `POST /api/admin/backup` |
| 日志 | stdout JSON 单行（`event`/`level`/`time`），重定向到文件即可；关键事件：`demo_*`、`camera_offline`、`media_watermark_pruned`、`daily_summary_sent`、`recording_index_reconciled`、`recording_retention_applied` |
| 磁盘水位 | 抓拍 + 短视频超过 `MEDIA_MAX_BYTES`（默认 2GB）自动清最老已关闭告警的媒体；`/api/system` 可看当前占用 |
| 录像保留 | 每小时按 `RECORDING_RETENTION_DAYS` / `RECORDING_MAX_BYTES` 淘汰最旧的非保护段并删文件；告警保护段在 `RECORDING_PROTECT_DAYS` 后解除；`GET /api/recordings/status` 查看采集状态，`POST /api/recordings/reconcile`（超管）手动对账 |
| 录像回放 | 「处置记录」页时间线点选时段 → 播放（按需 HLS）或导出 MP4；单次窗口上限 4 小时，会话空闲 90 秒回收 |
| 数据保留 | 告警 180 天（`ALARM_RETENTION_DAYS`）、推送日志 30 天，每日清理 |
| 升级部署 | `git pull` → `npm ci` → `npm run build` → 重启服务；schema 自动迁移（当前 **V10**：V9 性能索引、V10 `auth_sessions` 会话表；V1→V10 升级路径均有测试覆盖，V7 含告警表重建） |
| 健康检查 | `GET /healthz`（数据库 / FFmpeg / 磁盘 / 存活） |

**数据目录**（`data/`，已被 .gitignore 排除，含 SQLite 库、凭据密钥、备份、媒体）：迁移时整体拷贝，注意 `credentials.key` 与 `app.db` 必须一起走，否则已加密的通知渠道配置将无法解密。

## 8. 测试与 CI

```bash
npm test        # 289 项单元 / 接口测试（串行，约 1-2 分钟）
npm run e2e     # 25+ 项端到端断言（含失败登录、未登录 401；无 Chrome 时自动跳过）
npm run build   # tsc --noEmit + vite build
```

CI（`.github/workflows/ci.yml`）：push / PR 自动跑 安装 FFmpeg → `npm test` → `npm run build` → `npm run e2e`（ubuntu 自带 Chrome，`CHROME_PATH=/usr/bin/google-chrome`）。推到 GitHub 仓库即生效。

单文件检测预验（拿到新视频先跑它，参数与服务端引擎一致）：

```bash
node scripts/detect-file.mjs test-videos/火灾-酒精壁炉明火.webm standard
```

## 9. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `DATA_DIR` | 4173 / `./data` | 服务端口与数据目录 |
| `SERVER_DETECTION` | 开（`0` 关闭） | 服务端 7×24 检测引擎总开关 |
| `DETECTION_FPS` / `DETECTION_WIDTH` / `DETECTION_HEIGHT` | 1 / 160 / 90 | 抽帧率与画布 |
| `DETECTION_SENSITIVITY` / `DETECTION_COOLDOWN_MS` | standard / 12000 | 默认灵敏度与冷却 |
| `DETECTION_KEYFRAMES_ONLY` | 关 | 只解关键帧，大幅降 CPU（几十路以上部署用） |
| `MAX_DETECTION_CAMERAS` | 24 | 并发巡检路数上限，超出记 `skipped` |
| `CAMERA_QUALITY_CHECK` | 开（`0` 关闭） | 画面异常检测（遮挡/过暗/过曝，异常持续 45s 告警、连续正常 10s 自动归档） |
| `MAX_CONCURRENT_STREAMS` | 8 | 同时转码观看路数上限 |
| `HLS_SEGMENT_SECONDS` / `HLS_PLAYLIST_SIZE` | 1 / 4 | 分片时长（1-6）与播放列表片数（3-12），端到端延迟 2-4s |
| `FFMPEG_PATH` / `FFMPEG_PRESET` / `FFMPEG_VIDEO_CODEC` | ffmpeg / veryfast / libx264 | 转码参数 |
| `OFFLINE_TIMEOUT_MS` / `OFFLINE_CHECK_INTERVAL_MS` | 60000 / 15000 | 离线判定与巡检间隔 |
| `ESCALATION_MINUTES` / `ESCALATION_CHECK_INTERVAL_MS` | 5 / 60000 | 告警超时升级（≤0 关闭） |
| `ALARM_CLIP_SECONDS` | 10 | 告警短视频时长（2-60） |
| `RECORDING` | 关（`1` 开启） | 持续录像采集总闸；开启后按点位布防时间表启动 copy 分段进程，关闭时索引/对账/回放/导出仍可用 |
| `RECORDING_SEGMENT_SECONDS` | 60 | 单段时长（10-600）；须与索引校准口径一致 |
| `RECORDING_RETENTION_DAYS` | 14 | 录像保留天数（保护段豁免，过期后仍可被容量淘汰） |
| `RECORDING_PROTECT_DAYS` | 30 | 告警保护段的保护期，到期自动解除；告警误报处置（`status=false`）且同窗口无其它未处置告警时立即解除，提前释放配额 |
| `RECORDING_MAX_BYTES` | 50GB（0 关闭） | 录像独立容量配额，与告警短视频水位分离 |
| `RECORDING_MAX_CAMERAS` | 24 | 同时录像路数上限，超出记 `skipped` |
| `RECORDING_SHARED_SOURCE` | 关（`1` 开启） | 实验性：检测与录制共用一路 FFmpeg 输入（省一路解码）；默认关闭，不影响既有双进程路径 |
| `ALARM_RETENTION_DAYS` / `NOTIFY_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | 180 / 30 / 180 | 数据保留天数（告警 / 推送日志 / 审计日志） |
| `MEDIA_MAX_BYTES` | 2GB（0 关闭） | 媒体磁盘水位 |
| `DAILY_SUMMARY_AT` / `DAILY_SUMMARY_FORCE` | 08:00（上海时区）/ 关 | 每日摘要推送时间；`FORCE=1` 启动即跑一次（演练用） |
| `NOTIFY_MAX_FAILURES` | 5（0 关闭） | 渠道连续失败自动停用阈值 |
| `NOTIFY_BLOCK_PRIVATE` | 关（`1` 开启） | 公网部署建议开启：Webhook 额外拦截环回、私网与 `.local` 目标（防 SSRF 打内网） |
| `DEMO_WIDTH` / `DEMO_HEIGHT` / `DEMO_FPS` | 640 / 360 / 15 | 演示流画面规格 |
| `DEMO_SEGMENT_SECONDS` / `DEMO_PLAYLIST_SIZE` | 2 / 6 | 演示流分片参数 |
| `EDGE_GATEWAY_TOKEN` | 空（未启用） | ≥16 位；配置后中心接受现场网关连接，配对令牌在管理端「系统/边缘」状态条查看 |
| `EDGE_GATEWAY_CONFIG` | — | `npm run edge` 的配置文件路径 |
| `SESSION_SECRET` / `CREDENTIALS_KEY` | 自动生成并落盘 | 会话签名密钥 / 渠道加密密钥；外部注入需与既有数据一致 |
| `TRUST_PROXY` | 关 | 反代后按层数信任 `X-Forwarded-For` |
| `CHROME_PATH` / `E2E_PORT` / `E2E_HEADED` | — | E2E 测试专用 |
| `E2E_ADMIN_PASSWORD` | 内置测试默认值 | E2E/集成测试临时实例的管理员密码覆盖（仅测试用，不影响生产） |
| `BACKUP_RETAIN` / `BACKUP_MAX_BYTES` | 14 / 0（不限） | 每日备份份数上限（1-200）与备份目录总量上限（`0` 不限） |
| `CAMERA_BLOCK_PRIVATE` | 关（`1` 开启） | 相机视频源代理额外拦截私网/环回目标（默认放行，摄像头多在内网） |
| `PUBLIC_BASE_URL` | 空 | 推送文案里回链到本平台的外部地址，末尾斜杠会被去掉 |
| `FFPROBE_PATH` / `PROBE_TIMEOUT_MS` | ffprobe / 12000 | 测流工具路径与超时 |
| `FFMPEG_MAX_PROCESSES` / `FFMPEG_WAIT_TIMEOUT_MS` | 8 / 30000 | FFmpeg 全局进程预算上限与排队超时 |
| `ONVIF_DISCOVERY_ADDRESS` / `ONVIF_DISCOVERY_PORT` | 239.255.255.250 / 3702 | ONVIF 组播发现地址与端口 |

> **配置健壮性**：所有数值型配置统一经 `server/config.mjs` 解析 —— 非数字/`NaN`/超出范围一律回退默认值并写 `config_invalid` 警告日志，负数会被钳到下界（防止负保留天数删光历史数据），`0` 只在标注「0 关闭」的项上生效。布尔项统一接受 `1/true/yes/on` 与 `0/false/no/off`。`PORT` 需为 1-65535 整数，命令行 `--port` 优先于环境变量。

## 10. 目录结构

```
server/            服务端（Express 5 + node:sqlite）
  boot.mjs         启动入口：Node 版本、数据目录、长路径与可执行文件定位
  index.mjs        启动引导、中间件、单实例锁与路由注册
  config.mjs       数值/布尔/端口/时刻配置的统一解析（非法值回退并告警）
  runtime-check.mjs / binary-locate.mjs / ffmpeg-capabilities.mjs
                   运行时自检、ffmpeg 定位、编码器探测与回退
  routes/          按域拆分的 HTTP 路由（auth/cameras/alarms/notify/
                   sites/users/admin/demo/media/recordings）
  recording-index.mjs    持续录像段扫描、对账与时间线构建（不依赖 FFmpeg）
  recording-capture.mjs  录像采集 worker（copy 分段、退避、跨 UTC 日切目录）
  recording-playback.mjs 按需 HLS 回放会话与 MP4 导出（选段/路径校验/参数构造）
  ffmpeg-once.mjs        一次性 FFmpeg 进程公共骨架
  http/            鉴权守卫、会话与登录限流
  net-guard.mjs    出网地址校验（云元数据/内网拦截、逐跳重定向校验）
  schema.mjs       建表与 V1→V10 迁移
  store.mjs        数据层入口（openStore / Store）
  store/           领域方法（methods/）与行级辅助（helpers.mjs）
  types.mjs        共享 JSDoc 类型定义（不改变构建链）
  detector.mjs     识别算法（与服务端引擎同源）
  detection-engine.mjs  7×24 检测引擎
  frame-quality.mjs / schedule.mjs  画面异常检测 / 布防时间表
  streams.mjs      RTSP→HLS 转码管理
  notify.mjs       通知推送、模板渲染与渠道自愈
  demo-source.mjs  演示视频源
  vendors.mjs      13+ 品牌 NVR 的 RTSP 地址模板
  edge-hub/edge-gateway.mjs  边缘网关（中心侧/现场侧）
  onvif*.mjs       ONVIF 发现与扫描（SOAP 1.1/1.2 自适应）
  reset-password.mjs / restore-builtin-templates.mjs  运维工具
src/               前端（React 19 + TS + Vite 7）
scripts/           部署与运维：deploy.ps1 / deploy.sh / db-backup.mjs /
                   fire-watchdog.ps1 / launchd/ / e2e-smoke.mjs /
                   contrast-scan.mjs / detect-file.mjs
docs/              使用与设计文档（macOS 适配、GitHub 推送、录像设计、评审清单）
test-videos/       测试视频（Wikimedia Commons CC 授权，不入库）
data/              运行数据（不入库）：SQLite / 凭据 / 备份 / 媒体
  recordings/      告警短视频 mp4（受 MEDIA_MAX_BYTES 水位管理）
  continuous/      持续录像 TS 分段（独立目录，避免被短视频水位误清理）
  continuous-play/ 回放会话临时 HLS 产物（启动清空）
  continuous-export/ 导出用临时 MP4（下载后即删）
  backups/         自动与手工备份（VACUUM INTO 快照）
```

## 11. 常见问题

**Q：本地视频测试没有告警？**
A：确认顶栏「本地识别」不是「关闭」；播放本地文件时由浏览器识别（服务端看不到本地文件），页面切后台会暂停抽帧。

**Q：RTSP 点位播放卡 / 延迟高？**
A：默认 1 秒分片、端到端 2-4 秒。慢网把 `HLS_SEGMENT_SECONDS` 调到 2；仍卡则检查摄像头子码流带宽。

**Q：告警趋势里出现演示数据？**
A：演示告警会计入统计。管理端演示卡片 →「清除演示数据」一键清理。

**Q：页面提示「服务器磁盘空间不足」（HTTP 507）？**
A：磁盘写满时数据库与媒体文件都会拒绝写入。清理 `data/recordings/`、`data/continuous/` 或扩大磁盘；服务每 15 分钟会在日志写 `disk_low`（剩余 <1GB）提前预警，`/healthz` 的 `diskOk` 在剩余 <50MB 时转 false。

**Q：删除点位时提示「还有 N 条未处置告警」？**
A：这是有意的保护：先确认或标记误报（使告警归档）再删除，否则告警会变成无法在大屏复核的孤儿记录。删除成功后会同时清理该点位的 `streams/`、`continuous/`、回放/导出临时目录与录像索引。

**Q：服务反复重启、`data/watchdog.log` 里连续出现 `start attempt failed`？**
A：watchdog 连续 5 次启动失败后会进入 10 分钟长退避并写 `FATAL` 行 + `data/startup-failed.marker`。此时查看 `data/server.err.log` 定位根因（常见是数据库损坏或端口占用）；修复后删除 marker 并重启守护即可恢复自动拉起。

**Q：重启服务器后演示没了？**
A：设计如此——演示不持久化（重启自动清理残留点位），重新启动演示即可。

**Q：换了端口 / 换了机器，历史演示点位报错？**
A：演示点位地址只在演示运行期有效，重启后已自动清理；如遇残留 DEMO-01 点位，删除即可。

**Q：手机在外网看不了内网画面？**
A：外网不能主动入内网。用边缘网关（现场主动外连）或给现场公网 IP + HTTPS 反代，详见第 4.5 节。

---

## 12. 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) / [README.en.md](./README.en.md) | 项目说明（中文 / English） |
| [DELIVERY.md](./DELIVERY.md) | 交付物清单、验收基线、备份恢复、升级回滚、已知限制 |
| [SECURITY.md](./SECURITY.md) | 安全模型与加固说明 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发与评审约定 |
| [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md) | macOS 适配范围、版本要求、安装与 launchd |
| [docs/GITHUB.md](./docs/GITHUB.md) | 推送到 GitHub 的完整步骤 |
| [docs/DISTRIBUTION-PLAN.md](./docs/DISTRIBUTION-PLAN.md) | 部署流程评估与发行版打包方案 |
| [docs/continuous-recording-design.md](./docs/continuous-recording-design.md) | 持续录像设计说明 |
| [docs/REVIEW-CHECKLIST.md](./docs/REVIEW-CHECKLIST.md) | 评审清单（防回归） |

---

测试素材版权：`test-videos/` 下视频来自 Wikimedia Commons（CC BY / CC BY-SA / CC0），仅用于功能测试，请勿商用。

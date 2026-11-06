# 火情视频识别监控平台（Flame Vision）

浏览器与服务器双栈的火焰 / 烟雾视频识别监控平台：接入现场摄像头（RTSP / ONVIF / 网络摄像头 / 边缘网关），7×24 自动识别火焰与烟雾，命中即告警、抓拍、录短视频，并按站点推送给企业微信 / 钉钉 / Webhook。支持多租户站点隔离、多角色账号、告警处置闭环、趋势看板与审计日志。

无真实摄像头时，可用内置**演示模式**（FFmpeg 合成火焰直播流）跑通全链路。

---

## 1. 功能总览

| 层 | 能力 |
|---|---|
| 接入 | RTSP 转 HLS 低延迟播放；ONVIF 自动发现与导入；WS-Discovery 一键扫描全网段；13+ 品牌 NVR 批量导入（海康 / 大华 / 宇视 / Axis 等）；边缘网关隧道（现场无公网时主动外连） |
| 识别 | 服务端 7×24 检测引擎（每路一个 FFmpeg 抽帧进程，160×90@1fps，ROI 屏蔽、亮度闪烁判据、分点位灵敏度）；画面异常检测（镜头遮挡/过暗/过曝，持续超阈值自动告警、恢复自动归档）；浏览器本地识别兜底；两者自动去重（服务端接管时浏览器让位） |
| 告警 | SSE 实时推送；超时未确认自动升级；设备离线告警与恢复归档；抓拍 + H.264 短视频；告警短视频按时间轴回放（点击播放、前后跳转、自动连播）；每日值守摘要（滚动 24h） |
| 通知 | 企业微信 / 钉钉 / 通用 Webhook（HMAC-SHA256 签名）；告警文案模板可配（站点/点位/时间/置信度/处置链接变量）；渠道密钥加密落库；推送按「告警+渠道+事件」去重；连续失败自动停用并广播提醒（渠道自愈） |
| 权限 | 全局管理员 / 站点管理员 / 值班员 / 只读；站点级数据隔离，逐请求校验；SSE 按站点投递 |
| 观测 | 告警趋势看板（按天 / 分站点 / 误报率）；审计日志（筛选 + 分页 + 导出）；磁盘水位保护（按天数 + 按容量双保险） |
| 值守 | 大屏自动轮巡（已接入点位逐路全屏，10/15/30/60 秒可调，支持暂停、上一路/下一路、无源自动跳过） |
| 管理 | 点位批量操作（批量启停检测 / 批量灵敏度 / 批量删除）；布防时间表（按点位分时段布防，撤防时段仅停检测、播放不受影响，支持跨零点时段）；误报治理提示（7 天误报热点点位给出调灵敏度/屏蔽区建议）；新用户空状态三步引导（看演示 → 接摄像头 → 配通知） |
| 演示 | 演示模式：FFmpeg 合成火焰流，无硬件跑通播放→识别→告警→抓拍→推送→统计；演示数据一键清除 |

## 2. 系统要求

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`，Experimental）
- **FFmpeg**（必须，加入 PATH 或用 `FFMPEG_PATH` 指定；FFprobe 可选，用于一键测流）
- 内存 / CPU：每路检测约一个 FFmpeg 抽帧进程（160×90@1fps，CPU 占用低）；每路观看转码一个 FFmpeg 进程。单路演示 + 观看总计 3 个进程，普通服务器无压力
- Chrome（可选）：仅 E2E 测试需要

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

### 4.1 裸机 + 守护（当前现场在用）

`scripts/fire-watchdog.ps1` 每 30 秒健康检查 `/healthz`，失败自动重启实例；`scripts/start-fire-watchdog.cmd` 已可放入用户启动文件夹实现登录自启（本项目 Windows 机器已配置）。Linux 可用 systemd 包装同样命令：

```ini
[Unit]
Description=Flame Vision
After=network.target

[Service]
WorkingDirectory=/opt/fire-vision
ExecStart=/usr/bin/node server/index.mjs --port 4173
Restart=always
Environment=DATA_DIR=/var/lib/fire-vision

[Install]
WantedBy=multi-user.target
```

### 4.2 Docker（推荐有 Docker 的现场）

```bash
docker compose up -d     # 构建时自动跑 npm test，数据落命名卷 fire-data
```

镜像内已含 FFmpeg；健康检查、只读根文件系统、`no-new-privileges`、资源上限均已配置。

### 4.3 公网访问

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
| 日志 | stdout JSON 单行（`event`/`level`/`time`），重定向到文件即可；关键事件：`demo_*`、`camera_offline`、`media_watermark_pruned`、`daily_summary_sent` |
| 磁盘水位 | 抓拍 + 短视频超过 `MEDIA_MAX_BYTES`（默认 2GB）自动清最老已关闭告警的媒体；`/api/system` 可看当前占用 |
| 数据保留 | 告警 180 天（`ALARM_RETENTION_DAYS`）、推送日志 30 天，每日清理 |
| 升级部署 | `git pull` → `npm ci` → `npm run build` → 重启服务；schema 自动迁移（当前 V7，V1→V7 升级路径均有测试覆盖；V7 含告警表重建） |
| 健康检查 | `GET /healthz`（数据库 / FFmpeg / 磁盘 / 存活） |

**数据目录**（`data/`，已被 .gitignore 排除，含 SQLite 库、凭据密钥、备份、媒体）：迁移时整体拷贝，注意 `credentials.key` 与 `app.db` 必须一起走，否则已加密的通知渠道配置将无法解密。

## 8. 测试与 CI

```bash
npm test        # 65 项单元 / 接口测试（串行，约 1-2 分钟）
npm run e2e     # 11 项端到端断言（无 Chrome 时自动跳过）
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

## 10. 目录结构

```
server/            服务端（Express 5 + node:sqlite）
  index.mjs        启动引导、中间件、单实例锁与路由注册
  routes/          按域拆分的 HTTP 路由（auth/cameras/alarms/notify/
                   sites/users/admin/demo/media）
  http/            鉴权守卫、会话与登录限流
  schema.mjs       建表与 V1→V7 迁移
  store.mjs        数据层入口（openStore / Store）
  store/           领域方法（methods/）与行级辅助（helpers.mjs）
  types.mjs        共享 JSDoc 类型定义（不改变构建链）
  detector.mjs     识别算法（与服务端引擎同源）
  detection-engine.mjs  7×24 检测引擎
  frame-quality.mjs / schedule.mjs  画面异常检测 / 布防时间表
  streams.mjs      RTSP→HLS 转码管理
  notify.mjs       通知推送、模板渲染与渠道自愈
  demo-source.mjs  演示视频源
  edge-hub/edge-gateway.mjs  边缘网关（中心侧/现场侧）
  onvif*.mjs       ONVIF 发现与扫描
  reset-password.mjs  密码重置工具
src/               前端（React 19 + TS + Vite 7）
scripts/           e2e-smoke.mjs / detect-file.mjs / 守护脚本
docs/              设计方案（持续录像回放等）
test-videos/       测试视频（Wikimedia Commons CC 授权，不入库）
data/              运行数据（不入库）：SQLite / 凭据 / 备份 / 媒体
```

## 11. 常见问题

**Q：本地视频测试没有告警？**
A：确认顶栏「本地识别」不是「关闭」；播放本地文件时由浏览器识别（服务端看不到本地文件），页面切后台会暂停抽帧。

**Q：RTSP 点位播放卡 / 延迟高？**
A：默认 1 秒分片、端到端 2-4 秒。慢网把 `HLS_SEGMENT_SECONDS` 调到 2；仍卡则检查摄像头子码流带宽。

**Q：告警趋势里出现演示数据？**
A：演示告警会计入统计。管理端演示卡片 →「清除演示数据」一键清理。

**Q：重启服务器后演示没了？**
A：设计如此——演示不持久化（重启自动清理残留点位），重新启动演示即可。

**Q：换了端口 / 换了机器，历史演示点位报错？**
A：演示点位地址只在演示运行期有效，重启后已自动清理；如遇残留 DEMO-01 点位，删除即可。

**Q：手机在外网看不了内网画面？**
A：外网不能主动入内网。用边缘网关（现场主动外连）或给现场公网 IP + HTTPS 反代，详见第 4.3 节。

---

测试素材版权：`test-videos/` 下视频来自 Wikimedia Commons（CC BY / CC BY-SA / CC0），仅用于功能测试，请勿商用。

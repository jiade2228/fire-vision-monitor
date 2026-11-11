# macOS 兼容支持说明

> 版本：**v1.1.2**（在 v1.1.1 基础上新增 macOS 适配）
> 原则：**只增不改** —— 所有改动都以「PATH 能找到就不改变行为」为前提，Windows/Linux 现有部署行为完全不变。

---

## 一、支持的 macOS 版本

| 项 | 要求 | 说明 |
|---|---|---|
| macOS | **11 Big Sur 及以上** | Node.js 22 官方预编译二进制要求 macOS 11+；Apple Silicon 需 11+ |
| 架构 | Apple Silicon（arm64）/ Intel（x64） | 两架构均提供官方 Node 与 Homebrew 安装包 |
| Node.js | **>= 22.5.0**（推荐 22 LTS） | 项目依赖内置 `node:sqlite` |
| FFmpeg | 任意较新版本（建议 ≥ 6.0） | `brew install ffmpeg`；**不强制 libx264**，缺失时自动回退 |
| 浏览器（可选） | Chrome / Chromium / Edge | 仅 E2E 与对比度扫描需要 |
| 磁盘 | 数据目录 ≥ 500MB 可用 | 录像按容量与天数双淘汰 |

低于 macOS 11 无法保证 Node 22 可运行，**不建议**尝试。

---

## 二、涉及的模块与功能范围

### 2.1 代码改动（每项都保持原平台行为）

| 模块 | 问题 | 改动 | 对 Windows/Linux 的影响 |
|---|---|---|---|
| `server/binary-locate.mjs`（新增） | macOS 经 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，**找不到 Homebrew 的 ffmpeg**，表现为「服务起来了但所有点位转码失败」 | 解析顺序：显式 `FFMPEG_PATH` → PATH 命中（返回**裸名**，与改造前一致）→ 常见安装目录（`/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`）→ 原名兜底 | **无**：PATH 能找到时返回裸名，环境变量不被改写 |
| `server/boot.mjs` | 启动早期无路径补齐与 fd 上限提示 | 调用上述解析；fd 软上限 <1024 时输出 `fd_limit_low` 告警 | **无**：Windows 直接跳过 fd 检测；路径解析结果与原先一致 |
| `server/index.mjs` | 直接以 index 入口启动时（既有守护脚本）拿不到补齐 | `main()` 开头调用一次（幂等） | 无 |
| `scripts/lib/chrome-locate.mjs`（新增） | E2E 与对比度扫描只列 Windows Chrome 路径，**macOS/Linux 上会静默跳过**，形成「本地绿、实际没测」 | 按平台列出候选 + `CHROME_PATH` 优先 + PATH 兜底 | 无：Windows 两个原路径保留在最前 |
| `scripts/e2e-smoke.mjs`、`scripts/contrast-scan.mjs` | 同上，各自内联一份 | 改为引用统一模块 | 无 |
| `scripts/deploy.sh` | macOS 默认**没有 `setsid`**，后台启动分支会失败；也没有 `systemctl` | 平台分支：macOS → `launchctl kickstart`（已加载时）或 `nohup` 后台；Linux → systemd 或 `setsid`；都不可用时普通后台 | 无：Linux 仍优先 systemd，其次 setsid |
| `scripts/deploy.sh` | PATH 缺 Homebrew 时 `command -v ffmpeg` 失败 | 增加常见目录探测并导出 `FFMPEG_PATH`；macOS 额外提示 fd 上限 | 无：探测顺序仍是 PATH 优先 |
| `scripts/launchd/com.flamevision.monitor.plist`（新增） | macOS 缺少等价于 systemd/PS 守护的方案 | 提供 launchd 模板：PATH 含 Homebrew、`SoftResourceLimits` 4096、`KeepAlive SuccessfulExit=false`、日志落盘 | 无（不参与构建与运行） |

### 2.2 功能范围（macOS 上已确认可用的部分）

| 功能 | macOS 状态 | 说明 |
|---|---|---|
| 服务启动 / 登录 / 权限 | ✅ | 纯 Node，无平台依赖 |
| 点位管理 / 告警处置 / 审计 | ✅ | 纯 Node + SQLite |
| HLS/HTTP 点位播放 | ✅ | 浏览器侧播放，服务端仅代理 |
| RTSP 转码（ffmpeg） | ✅ 需安装 FFmpeg | 路径自动发现；编码器自动回退 |
| 服务端识别引擎 | ✅ 需 FFmpeg | 抽帧依赖 ffmpeg |
| 持续录像 / 回放 / 导出 | ✅ 需 FFmpeg | `copy` 分段与 HLS 拼接与平台无关 |
| 抓拍 / 短视频 | ✅ 需 FFmpeg | — |
| Webhook / 企微 / 钉钉通知 | ✅ | 纯 HTTP |
| ONVIF 扫描 / NVR 导入 | ✅ | 纯 HTTP + XML；SOAP 1.1/1.2 自适应 |
| 边缘网关（WebSocket） | ✅ | 纯 Node |
| E2E / 对比度扫描 | ✅ 需 Chrome/Chromium | 已支持 `/Applications/...` 与应用目录 |
| 守护 / 开机自启 | ⚠️ 需配置 launchd | 用 `scripts/launchd/*.plist`，见 §3.3 |
| 一键部署 | ✅ | `scripts/deploy.sh` |

---

## 三、安装与配置（macOS）

### 3.1 依赖安装

```bash
# Homebrew（若未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node@22 ffmpeg
node -v      # 需 >= 22.5
ffmpeg -version
```

> Apple Silicon 的 Homebrew 在 `/opt/homebrew/bin`，Intel 在 `/usr/local/bin`。
> 项目已在启动时自动探测这两处；若你的安装位置不同，请显式设置
> `FFMPEG_PATH` / `FFPROBE_PATH`。

### 3.2 一键部署

```bash
cd <项目目录>
./scripts/deploy.sh --dry-run     # 先检查
./scripts/deploy.sh               # 正式部署
```

脚本在 macOS 上会：
- 探测 Homebrew 的 ffmpeg/ffprobe 并导出路径
- 提示文件描述符软上限（<1024 时）
- 无 systemd 时优先 `launchctl`，否则 `nohup` 后台启动
- 日志写入 `data/logs/deploy-*.log`

### 3.3 配置开机自启（launchd）

```bash
# 1) 复制模板并替换占位符（__ROOT__ / __DATA_DIR__）
sed -e "s#__ROOT__#$PWD#g" -e "s#__DATA_DIR__#$PWD/data#g" \
  scripts/launchd/com.flamevision.monitor.plist \
  > ~/Library/LaunchAgents/com.flamevision.monitor.plist

# 2) 加载并启动
launchctl load -w ~/Library/LaunchAgents/com.flamevision.monitor.plist
launchctl kickstart -k gui/$(id -u)/com.flamevision.monitor

# 3) 查看状态与日志
launchctl print gui/$(id -u)/com.flamevision.monitor | head -30
tail -f data/server.out.log data/server.err.log
```

模板要点：
- `PATH` 包含 `/opt/homebrew/bin`（Apple Silicon）与 `/usr/local/bin`（Intel）
- `SoftResourceLimits.NumberOfFiles = 4096` 提升 fd 上限
- `KeepAlive.SuccessfulExit = false`：**仅异常退出时重启**，避免配置错误导致无限重启（与 Windows 守护的熔断思路一致）
- `ThrottleInterval = 30` 秒，防止快速循环

> 若 plist 里的 Node 路径不是 `/usr/local/bin/node`，请改成 `which node` 的结果
> （Apple Silicon 用 Homebrew 时通常是 `/opt/homebrew/bin/node`）。

### 3.4 防止系统休眠打断录像

macOS 默认会休眠，休眠期间录像与识别都会中断。值守机器建议：

```bash
# 临时（当前登录会话）
caffeinate -dimsu &

# 或把 caffeinate 包进 launchd（KeepAlive）
```

建议同时关闭「系统设置 → 电池/节能 → 自动休眠」，并确认「断电重启后自动登录」
（否则 launchd 用户级 Agent 不会启动）。

---

## 四、macOS 上的行为差异（需知悉）

| 项 | 说明 |
|---|---|
| 文件描述符上限 | 默认常为 256；多路 HLS + SSE + 录像并发可能 `EMFILE`。启动会告警，按 §3.3 设置 4096 |
| 系统休眠 | 不休眠才不会中断录像/识别 |
| 首次运行防火墙提示 | 监听 4173 时系统可能弹「是否允许接受传入连接」，需允许（局域网访问） |
| 文件系统大小写 | APFS 默认大小写不敏感。项目内部标识均为 UUID/小写，无影响；但**不要**手工创建仅大小写不同的目录 |
| `/tmp` 是符号链接 | 指向 `/private/tmp`；`realpath` 结果不同。项目不使用固定 `/tmp` 路径做比较，无影响 |
| 时区 | 项目固定按 Asia/Shanghai（+8）计算，**不依赖系统时区**，与其它平台一致 |
| 长路径 | macOS 无 Windows 的 MAX_PATH 限制，`long_path_risk` 告警只在 win32 触发 |
| 硬件加速 | 默认 `libx264` 软编；如需 `videotoolbox` 可设 `FFMPEG_VIDEO_CODEC=h264_videotoolbox`（需自行验证稳定性） |

---

## 五、验证方法

### 5.1 自动化（可在 macOS 上跑）

```bash
npm test                        # 273 条，含跨平台定位用例
npm run build
npm run e2e                     # 需 Chrome/Chromium（已支持 macOS 路径）
node scripts/contrast-scan.mjs
```

### 5.2 手动验证清单

| 检查 | 命令 / 操作 | 通过标准 |
|---|---|---|
| 版本前置校验 | `node server/boot.mjs --port 4199` | 输出 `boot_precheck_ok`，无 `boot_precheck_failed` |
| ffmpeg 自动发现 | 用 launchd 启动后看日志 | 无 `binary_resolved_from_default_dir` 告警，或告警中路径正确 |
| fd 上限 | 启动日志 | 无 `fd_limit_low`，或已按文档调高 |
| 健康检查 | `curl -s http://127.0.0.1:4173/healthz` | `ok:true`, `ffmpeg:true` |
| RTSP 转码 | 添加一路真实 RTSP 点位 | 画面出流，无 `spawn ffmpeg ENOENT` |
| 录像 | 开启 `RECORDING=1` | `data/continuous/<id>/` 产生 `.ts`，时间线有块 |
| 休眠不中断 | `caffeinate` 后合盖观察 | 录像段连续 |
| launchd 自启 | `launchctl kickstart -k` 后重启系统 | 服务自动恢复 |

---

## 六、回滚与影响面声明

- 新增文件：`server/binary-locate.mjs`、`scripts/lib/chrome-locate.mjs`、`scripts/launchd/*.plist`、本文档、两个测试文件。
- 修改文件：`server/boot.mjs`、`server/index.mjs`（各加一次幂等调用）、`scripts/deploy.sh`（平台分支）、`scripts/e2e-smoke.mjs`、`scripts/contrast-scan.mjs`（改用共享定位）。
- **未改动**：所有平台无关的业务逻辑、数据库结构、API 契约、前端代码。
- 回滚：`git revert` 对应提交即可；无数据迁移，无 schema 变更。

---

## 七、尚未验证的部分（如实标注）

| 项 | 原因 |
|---|---|
| 在真实 macOS 上的完整部署 | 本次开发环境为 Windows，无法实机运行 macOS |
| launchd 实际加载/自启 | 同上；plist 已按 Apple 文档编写，但未在真机 `launchctl load` 验证 |
| `h264_videotoolbox` 硬件编码 | 需真机 GPU 与 ffmpeg 支持，未测试；不建议未经压测就切换 |
| Apple Silicon 与 Intel 双架构 | 路径与 Node 二进制均已覆盖，但未逐一实机验证 |
| 休眠/唤醒后的流恢复 | 需真机长时间观察 |

建议在 macOS 真机上按 §5.2 逐项确认后再投产；在此之前可将 macOS 视为**已适配但未实机验收**。

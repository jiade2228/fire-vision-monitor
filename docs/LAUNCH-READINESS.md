# 上线就绪报告与自检清单

> 版本：**v1.1.0**（commit `9b17eb4`，tag `v1.1.0`）
> 时间：2026-11-12 00:10 GMT+8
> 结论：**已具备上线条件**。代码、构建、测试、数据迁移、生产部署均已完成并通过验证。
> 仍有 4 项需现场/外部条件才能确认，已在 §6 明确标注，未做通过推定。

---

## 一、本轮修复的问题与改动目的

### 阻塞项（原 BLOCK-1/2）

| # | 问题 | 改动 | 目的 |
|---|---|---|---|
| 1 | 111 个变更未提交，无回滚点、CI 未验证 | 提交 `9b17eb4` + 打 tag `v1.1.0` | 建立可复现的发布快照与回滚目标；`git diff` 可审计 |
| 2 | 生产运行 8.5 小时前的旧代码 | 重启生产实例（PID 11560 → 23820），watchdog 12 秒拉起 | 让全部安全与稳定性修复生效 |
| 3 | 无部署前备份 | `VACUUM INTO` 生成 `data/backups/prelaunch-2026-11-11T16-07-49-988Z.db`，`integrity_check=ok`，含 1 用户/6 点位/2 告警 | 出问题可即时回滚数据 |

### P2 生产风险（本轮新修）

| # | 问题 | 改动位置 | 改动内容与目的 |
|---|---|---|---|
| 4 | **磁盘写满无明确反馈** | `server/index.mjs` 全局错误中间件 | 识别 `SQLITE_FULL`/`ENOSPC`/`EDQUOT`，返回 **507** 与「磁盘空间不足」文案，并写 `disk_full` 日志。目的：把「莫名 500」变成可操作的明确故障 |
| 5 | **写满前无预警** | `server/index.mjs` 新增 `diskWarnTimer` | 每 15 分钟检查剩余空间，<1GB 写 `disk_low` 警告。目的：在写入失败前就暴露趋势 |
| 6 | **删点位留孤儿告警与录像目录** | `store/methods/alarms.mjs` 新增 `countOpenAlarmsByCamera`；`recordings.mjs` 新增 `deleteRecordingSegmentsByCamera`；`routes/cameras.mjs` 删除逻辑 | ①有未处置（pending/confirmed）告警时返回 **409** 并说明数量；②删除成功后清理 `streams/`、`continuous/`、`continuous-play/`、`continuous-export/` 与录像索引。目的：避免「告警无法复核」与「磁盘空间不释放」 |
| 7 | **损坏库导致重启循环** | `scripts/fire-watchdog.ps1` + `server/index.mjs` 启动失败分支 | ①watchdog 累计连续启动失败，5 次后进入 10 分钟长退避、写 `FATAL` 日志与 `data/startup-failed.marker`；②`Start-Process` 重定向 stdout/stderr 到 `data/server.out.log`/`server.err.log`；③服务启动失败时输出中文恢复指引（含损坏库处置步骤）。目的：让「无限重启且无日志」变成「可诊断 + 有人工介入点」 |

### P3 测试与文档

| # | 问题 | 改动 | 目的 |
|---|---|---|---|
| 8 | `time.mjs` 无测试（影响每日摘要、告警日聚合、布防判定） | 新增 `server/time.test.mjs` 6 条 | 锁死跨日/跨月/跨年/闰年/无夏令时口径 |
| 9 | `recording-duration.mjs` 无测试 | 新增 `server/recording-duration.test.mjs` 5 条（注入 mock spawn） | 锁定「只探测未校准段」「maxProbes」「失败不计入」「路径逃逸跳过」 |
| 10 | `probe.mjs` 无测试 | 新增 `server/probe.test.mjs` 4 条 | 锁定 ffprobe 可用性判定与「失败返回结构化错误不抛异常」 |
| 11 | README 写 V8 / 11 项 E2E | 改为 **V10 / 25+ 项**，并新增 3 条运维 FAQ（507、删点位 409、watchdog 熔断） | 让运维按文档操作不会误判 |
| 12 | 对比度报告被误纳入版本管理 | `.gitignore` 增加 `contrast-report.json` | 生成物不入库 |

---

## 二、改动影响面与兼容性

| 维度 | 说明 |
|---|---|
| 数据库 | **无 schema 变更**，仍为 V10；新增索引走幂等 `ensurePerformanceIndexes()` |
| API 契约 | 全部既有路径/字段/状态码不变；**新增**：删除点位 409、磁盘满 507、401 响应体带 `code` |
| 配置项 | 默认值不变；`DISK_*` 未新增环境变量（阈值硬编码在合理范围） |
| 前端 | 无需改动即可运行；`camera_abnormal` 映射修正后大屏不再误显示烟雾 |
| 回滚 | `git checkout v1.1.0~1` 可回代码；数据用 §3.2 备份恢复。HEAD 版本已验证能打开 V10 库（数据安全，但会回退安全修复） |

---

## 三、上线自检清单（已验证项）

### 3.1 代码与构建

- [x] `git status` 干净（除已忽略的生成物），HEAD = `9b17eb4`，tag `v1.1.0` 存在
- [x] `npm test` → **251/251 通过**（原 235，新增 16 条）
- [x] `npm run build` → 通过（tsc --noEmit + vite，79 modules）
- [x] `npm run e2e` → **全部通过**（含错误密码不泄露账号存在性、未登录 401、告警 SSE 推送、确认流转、录像对账/回放）
- [x] `node scripts/contrast-scan.mjs` → 10 场景 **0 违规**
- [x] `git diff --check` → 无空白错误
- [x] `scripts/fire-watchdog.ps1` PowerShell 语法解析通过（752 tokens）

### 3.2 数据与迁移

- [x] 部署前备份：`data/backups/prelaunch-2026-11-11T16-07-49-988Z.db`（integrity ok、237KB）
- [x] 迁移后生产库：`schema_version=10`、1 用户 / 6 点位 / 2 告警 **全部保留**
- [x] `auth_sessions` 表存在；内置模板 2 条；新增 5 个索引全部就位
- [x] 全新空库启动正常，内置模板自动播种（此前缺陷已修）

### 3.3 部署与运行

- [x] 旧实例停止 → watchdog **12 秒**拉起新实例（PID 23820）
- [x] `/healthz` → `ok:true, database:true, ffmpeg:true, ffprobe:true, diskOk:true`
- [x] **新代码生效实证**：`GET /api/alarms` 未登录返回 `{"error":"请先登录","code":"unauthenticated"}` —— `code` 字段仅 v1.1.0 有
- [x] `/api/auth/status` → `needsSetup:false`（配置未丢）
- [x] watchdog 日志 `healthy again, backoff reset`（监护正常）

### 3.4 异常路径

- [x] 数据库损坏启动实测 → 退出码 1、保留 `app.db.corrupt-*` 备份、`startup_failed` 含恢复指引
- [x] 端口占用启动实测 → 进程退出（不静默挂起）
- [x] 单实例锁：原子 `wx` 创建 + PID 存活检测 + 陈旧锁清理

---

## 四、上线后 24 小时观察项

| 时间点 | 检查 | 通过标准 |
|---|---|---|
| +10 分钟 | `curl /healthz`；`tail data/watchdog.log` | `ok:true`；无反复 `starting service` |
| +1 小时 | 登录 → 大屏 6 点位画面；告警中心；录像时间线 | 画面正常、无 5xx、时间线有块 |
| +2 小时 | 触发一次测试告警（或等真实告警）→ 确认 → 归档 | 状态流转正确、SSE 实时到达、抓拍存在 |
| +全程 | 日志关键字 | 无 `config_invalid`、`fatal_shutdown`、`disk_full`、`unhandledRejection` |
| +24 小时 | 内存与进程 | 无持续增长、无异常重启 |

> 注：当前守护进程仍是 14:58 加载的旧版脚本，新版熔断逻辑将在下一次守护重启或开机登录后生效。服务本体已是 v1.1.0。

---

## 五、故障处置速查

| 现象 | 处置 |
|---|---|
| 页面 507 / 日志 `disk_full` | 清理 `data/recordings/`、`data/continuous/` 或扩容；`disk_low` 是提前预警 |
| 删除点位 409 | 先处置（确认/误报）该点位告警，归档后再删 |
| 服务起不来 / `startup-failed.marker` | 看 `data/server.err.log`；若 `file is not a database`：停服 → 用 `data/backups/` 最近备份替换 `app.db`（同时移走 `app.db-wal`/`app.db-shm`）→ 删 marker → 重启守护 |
| 需要回滚代码 | `git checkout v1.1.0~1 -- .` 或 `git reset --hard <上一 tag>`；数据用 §3.2 备份恢复 |
| 忘记管理员密码 | `npm run reset-password -- --username admin`（重置后所有设备需重新登录） |

---

## 六、仍需现场确认的项（未做通过推定）

| 项 | 缺什么 | 影响与建议 |
|---|---|---|
| 真机视频源（V7） | 现场 RTSP/HLS 摄像头 | 拉流/抓拍/短视频/画面异常告警只能真机验证；建议上线首日逐个点位确认画面 |
| ONVIF 扫描（V8） | 现场 ONVIF 设备 | 组播发现受交换机配置影响；建议现场跑一次「一键扫描」 |
| 部署拓扑（V9） | `TRUST_PROXY` 实际值、是否有反代、是否云主机 | 影响限流与 SSRF 风险敞口；建议确认后记录到运维手册 |
| 24h 长稳（V10） | 时间 | 按 §4 观察项执行 |

**另**：本机未配置 git remote，`git push` 与 CI（GitHub Actions）无法触发。本地已用等价的 `test + build + e2e + contrast` 全量验证；如需 CI 背书，配置远程后推送 `v1.1.0` 即可。

---

## 七、上线判定

- **功能完整性**：README 所列能力逐项核验存在（13 品牌、连播、渠道自愈、布防、批量、演示等）
- **核心链路**：e2e + API 实测通过
- **数据安全**：备份 + 校验 + 迁移零丢失
- **异常处理**：损坏库/端口占用/磁盘满/重复启动均有明确行为
- **可回滚**：tag + 备份 + 明确回滚步骤

**结论：可上线。** 建议按「灰度观察 24 小时 → 全量」节奏执行，并按 §4 完成观察项。

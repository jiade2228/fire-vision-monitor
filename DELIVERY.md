# 交付与运维说明

> 语言：**简体中文** · [English summary](#english-summary)
> 适用版本：**v1.2.0** · 最近更新：2026-11-12

本文件面向部署与运维人员，说明交付物、验收基线、已知限制与升级回滚方式。
日常使用（功能、配置、接口）请看 [README.md](./README.md)。

---

## 1. 交付物清单

| 类别 | 内容 |
|---|---|
| 服务端 | `server/`（Express 5 + `node:sqlite`，含识别引擎、录像、通知、边缘网关、认证） |
| 前端 | `src/` + 构建产物 `dist/`（React 19 + TypeScript，Vite 构建） |
| 启动入口 | `server/boot.mjs`（版本前置校验 + 环境自检，**唯一推荐入口**） |
| 部署脚本 | `scripts/deploy.ps1`（Windows）、`scripts/deploy.sh`（Linux/macOS） |
| 便携包构建 | `scripts/package/portable.mjs` + `zip.mjs`（自带运行时，`npm run build:portable:zip`） |
| 备份工具 | `scripts/db-backup.mjs`（`VACUUM INTO` 一致性备份 + 完整性校验） |
| 守护方案 | Windows：`scripts/fire-watchdog.ps1`；Linux：systemd 示例（见 README §4.3）；macOS：`scripts/launchd/*.plist` |
| 测试 | `server/*.test.mjs`（单元/集成）、`scripts/e2e-smoke.mjs`（E2E）、`scripts/contrast-scan.mjs`（浅色对比度） |
| 文档 | 本文件、[README.md](./README.md)、[SECURITY.md](./SECURITY.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)、[docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md)、[docs/GITHUB.md](./docs/GITHUB.md)、[docs/DISTRIBUTION-PLAN.md](./docs/DISTRIBUTION-PLAN.md)、[docs/continuous-recording-design.md](./docs/continuous-recording-design.md)、[docs/REVIEW-CHECKLIST.md](./docs/REVIEW-CHECKLIST.md) |

---

## 2. 快速验收（任何人接手都能跑）

```bash
npm ci
npm test                        # 预期 289/289
npm run build                   # tsc --noEmit + vite build
npm run e2e                     # 无 Chrome 时自动跳过
node scripts/contrast-scan.mjs  # 浅色主题对比度，预期 0 处不达标
```

本机复验基线（v1.2.0）：

| 项 | 结果 |
|---|---|
| 单元/集成测试 | **289 / 289 通过** |
| 构建 | 通过（79 modules） |
| 端到端 | 全部通过（含未登录 401、错误密码不泄露账号存在性、SSE 推送、告警确认、录像对账与回放） |
| 对比度扫描 | 10 个场景 0 处不达标 |
| 数据迁移 | 存量 V10 库零丢失；全新库自动建表并补种内置模板 |
| CI（Ubuntu 22 / Node 22） | 单元测试、类型检查与构建、E2E 冒烟 全部通过 |
| 跨时区 | `TZ=UTC npm test` 与默认时区均为 289/289 |

---

## 3. 部署

一键部署（幂等、可重复执行）：

| 平台 | 命令 |
|---|---|
| Windows | `scripts\deploy.ps1` |
| Linux / macOS | `scripts/deploy.sh` |

执行顺序：**前置检查 → 数据库备份 → 依赖安装 → 构建 → 测试 → 重启 → 健康校验**。
常用参数：`-DryRun/--dry-run`、`-NoRestart/--no-restart`、`-SkipInstall/--skip-install`、`-SkipBuild`、`-SkipTests`、`-SkipBackup`、`-DataDir`、`-Port`。
退出码：`0` 成功、`1` 前置检查、`2` 备份、`3` 依赖/构建/测试、`4` 重启、`5` 健康检查。
日志：`data/logs/deploy-<时间戳>.log`。

前置要求：**Node ≥ 22.5**（内置 `node:sqlite`）、npm；FFmpeg/ffprobe 建议安装（缺失时 RTSP 转码/录像/抓拍不可用，HLS 点位仍可播放）。

### 3.1 守护与自启

- **Windows**：`scripts/fire-watchdog.ps1` 每 30 秒探测 `/healthz`，异常自动重启；连续 5 次启动失败进入 10 分钟退避并写 `data/startup-failed.marker`（需人工介入）。`scripts/start-fire-watchdog.cmd` 可放入启动文件夹。
- **Linux**：systemd 单元示例见 README §4.3（`ExecStart` 指向 `server/boot.mjs`）。
- **macOS**：`scripts/launchd/com.flamevision.monitor.plist`，安装步骤见 [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md)。

---

## 4. 数据与备份

| 项 | 说明 |
|---|---|
| 数据库 | `data/app.db`（SQLite，WAL 模式，`synchronous=FULL`） |
| 凭据密钥 | `data/credentials.key`（**必须与备份一起保存**，丢失则库内凭据无法解密） |
| 会话密钥 | `data/session.secret` |
| 备份 | `node scripts/db-backup.mjs --data-dir ./data`（默认写入 `data/backups/`） |
| 备份正确性 | 使用 `VACUUM INTO`，包含 WAL 中已提交事务；直接复制 `app.db` 会丢最近数据 |
| 自动备份 | 服务内定时任务（默认保留 14 份，且受总量上限约束） |

恢复步骤：
1. 停止服务；
2. 用备份覆盖 `data/app.db`，同时删除 `data/app.db-wal`、`data/app.db-shm`；
3. 确认 `data/credentials.key` 与备份来自同一套环境；
4. 启动并检查 `/healthz`。

---

## 5. 升级与回滚

```bash
# 升级
git fetch --tags && git checkout v1.1.3
./scripts/deploy.sh            # 或 scripts\deploy.ps1

# 回滚
git checkout <上一个 tag>
./scripts/deploy.sh --skip-tests
# 数据回滚见 §4
```

- 数据库 schema 为 **V10**，升级自动迁移且向前兼容（V1→V10 路径有测试覆盖）。
- 无 schema 变更的小版本可直接回退代码；跨大版本回退需同时恢复对应备份。

---

## 6. 已知限制

| 项 | 说明 |
|---|---|
| 单实例 | SQLite 单写多读，同一 `DATA_DIR` 只能运行一个实例（启动有 `instance.lock` 保护） |
| 浏览器播放 | HLS 依赖浏览器原生或 hls.js；Safari 对 HLS 支持较好，其他浏览器走 hls.js |
| 识别准确率 | 依赖现场光照与镜头；提供 ROI 屏蔽、灵敏度分级与误报热点建议，但**不承诺固定准确率**，需现场调参 |
| 硬件加速 | 默认软件编码（`libx264`）；缺失时自动回退 `h264`/`mpeg4`。硬件编码需自行验证 |
| 多实例/集群 | 不支持。SSE、限流、录像对账均为进程内状态 |
| 真机协议差异 | ONVIF 已支持 SOAP 1.1/1.2 自适应，但厂商固件差异仍需现场验证 |
| Windows 长路径 | dataDir 路径过长（>180 字符）时启动会告警，建议放在短路径 |

---

## 7. 常见运维动作

| 场景 | 操作 |
|---|---|
| 重置管理员密码 | `npm run reset-password -- --username admin`（重置后所有设备需重新登录） |
| 恢复被误删的内置通知模板 | `node server/restore-builtin-templates.mjs` |
| 查看服务状态 | `curl http://127.0.0.1:4173/healthz` |
| 查看指标 | `GET /api/metrics`（需登录） |
| 磁盘写满（HTTP 507） | 清理 `data/recordings/`、`data/continuous/` 或扩容；日志先出现 `disk_low` 预警 |
| 删除点位报 409 | 该点位还有未处置告警，先确认或标记误报后再删 |

---

## English summary

This document is for operators. Day-to-day usage (features, configuration, APIs) is in [README.en.md](./README.en.md).

- **Requirements**: Node ≥ 22.5 (built-in `node:sqlite`), npm, FFmpeg (recommended), macOS 11+ / Windows 10+ / Linux.
- **Deploy**: run `scripts/deploy.ps1` (Windows) or `scripts/deploy.sh` (Linux/macOS). Idempotent; steps are preflight → backup → install → build → test → restart → health check. Exit codes: 1 preflight, 2 backup, 3 build/test, 4 restart, 5 health.
- **Backup**: `node scripts/db-backup.mjs --data-dir ./data` uses `VACUUM INTO` (a plain file copy misses uncheckpointed WAL data). Keep `data/credentials.key` with the backup.
- **Single instance only**: SQLite single-writer; one process per `DATA_DIR` (guarded by `instance.lock`).
- **Verification baseline (v1.1.3)**: 289/289 unit tests, build passes, E2E passes, contrast scan 0 violations, no data loss when migrating an existing V10 database.
- **Known limits**: no clustering; recognition accuracy depends on site conditions and needs on-site tuning; software encoding by default with automatic fallback; vendor-specific ONVIF quirks still need field validation.

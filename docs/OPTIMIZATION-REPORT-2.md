# 第二轮系统性优化报告

> 项目：火焰/烟雾视频识别监控平台（fire-vision-monitor）
> 基线：第一轮升级（`docs/OPTIMIZATION-REPORT.md`）→ 本轮
> 验证：`npm test` **184/184** · `npm run build` 通过 · `npm run e2e` **23/23** · 浅色对比度 **0 违规** · `git diff --check` 无空白错误
> 本轮范围（用户确认）：**P0 安全与可靠性(1-5) + 性能与索引(6-10) + 资源与并发(11-13) 全部实施**

---

## 一、本轮目标点

| 组 | # | 目标点 | 一句话说明 | 主要落点 |
|----|---|--------|------------|----------|
| **P0 安全与可靠性** | 1 | 凭据脱敏 | FFmpeg 把带密码的 RTSP 地址打进 stderr → 统一抹除 userinfo | `server/sanitize.mjs`（新增） |
| | 2 | 进程级异常治理 | 未捕获 rejection 会**直接终止 Node 进程** → 加守卫 | `server/process-safety.mjs`（新增） |
| | 3 | 保护期语义 | 保护段让 `recordingMaxBytes` 形同虚设 → 仅超配额时可淘汰 | `server/store/methods/recordings.mjs` |
| | 4 | 磁盘预算 | 备份目录完全不在视野内 → 纳入统计 + 轮转双约束 | `server/store.mjs`、`server/index.mjs` |
| | 5 | 备份可恢复性 | 备份可能损坏且无人知晓 → 落盘前完整性校验 | `server/store.mjs` |
| **性能与索引** | 6 | 关键索引 | 告警列表/水位清理/推送日志查询全表扫描 → V9 迁移 | `server/schema.mjs` |
| | 7 | 审计关键词搜索 | 前导通配符 LIKE 必然全表扫描（3.4 s）→ 收敛时间窗 | `server/store/methods/audit.mjs` |
| | 8 | 审计清理 | `LIMIT -1 + IN(...)` 物化 48 万 ID（1.1 s）→ 阈值删除 | `server/store/methods/audit.mjs` |
| | 9 | 媒体水位清理 | 循环内 60 次全盘扫描（≈24 s 冻结）→ 一次 SELECT + 一条 UPDATE | `server/store/methods/maintenance.mjs` |
| | 10 | 查询统计信息 | 缺 `sqlite_stat1` 时规划器忽略部分索引 → 定期 ANALYZE | `server/store.mjs`、`server/index.mjs` |
| **资源与并发** | 11 | FFmpeg 进程预算 | 四个模块各自 spawn，几十路点位直接打满机器 | `server/ffmpeg-budget.mjs`（新增） |
| | 12 | 告警落库时序 | 抓拍阻塞落库 1~3 s，进程一挂这段火情永久丢失 | `server/detection-engine.mjs` |
| | 13 | SSE 与前端渲染 | 原生 EventSource 固定间隔重连 + 每次 error 全量刷新 | `src/lib/sse.ts`（新增）、`src/hooks/useAlarms.ts` |

**总览**：本轮新增 11 个文件（7 个源码/测试 + 1 个前端模块），修改 21 个文件。

---

## 二、实测数据

> 基准库：20 万 alarms / 50 万 audit_logs / 20 万 recording_segments（SQLite `node:sqlite`，WAL + `synchronous=FULL`）。

| 项目 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 管理员告警列表（`ORDER BY created_at DESC LIMIT 300`） | 38 ms（SCAN + 临时排序） | **0.83 ms**（`SCAN USING INDEX idx_alarm_created`） | **46×** |
| 审计日志按条数清理（50 万 → 保留 2 万） | 1119 ms | **360 ms** | **3.1×** |
| 审计关键词搜索 | 3.4 s | 收敛到 180 天窗口后 < 50 ms | **>60×** |
| 媒体水位清理 SQL | SCAN + `USE TEMP B-TREE` | `SCAN USING INDEX idx_alarm_media_old` | 无临时排序 |
| 媒体目录扫描（3000 文件） | 379 ms | **47 ms** | **8×** |
| 媒体水位清理整轮（20 轮 × 3 目录全扫描） | ≈ 24 s 事件循环冻结 | **≈ 0.1 s**（2 次扫描 + 本地累加） | **>200×** |
| `ANALYZE` 开销（20 万行） | — | 18 ms（每日一次） | 可忽略 |
| 备份落盘校验 | 无（可能产出损坏备份） | `integrity_check` + 行数比对，不合格即删 | 新增保障 |

---

## 三、新增文件

| 文件 | 行数 | 作用 |
|------|------|------|
| `server/sanitize.mjs` | 37 | **单一脱敏实现**：`stripUserinfo()` 按 URL 结构整体抹除 userinfo（正则按 `@` 匹配在密码含 `@` 时会漏）；`sanitizeErrorText()` 折叠空白并限长 |
| `server/sanitize.test.mjs` | 50 | 7 条：RTSP 凭据抹除、密码含 `@`、http/https userinfo、无凭据不误伤、多 URL、长度截断、非字符串输入 |
| `server/process-safety.mjs` | 92 | `installProcessGuards()`：未捕获 rejection **记日志+计数但不退出**；未捕获异常走优雅停机；提供可观测 state |
| `server/process-safety.test.mjs` | 102 | 5 条：用 `process.on/off` 打桩捕获监听器（不真的触发未捕获异常污染 test runner）；覆盖计数、日志、onFatal、onCount、回调自身抛错 |
| `server/backup-guard.test.mjs` | 106 | 5 条：备份落盘可打开且行数一致、失败不留 `.partial`、份数上限、总量上限、非数据库文件被拒且给出可读原因 |
| `server/detection-status.test.mjs` | 94 | 2 条：状态接口按站点过滤；stderr 写入 lastError 前已脱敏且接口不回显密码 |
| `server/ffmpeg-budget.mjs` | 230 | **全局 FFmpeg 进程预算**：信号量 + FIFO 队列；`tryAcquire()` 同步快路径、`acquire()` 排队、`release()` 幂等、`stats()` 可观测 |
| `server/ffmpeg-budget.test.mjs` | 160 | 9 条：立即放行、FIFO 唤醒、release 幂等、null 安全、等待超时、withSlot 异常归还、setLimit 唤醒、区间夹取、峰值统计 |
| `server/perf-index.test.mjs` | 350 | 10 条：新库索引齐备、V8 存量库升级、迁移可重入、规划器采纳部分索引、**旧版 alarms 缺 clip_file 仍可升级**、审计阈值清理（含同毫秒精确切分）、关键词时间窗、批量媒体清理 |
| `server/detection-snapshot.test.mjs` | 178 | 2 条：告警先落库后抓拍异步回填；抓拍失败不影响告警落库 |
| `src/lib/sse.ts` | 187 | **带指数退避的 SSE 客户端**：自行管理连接（禁用原生固定间隔重连）、1s→30s 退避 + ±20% 抖动、成功后重置、服务端告别事件立即重连 |

---

## 四、修改文件与关键改动

### 4.1 `server/schema.mjs` — V9 迁移

```js
export const SCHEMA_VERSION = 9;   // 8 → 9
export const PERFORMANCE_INDEXES_DDL = `...`;   // 4 条索引
export function ensurePerformanceIndexes(db) { db.exec(PERFORMANCE_INDEXES_DDL); }
export function migrateSchemaV9(db) { ... }      // BEGIN IMMEDIATE → 建索引 → 版本号 → COMMIT
```

索引集合：

| 索引 | 解决的问题 |
|------|-----------|
| `idx_alarm_created ON alarms(created_at DESC)` | 管理员告警列表全表扫描 + 临时排序 |
| `idx_alarm_media_old ON alarms(created_at) WHERE status IN ('archived','false') AND (snapshot_file IS NOT NULL OR clip_file IS NOT NULL)` | 磁盘水位清理的部分索引，WHERE 与 ORDER BY 同时命中 |
| `idx_notify_channel ON notification_logs(channel_id, created_at DESC)` | 按渠道删除推送日志（此前 2.3 s） |
| `idx_seg_protected ON recording_segments("protected", started_at)` | 解除保护、按保护状态统计用量 |

**踩坑与修正（重要）**：这些索引**最初写进了 `createSchema`** —— 但 `createSchema` 对存量库是「不重建已有表」的，它先于 V4/V7 迁移执行，而旧版 `alarms` 表还没有 `clip_file` / `site_id` 列。结果存量 v3 库**直接启动失败**：

```
SQLite 数据库初始化失败：no such column: clip_file
```

修正：索引从 `createSchema` 移除，统一由 `ensurePerformanceIndexes()` 在**所有表结构迁移完成之后**执行（`store.mjs` 的迁移序列末尾 + `migrateSchemaV9` 内部）。已补回归测试 `V9 索引：旧版 alarms 表缺 clip_file 列时仍能升级`。

### 4.2 `server/store.mjs` — 迁移装配 + 备份可靠性

- 迁移序列末尾追加 `migrateSchemaV9(db)` → `ensureDefaultSite(db)` → `ensurePerformanceIndexes(db)`。
- 追加 `ANALYZE`（包 try/catch）：统计信息必须在**建索引之后**采集，规划器才知道部分索引的存在与规模。实测：没有 `sqlite_stat1` 时媒体水位清理退回 `SCAN + USE TEMP B-TREE`，有统计信息后才走 `SCAN alarms USING INDEX idx_alarm_media_old`。
- **`backup()` 重写**：`VACUUM INTO` 到 `.partial` → `verifyBackupFile()`（`PRAGMA integrity_check` + 关键表存在性 + 与主库行数一致）→ 原子 rename → 失败删半成品。原先直接写最终文件，进程被杀会留下**半截备份**且无人知晓。
- 新增 `rotateBackups()`：份数 + 总量双约束，至少保留 1 份。

### 4.3 `server/store/methods/audit.mjs` — 关键词时间窗 + 阈值删除

- `buildAuditFilter()`：有关键词且用户**未显式指定起始时间**时，自动加 `created_at >= now - 180 天`（与审计保留期默认一致）。关键词模糊匹配（前导 `%`）无法走任何 B-tree 索引，只能全表扫描。
- 新增 `auditSearchWindowed()`：接口层据此回传 `searchWindowed: true` + `searchWindowDays`，**前端明确提示「结果只覆盖最近 N 天」**，不静默丢结果。
- `pruneAuditLogs()`：由 `DELETE ... WHERE id IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?)`（物化 48 万 ID）改为**两段式阈值删除**：
  1. 取第 `retain` 条的 `created_at` 作为阈值 → `DELETE WHERE created_at < ?`（走索引范围扫描）；
  2. 阈值所在「同毫秒桶」可能多于应保留条数 → 按 `rowid` 倒序补删多余记录，保证**恰好保留 retain 条**。

### 4.4 `server/store/methods/maintenance.mjs` — 水位清理批量化

- `clearOldestAlarmMedia()`：由逐行 UPDATE（100 条 = 100 次语句往返）改为**一次 SELECT + 一条批量 UPDATE**（`WHERE id IN (...)`，按 3 万绑定变量上限分片）。
- 新增 `analyze()`：采集 `sqlite_stat1`，失败不抛异常（只影响查询计划）。

### 4.5 `server/store/methods/alarms.mjs`

- 新增 `setAlarmSnapshot(id, file)`：配合「告警先落库、抓拍异步补齐」。

### 4.6 `server/store/methods/recordings.mjs`

- `pruneRecordingSegments({ includeProtected })`：`includeProtected=false`（默认）仍跳过保护段；`true` 时允许淘汰**最旧**的保护段 —— 保护期仍为 30 天，但超配额时不再让 `recordingMaxBytes` 形同虚设。

### 4.7 `server/index.mjs`

| 改动 | 说明 |
|------|------|
| 进程守卫 | `installProcessGuards()` 装在 `main()` 起始处；`unhandledRejections` / `uncaughtExceptions` 计入 `metrics` |
| 优雅停机 | SSE 客户端先发 `event: server.shutdown` 告别事件再 `end()`；**修正关闭顺序**为 `server.close(cb)` → `closeAllConnections()`（原先反序，SSE 长连接会让 close 回调永不触发 → `store.close()` 永不执行）；8 秒兜底退出码由 `1` 改 `0` 并记 `server_shutdown_forced` |
| 裸 void 修复 | 6 处 `void xxx()` 改为 `.catch()` —— Node 22 未捕获 rejection 会终止进程 |
| 备份配置 | 新增 `BACKUP_DIR` / `BACKUP_RETAIN`（1..200，默认 14）/ `BACKUP_MAX_BYTES`（默认 0=不限） |
| 磁盘预算 | `computeMediaUsage` 增加 `backups`（扫描备份目录）与 `streams`；超阈值记 `disk_pressure` |
| 水位清理 | 循环内移除每轮 `computeMediaUsage(true)`；删除量按 `stat` 到的真实字节本地累加，循环结束统一重算一次；文件删除改并发 |
| 保留任务 | 每日任务追加 `store.analyze()` 刷新查询统计信息 |
| 抓拍广播 | 新增 `onSnapshot` 回调 → 广播 `alarm.updated` |

### 4.8 `server/detection-engine.mjs`

- **凭据脱敏**：stderr / `onExit` / `scheduleRestart` 的 `lastError` 全部经 `sanitizeErrorText()`。
- **状态按站点过滤**：`status({ allowedSiteIds })` 过滤 `workers` 与 `sharedCameras`。
- **FFmpeg 预算接入**：`CameraWorker.start()` 改为「`tryAcquire()` 同步快路径 → 不足则 `acquire()` 排队」。**同步快路径是必须的**：构造函数原本同步拉起 FFmpeg，改成异步会在启动瞬间产生「没有子进程也没有帧」的空窗，并打乱调用方对 `worker.child` 的同步预期（现有测试即依赖这一点）。
- **告警先落库**：
  ```js
  // 原：const snapshotFile = await this.captureSnapshot(camera, id);  ← 阻塞 1~3 s
  // 新：先 createAlarm({ snapshotFile: null })，再异步 captureSnapshot → setAlarmSnapshot → onSnapshot 广播
  ```
  火情告警的第一要务是「先记下来」，素材可以晚几秒补。原实现里 RTSP 建连期间告警还没进库，进程一旦崩溃或被杀，这段火情就永久丢失。
- 抓拍/短视频的一次性 FFmpeg 调用也走预算（`budget.withSlot`），告警高峰时不会与常驻抽帧进程抢 CPU。

### 4.9 `server/recording-capture.mjs` / `server/shared-source.mjs` / `server/streams.mjs`

- 三处常驻 FFmpeg 全部接入预算：拿到名额才 spawn，进程退出/停止即归还（`release` 幂等）。
- `recording-capture` / `shared-source` 的 `lastError` 脱敏；`CaptureWorker.status()` / 共享源状态增加 `siteId`。
- `streams.mjs`：`StreamManager` 接入预算，拿不到名额时抛 `StreamError(code='FFMPEG_BUDGET', status=503)`，前端可提示稍后重试；`fail()` / `stop()` 均归还名额。

### 4.10 `server/probe.mjs` / `server/streams.mjs` / `server/notify.mjs`

- 脱敏实现**收敛为单一来源**：`probe.mjs` 与 `streams.mjs` 删掉各自的本地实现，改为 `import { stripUserinfo, sanitizeErrorText } from './sanitize.mjs'`。
- `notify.mjs` 的 `post()` 不再回显上游响应体（上游可能返回内部地址/令牌）。

### 4.11 `server/routes/admin.mjs`

- `/api/audit` 增加 `searchWindowed` / `searchWindowDays` 字段（仅在关键词搜索被收敛时出现，**新增字段不破坏既有调用方**）。
- `/api/metrics` 增加 `ffmpeg: ffmpegBudget.stats()`（limit / active / waiting / peakActive / totalAcquired / totalRejected）。

### 4.12 `server/routes/demo.mjs`

- `/api/system` 与 `/api/detection/status` 按站点过滤传入 `allowedSiteIds`。
- `storage` 增加 `backups` / `streams` / `dataBytes` 字段。

### 4.13 前端

| 文件 | 改动 |
|------|------|
| `src/lib/sse.ts`（新增） | `connectSse()`：自行管理连接；断开后按 1s→2s→4s→…→30s 退避重连（±20% 抖动防惊群）；连接成功重置退避；收到 `server.shutdown` 立即重连（不等退避） |
| `src/hooks/useAlarms.ts` | ① 改用 `connectSse`，**断开期间不再每次 error 都全量刷新**（原先服务端故障时每 3 秒刷一次 `/api/alarms`）；② `upsertAlarm()` 合并告警：新增直接前插、更新只替换单项（createdAt 不变，位置不动，**免全量排序**）；内容完全没变时**返回原数组引用**，让 React 跳过整表重渲染 |
| `src/lib/api.ts` | `AuditLogPage` 增加可选 `searchWindowed` / `searchWindowDays` |
| `src/components/AdminPanel.tsx` | 保存 `searchWindowed` 状态并下发 |
| `src/components/admin/AuditTab.tsx` | 收敛时展示提示条，指引用户在上方「时间范围」指定更长区间 |
| `src/styles/app.css` | 新增 `.admin-hint`（只用 `var(--tone-warn)` 前景色 + 左边框，不叠半透明背景，保证两套主题对比度都只取决于前景色与底色） |

### 4.14 `server/recording-index.test.mjs`

- 断言从 `schema_version === '8'` 更新为 `'9'`（V9 迁移是预期变更）。

---

## 五、缺陷与隐患修复清单

| # | 缺陷 | 后果 | 修复 |
|---|------|------|------|
| 1 | FFmpeg stderr 把 `rtsp://user:pass@host` 原样写进 `lastError` | 摄像头密码经状态接口回传前端 / 工单 / 截图泄漏 | 统一 `sanitize.mjs` 脱敏（含密码含 `@` 的情况） |
| 2 | 全仓零 `unhandledRejection` 监听器 | Node 22 未捕获 rejection **终止进程**（退出码 1），告警丢失 | `process-safety.mjs` 守卫 + 6 处裸 void 修复 |
| 3 | shutdown 时 `server.close()` 与 `closeAllConnections()` 顺序反了 | SSE 长连接让 close 回调永不触发 → `store.close()` 永不执行 → WAL 不 checkpoint | 修正顺序 + 告别事件 + 兜底退出码改 0 |
| 4 | 备份直接写最终文件，无校验 | 进程被杀留下半截备份，**无人知晓**，恢复时才发现 | `.partial` → `integrity_check` + 行数比对 → 原子 rename |
| 5 | 备份目录完全不计入磁盘统计 | 备份随库体积线性放大（14 份 × 库大小），写满磁盘导致 SQLite 写入失败 | 纳入 `computeMediaUsage` + 份数/总量双约束轮转 |
| 6 | 保护段永不可淘汰 | `recordingMaxBytes` 对取证点位形同虚设 | 仅超配额时允许淘汰最旧保护段（保护期仍 30 天） |
| 7 | `pruneAuditLogs` 用 `LIMIT -1 + IN(...)` | 50 万行时物化 48 万 ID，1.1 s 阻塞事件循环 | 两段式阈值删除（360 ms，恰好保留 retain 条） |
| 8 | 关键词审计搜索必然全表扫描 | 3.4 s 阻塞，端点长时间无响应 | 收敛到默认时间窗 + 接口显式回传标记 + 前端提示 |
| 9 | 媒体水位清理循环内每轮全盘扫描 | 60 次 readdir+stat，≈24 s 事件循环冻结 | 循环外扫描 + 本地累加 + 一次 SELECT/一条 UPDATE |
| 10 | 缺 `sqlite_stat1` 时规划器忽略部分索引 | 水位清理退回全表扫描 + 临时排序 | 迁移后 + 每日 `ANALYZE` |
| 11 | 四个模块各自 spawn FFmpeg，无全局上限 | 几十路点位同时拉起 FFmpeg，CPU/内存/句柄打满，机器需重启 | `ffmpeg-budget.mjs` 全局预算（默认 8，`FFMPEG_MAX_PROCESSES` 可调） |
| 12 | 抓拍阻塞告警落库 1~3 s | 进程崩溃/被杀则这段火情永久丢失 | 告警先落库，抓拍异步补齐 + 回填 + 广播 |
| 13 | 原生 EventSource 固定间隔重连 + 每次 error 全量刷新 | 服务端故障时每 3 秒一次重连 + 一次全量 API 刷新 | 自管连接 + 指数退避 + 断开期间不刷新 |
| 14 | 每次 SSE 事件都全量排序告警数组 | O(n log n) + 整表重渲染 | 免排序合并 + 内容未变返回原引用 |
| 15 | V9 索引建在 `createSchema` 里 | 存量 v3 库启动即失败（`no such column: clip_file`） | 索引改由迁移后统一创建 + 回归测试锁定 |
| 16 | `getFreePort()` 端口复用竞态 | 测试偶发失败（142/143） | 进程内去重 + 二次 canBind 校验（第一轮已修） |

---

## 六、向后兼容性说明

| 变更 | 兼容性 | 说明 |
|------|---------|------|
| `SCHEMA_VERSION` 8 → 9 | ✅ 自动升级 | 只加索引，不改表结构；旧库启动时自动迁移；`migrateSchemaV9` 可重入 |
| `/api/audit` 增加 `searchWindowed` / `searchWindowDays` | ✅ 纯新增 | 旧客户端忽略未知字段；仅关键词搜索且未指定时间范围时出现 |
| `/api/metrics` 增加 `ffmpeg` | ✅ 纯新增 | 同上 |
| `/api/system` 的 `storage` 增加 `backups` / `streams` / `dataBytes` | ✅ 纯新增 | 同上 |
| 告警落库时序（先落库后抓拍） | ⚠️ 行为可见但向前兼容 | 抓拍图从「告警出现时就有」变为「1~3 秒后补齐」，期间 `snapshot` 为 null；SSE 会广播 `alarm.updated` 通知前端刷新 |
| 关键词审计搜索默认时间窗 180 天 | ⚠️ 行为可见但向前兼容 | 显式指定 `from` 即可搜全量；接口明确回传 `searchWindowed` 告知调用方结果不完整 |
| 新增环境变量 `FFMPEG_MAX_PROCESSES` / `FFMPEG_WAIT_TIMEOUT_MS` / `BACKUP_RETAIN` / `BACKUP_MAX_BYTES` | ✅ 全可选 | 均有安全默认值，不配置时行为等价于优化前 |
| `DetectionEngine` 新增 `budget` / `onSnapshot` 选项 | ✅ 可选注入 | 默认取全局单例；不传即工作 |
| `RecordingCaptureManager` / `SharedSourceHub` / `StreamManager` 新增 `budget` 选项 | ✅ 可选注入 | 同上 |
| `store.setAlarmSnapshot()` | ✅ 新增方法 | 不影响既有方法签名 |
| `pruneRecordingSegments({ includeProtected })` | ✅ 默认值不变 | 默认仍跳过保护段；只有显式传 `true` 才允许淘汰 |

---

## 七、验证结果

| 项目 | 结果 |
|------|------|
| `npm test` | **184 / 184 通过**（82.6 s） |
| `npm run build`（`tsc --noEmit && vite build`） | ✅ 通过，79 modules，3.41 s |
| `npm run e2e` | ✅ **23 / 23 通过** |
| `node scripts/contrast-scan.mjs` | ✅ **0 处不达标**（含新增 `.admin-hint` 所在的 admin-audit 页） |
| `git diff --check` | ✅ 无空白错误 |
| `node --check` 全部改动后端文件 | ✅ 语法通过 |

### 新增测试覆盖（41 条）

| 文件 | 条数 | 覆盖点 |
|------|------|------|
| `server/sanitize.test.mjs` | 50 | 凭据抹除（含密码含 `@`） |
| `server/process-safety.test.mjs` | 102 | 未捕获异常治理 |
| `server/backup-guard.test.mjs` | 106 | 备份完整性与轮转 |
| `server/detection-status.test.mjs` | 94 | 状态脱敏与站点过滤 |
| `server/ffmpeg-budget.test.mjs` | 160 | 预算排队/幂等/超时 |
| `server/perf-index.test.mjs` | 350 | V9 索引迁移 + 审计清理 + 时间窗 |
| `server/detection-snapshot.test.mjs` | 178 | 告警先落库 |

---

## 八、遗留事项（外部待办，不在代码范围）

1. **GitHub 推送**：按用户指示暂缓，未执行任何 push。
2. **watchdog / 真机验收**：需在真实部署环境验证 —— 多路点位下的 FFmpeg 预算排队表现、备份轮转、磁盘水位清理。
3. **本地数据命令**：按约定仅校验不执行（`npm run reset-password` / `npm run nvr:probe` 等未对真实数据运行）。
4. **生产配置建议**：`FFMPEG_MAX_PROCESSES` 应按实际 CPU 核数与点位规模设定（默认值 8 适合约 8 路并发抽帧）；`BACKUP_MAX_BYTES` 建议显式设置，否则备份目录只受份数约束。

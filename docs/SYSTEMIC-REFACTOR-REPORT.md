# 第五轮：系统性深度解构、重构与优化报告

> 基线 `npm test` 213/213 → 本轮 **229/229**（+16 条新测试）。
> 全量验证：build 通过、e2e 23/23、浅色对比度 0 违规（含新增动态状态场景）、`git diff --check` 无空白错误。

---

## 一、系统解构：现状与依赖

### 1.1 规模与分层

| 层 | 代表模块 | 行数 |
|---|---|---|
| 装配层 | `server/index.mjs` | 1977 |
| 数据层 | `server/schema.mjs` / `store.mjs` / `store/methods/*` | 898 / 472 / 若干 |
| 接口层 | `server/routes/*.mjs`（11 个） | 745（cameras）等 |
| 领域层 | `server/auth/*`、`http/*`、`detection-engine.mjs` | 925（检测引擎） |
| 前端 | `src/App.tsx` / `AdminPanel.tsx` / `CamerasTab.tsx` / `lib/api.ts` / `styles/app.css` | 844 / 1724 / 1295 / 941 / 4938 |

**依赖方向**：`config/auth`（无依赖）→ `store`（node:sqlite）→ `http`（express 中间件）→ `routes` → `index.mjs` 装配。前端 `api.ts` 是唯一 HTTP 出口，`useAlarms` / `AuthContext` / `AdminPanel` 是三处状态源。

### 1.2 数据流关键链路

- **告警**：FFmpeg 帧 → `detection-engine` → `store.createAlarm` → `broadcastEvent`（SSE，按 userId 实时查权限）→ 前端 `useAlarms.upsertAlarm`
- **录像**：`recording-capture` 写 `.ts` → 每 5 分钟 `reconcileRecordingSegments` 全量对账 → `recording_segments` 索引 → 时间线/回放
- **配置**：`process.env` 在 **30+ 处**以 5 种不同写法解析 → 各 manager 构造参数
- **状态**：`metrics`（内存）、`sseClients`（内存）、`mediaUsageCache`（5 分钟 TTL）、`meta` 表（持久化）

---

## 二、定位的问题与取舍

四路并行只读审计（前端 UI/交互、后端配置/协议、识别容错/工具边界、性能/可靠性）共提出约 60 条。我逐条复核，**剔除 8 条误判**（详见 §六），最终落地 5 个批次。

### 已确认的原生缺陷

| 类别 | 问题 | 证据 |
|---|---|---|
| **安全** | IPv4-mapped IPv6 的**十六进制形式**绕过云元数据拦截 | `new URL('http://[::ffff:169.254.169.254]/')` → hostname `[::ffff:a9fe:a9fe]`，`mappedIpv4()` 只认点分十进制 → 放行。上一轮修复的残留变体 |
| **配置** | `0` 被 `Number(x)\|\|default` 吞掉 | `MEDIA_MAX_BYTES=0`→2GB、`NOTIFY_MAX_FAILURES=0`→5，README 承诺的「0 关闭」是死代码 |
| **配置** | 负数/NaN 静默生效 | `ALARM_RETENTION_DAYS=-5` → cutoff 算到未来 5 天 → **删光全库告警**；`OFFLINE_TIMEOUT_MS=-1` → 全点位误报 |
| **配置** | 同一变量多处解析口径不同 | `MAX_CONCURRENT_STREAMS=abc` → StreamManager 得 `NaN`（并发上限失效）、Playback 得 8 |
| **配置** | 文档变量名拼错 | README/DELIVERY 写 `RECORDING_SHARE_SOURCE`，代码读 `RECORDING_SHARED_SOURCE` |
| **UI** | 浅色主题 Toast / 错误条不可读 | `.toast` 深底 + `var(--text)`（浅色为深字）；`.admin-error` `#ffb7b0` 落近白底 |
| **UI** | 告警处置按钮双击重复提交 | `App.tsx` 四个 async handler 无 in-flight 守卫 |
| **UI** | SSE 断线无感知 | `sse.ts` 已实现 `onDisconnect`，但全前端无消费 |
| **可视化** | 图表数字无兜底、口径不一致 | `Math.max(1, ...days.map(d=>d.total))` 遇 NaN → 整图消失；`total` 含 `camera_abnormal` 但柱高只算 3 类 |
| **性能** | 录像对账每 5 分钟全量 upsert | 2 万段实测 **366ms**、5 万段约 3.3s 事件循环冻结 |
| **性能** | SSE 广播 N+1 查库 | 每个 client 查 `getUser` + `siteMemberSiteIds`，500 clients 实测 25ms |
| **性能** | 审计 action 筛选 COUNT 全表扫描 | 10 万行 13.8ms |
| **可靠性** | async 定时任务无重叠保护；8 个首次定时器未清理 | 磁盘卡慢时可并发删除；停机窗口仍触发 |
| **可靠性** | 每日摘要「0 投递」仍标记已发 | `.then` 无条件写 `daily_summary_last` |
| **协议** | 错误响应体两种形态 | `requireAuth` 返回 `{error}`，`requireCapability` 返回 `{error, code}` |
| **协议** | 同名 `days` 字段语义冲突 | `/false-hotspots` 返回数字，`/stats` 返回数组 |
| **协议** | `recordingsExport` 旁路缺 401 广播与超时 | 会话过期只弹「请求失败（401）」 |

---

## 三、改动范围与关键变更

### 批次 A — 安全 + 配置健壮性

| 文件 | 变更 |
|---|---|
| `server/net-guard.mjs` | `mappedIpv4()` 同时支持点分十进制与 **WHATWG URL 规范化后的十六进制**形式；解析出的 IPv4 参与完整判定（元数据/链路本地/环回/私网） |
| `server/config.mjs` **新增** | `envNumber` / `envBoolean` / `normalizePort` / `normalizeClock` 四个解析器（单一来源）。非法值回退默认并写 `config_invalid` warn；负数钳下界；`0` 由 `allowZero` 显式声明；默认**保留小数**（兼容 `ESCALATION_MINUTES=0.01` 的既有测试契约） |
| `server/index.mjs` | 30+ 处散落解析收敛到 `config.mjs`；共享 `maxConcurrentStreams`/`detectionWidth|Height|Fps` 只解析一次；`--port` 优先于环境变量 + 端口合法性校验；`DAILY_SUMMARY_AT` 格式校验但保留空串=关闭语义 |
| `server/streams.mjs` | `Math.max(NaN,1)` 传播修复 |
| `server/notify.mjs` | `NOTIFY_MAX_FAILURES=0` 生效 |
| `server/recording-config.mjs` | 保护窗口与 `detection-engine` 的 2-60 秒钳制对齐（旧值 9999 会把保护窗口放大 168 倍） |
| `README.md` / `DELIVERY.md` | 修正 `RECORDING_SHARED_SOURCE` 拼写；补齐 12 项环境变量；新增配置健壮性说明 |

### 批次 B — UI 视觉层级与交互反馈

| 文件 | 变更 |
|---|---|
| `src/styles/app.css` | 新增 `--control-h/--control-radius/--control-font` 令牌；4 处工具栏控件（26/30/30/31px、7/8/8/7px、10.5/11.5/11/11.5px）统一到 `31px/8px/11.5px`（登录页 38px 保留为独立层级）；浅色主题补 `.toast` / `.toast--danger` / `.toast--ok` / `.admin-error` 覆盖；删除同作用域冲突的 `.nav-tab.is-active` 重复规则；新增 `.pill--warn`、`.stats-bar--*` 语义色 |
| `src/App.tsx` | `pendingAlarms` Set + `withAlarmLock` 按告警 ID 防重入，覆盖确认/误报/步骤/归档四个 handler |
| `src/hooks/useAlarms.ts` | 新增 `sseDown` 状态并消费 `onDisconnect`；`refresh()` 用 `sameAlarms` 复用数组引用；断线期轮询从 3s 降为 15s |
| `src/components/TopBar.tsx` | 新增「实时推送中断 · 重连中」徽标 |
| `src/components/AdminPanel.tsx` | `switchTab()` 统一清理跨 Tab 残留错误；5s health 轮询用 `tabRef` 限制在 cameras Tab；`formatBytes` 改为 re-export |
| `src/components/StatsChart.tsx` | 数字 `safe()` 兜底（NaN/负数）；`max` 改用三类上色之和与柱高口径对齐；SVG `fill` 属性改 CSS 变量；空态「暂无数据」；X 轴标签按 42px 最小间距自适应 |
| `src/lib/format.ts` | 新增全项目唯一 `formatBytes`（含 NaN/负数防护） |
| `scripts/contrast-scan.mjs` | SVG 元素改用 `getBoundingClientRect` 判可见；新增 `feedback-states` 场景注入三种 Toast + 错误条 + 断线徽标后扫描 |

### 批次 C — 性能与可靠性

| 文件 | 变更 |
|---|---|
| `server/store/methods/recordings.mjs` | 新增 `allRecordingSegmentSnapshot()` 返回对比键 |
| `server/recording-index.mjs` | **增量对账**：只把新增/字段变化段交给 upsert（无 snapshot 方法的旧调用方自动退回全量）；段目录 `fsp.stat` 串行改按天并发 |
| `server/store.mjs` + `methods/users.mjs` + `methods/sites.mjs` | 新增 `authRevision` 权限修订号，所有账号/站点授权写入递增 |
| `server/index.mjs` | SSE 广播按 `修订号 + userId` 缓存，消除 N+1（修订号变化即整表失效，撤权实时性不变）；`startupTimers` 收集 6 个首次定时器并在 shutdown/startup-failed 两处清理；`withInFlight` 保护 4 个 async 定时任务；每日摘要仅 `sent>0` 写已发标记；`rotate()` 补 `.catch` |
| `server/schema.mjs` | `PERFORMANCE_INDEXES_DDL` 补 5 条索引（审计 action+created_at、删号孤儿列），走幂等 `ensurePerformanceIndexes()`，**无需递增 schema 版本** |

**实测收益**（本机 Node 22，真实 `openStore`）：

| 项目 | 改造前 | 改造后 |
|---|---|---|
| 录像对账 2 万段（无变化） | 366.1 ms | **0.1 ms** |
| 录像对账 2 万段（1 段变化） | 366.1 ms | **1.8 ms** |
| 审计 COUNT（action 前缀，10 万行） | 13.79 ms | **5.51 ms**（覆盖索引） |
| 段目录 stat（2000 文件，审计实测） | 217 ms | 约 32 ms（并发化） |
| SSE 广播 500 clients（审计实测） | 25.07 ms | 约 0.008 ms（按修订号缓存） |

### 批次 D — 协议一致性与容错

| 文件 | 变更 |
|---|---|
| `server/http/guards.mjs` | `requireAuth`/`requireRole`/`requireManager` 统一走 `AuthError.toBody()`，保持既有文案、纯新增 `code` 字段 |
| `server/routes/alarms.mjs` | `/stats` 新增 `series` + `windowDays`，`/false-hotspots` 新增 `windowDays`，**保留 `days` 兼容旧客户端** |
| `src/lib/api.ts` | `recordingsExport` 补 401 广播与 120s 超时 |
| `src/hooks/useAlarms.ts` | `normalizeAlarm()` 在轮询与 SSE 两条入口统一 clamp 置信度/热点坐标到 [0,100]，并归一化 `steps` |
| `src/components/RecordingTimeline.tsx` | 补无点位/加载中/未选日期三种空态引导 |

---

## 四、验收要点

| 维度 | 验收命令 / 方式 | 结果 |
|---|---|---|
| 单元回归 | `npm test` | **229/229**（基线 213，+16） |
| 类型与构建 | `npm run build`（tsc --noEmit + vite build） | 通过，79 modules |
| 端到端 | `npm run e2e` | **23/23** |
| 浅色主题可读性 | `node scripts/contrast-scan.mjs` | 10 个场景 **0 违规**，其中 `feedback-states` 为本轮新增 |
| 代码规范 | `git diff --check` | 无空白错误 |
| SSRF 回归 | `server/net-guard.test.mjs` 新增 2 条 | 12/12，含 5 种 mapped 变体 |
| 配置健壮性 | `server/config.test.mjs` 新增 9 条 | 9/9，覆盖 0 值/负数/NaN/越界/布尔/端口/时刻 |
| 增量对账与权限修订 | `server/runtime-hardening.test.mjs` 新增 5 条 | 5/5 |
| 兼容性 | 既有 213 条测试 + e2e 全部通过 | 接口路径/状态码/响应体/角色语义/数据模型均无破坏 |

### 新增测试（16 条）

- `server/config.test.mjs` — 9 条
- `server/net-guard.test.mjs` — 2 条（另 10 条为既有）
- `server/runtime-hardening.test.mjs` — 5 条

---

## 五、兼容性说明

1. **HTTP 接口**：所有路径、方法、状态码、既有响应字段**不变**；`series`/`windowDays`/`code` 均为纯新增字段。
2. **数据模型**：无表结构变更、无 schema 版本递增；5 条新索引走幂等 `ensurePerformanceIndexes()`，存量库下次启动自动补建。
3. **配置项**：默认值与合法取值**完全不变**；仅非法值从「静默生效」改为「回退默认 + warn 日志」。唯一例外是 `--port` 现在优先于 `PORT` 环境变量（脚本显式传参不应被宿主环境覆盖）。
4. **角色与权限**：能力矩阵未改动；`authRevision` 只影响 SSE 缓存失效时机，权限判定本身不变。
5. **前端外观**：深色主题逐值不变；浅色主题修复了原本不可读的 Toast/错误条；工具栏控件统一到一套尺寸；登录页保持 38px 独立层级。

---

## 六、复核中剔除的误判 / 未采纳项

| 结论 | 为何未采纳 |
|---|---|
| 「IPv4-mapped IPv6 绕过」初测 | 我第一次传了 `allowLinkLocal:true`，连普通元数据地址都放行 —— 参数错误。按真实默认参数重测后**确认成立**，改为 P0 修复 |
| 「表单错误提示滚出视野」 | `.admin-error` 在 `.admin-body`（唯一滚动容器）之外常驻顶部，不成立；真实问题是跨 Tab 残留 |
| 「录像时间轴刻度错位」 | `recording-index.mjs` 原样回传 `from/to`，刻度与块定位同源，不成立 |
| 「硬编码颜色 = 浅色不可读」 | 约 390 处字面颜色多为背景/边框/阴影；只有 Toast 与 `.admin-error` 经 computed 值确认冲突，其余按数量下结论会误伤 |
| 「69 个重复选择器」 | 60+ 在 `@media` 响应式块内，属正常覆盖；只有 `.nav-tab.is-active` 一处同作用域冲突（已删） |
| 「alarmStatsBetween 215ms」 | 审计用 400 天人工窗口构造；真实每日摘要是 24h 窗口，实测 0.3ms |
| 「目录扫描未并发化」与已做优化重叠 | 确认 `index.mjs:scanMediaDir` 已并发，但 `recording-index.mjs` 是**另一段**串行代码，已单独修复 |
| 「V9 部分索引未命中」 | 数据分布/ANALYZE 时机差异，实测 0.30ms 无影响，未改 |
| 「帧 Buffer.concat 是瓶颈」 | 折算默认 160×90@1fps×24 路仅 1.7ms/秒 CPU，属设计权衡 |
| 「S1/S5/S7 effect 依赖问题」 | 当前实现自洽，改动反而引入不必要重构 |

### 未执行（需产品决策或真机环境）

- P7 自定义角色表 / P8 MFA / P9 限流持久化 / P10 权限审计增强 / P11 前端权限模型同步
- 识别阈值调优（夜间低照度、红色物体误报抑制、ROI 缩放映射）—— 需真机素材实测，贸然调阈值会把准确率调坏
- 分批事务改造 `importCameras`、预聚合日表、通知多渠道归并查询（有实测收益但改动面较大，留待下一轮）
- GitHub 推送、真机/watchdog 验收（沿用既有约定）

---

## 七、风险与注意事项

1. **KDF 参数升级**：本轮未改 `SCRYPT_PARAMS`；若将来调整，必须保留 `LEGACY_SCRYPT_PARAMS`（N=2¹⁴）与旧格式解析，否则存量用户集体无法登录。
2. **能力矩阵**：`roles.test.mjs` 锁定了与改造前 `requireRole`/`requireManager` 的逐用户等价性；任何矩阵调整必须同步更新该测试。
3. **SSE 缓存**：`authRevision` 是进程内计数，项目本就要求单实例（`data/instance.lock`）；若未来水平扩展，需改为共享存储的版本号。
4. **对比度扫描**：新增的 `feedback-states` 通过注入 DOM 覆盖动态状态，但仍未覆盖深色主题、hover/focus/disabled 态与 1440×900 以外视口。
5. **配置项小数语义**：`envNumber` 默认保留小数以兼容快速验证；新增「条数/毫秒」类配置若需整数，应显式传 `integer: true`。

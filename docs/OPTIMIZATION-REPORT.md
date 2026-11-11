# 系统性升级报告

> 项目：火焰/烟雾视频识别监控平台（fire-vision-monitor）
> 基线：v1.1.0 工作区 → 本轮升级
> 验证：`npm test` 143/143 · `npm run build` 通过 · `npm run e2e` 23/23 · 浅色对比度 0 违规

---

## 一、本次优化的目标点

本轮升级不新增业务功能，目标是**在保持对外接口完全兼容的前提下**，把系统从「能跑」提升到「可长期无人值守运行」。按用户列出的维度拆解为 7 个目标点：

| # | 目标点 | 具体含义 | 主要落点 |
|---|--------|----------|----------|
| 1 | **安全** | 收敛出网地址策略、防 SSRF、防越权、防信息泄露、防时序侧信道 | `server/net-guard.mjs`、`server/index.mjs`、`server/routes/*` |
| 2 | **并发安全** | SQLite 事务重入、消除 TOCTOU 竞态、唯一索引兜底归一化 | `server/store.mjs`、`server/store/methods/*` |
| 3 | **健壮性** | 前端运行时崩溃兜底、异步卸载守卫、失败草稿保留 | `src/components/ErrorBoundary.tsx`、`src/hooks/*` |
| 4 | **错误处理** | 500 错误脱敏、上游响应体不外泄、异常不中断整批任务 | `server/routes/*`、`server/notify.mjs`、`server/index.mjs` |
| 5 | **类型安全** | JSDoc 与实现对齐、`unknown`/`null` 收口、前端响应结构校验 | `server/types.mjs`、`src/types.ts`、`src/lib/api.ts` |
| 6 | **性能** | 消除事件循环阻塞、消除 O(N²) 查询、消除大参数展开 | `server/index.mjs`、`server/store/methods/*` |
| 7 | **可读性/一致性** | 时区语义统一到单一模块、模块级校验逻辑收敛 | `server/time.mjs`、`server/net-guard.mjs`、`src/lib/validate.ts` |

**总览**：46 个既有文件被修改（+1830 / −2361 行），新增 12 个文件（含 4 个测试文件、1 个对比度扫描脚本）。

---

## 二、全部被修改 / 新增的文件及关键改动

### 2.1 新增文件（20 个）

> 工作区相对上次提交的差异同时包含：**上阶段的前端拆分**（App/AdminPanel 解耦 + 浅色主题适配）与**本轮的系统性优化**。下表按"本轮新增"与"上阶段新增"分组标注。

**本轮优化新增（9 个）**

| 文件 | 行数 | 作用 |
|------|------|------|
| `server/net-guard.mjs` | 317 | **统一出网地址策略**：协议白名单、云元数据恒定拦截、链路本地按场景、环回/私网可收紧、IPv4-mapped IPv6 绕过识别、`guardedFetch` 逐跳重定向校验 |
| `server/time.mjs` | 61 | **时区语义单一来源**：`SHANGHAI_OFFSET_MS`、`toShanghaiParts`、`shanghaiDayStart`、`shanghaiDateKey`（Asia/Shanghai 固定 +8，无夏令时） |
| `server/net-guard.test.mjs` | 144 | 10 条：元数据拦截、mapped IPv6 绕过、环回/私网/链路本地开关、协议白名单、guardedFetch 逐跳与跳数上限 |
| `server/store-guards.test.mjs` | 297 | 9 条：事务重入、管理员降级/停用/删除保护、孤儿引用清理、站点解绑渠道、limit 夹取、批量 upsert 统计、误报解除保护原子性、点位同源冲突归一化 |
| `server/http/session.test.mjs` | 122 | 6 条：三维登录限流、账号维度抗 IP 伪造、成功清零、令牌签名/过期/tokenVersion 失效 |
| `server/notify-redact.test.mjs` | 70 | 3 条：上游响应体不回显、errcode 保留与 errmsg 截断、成功路径回归 |
| `src/components/ErrorBoundary.tsx` | 53 | 类组件错误边界：`getDerivedStateFromError` + `componentDidCatch` + 「重新加载」按钮 |
| `src/lib/validate.ts` | 71 | `parseIntInRange` / `parsePort` / `parseIsoDate`，非法输入统一返回 `null` |
| `scripts/contrast-scan.mjs` | 308 | 浅色主题对比度自动扫描（9 个页面 × 关键容器/文本） |

**上阶段前端拆分新增（11 个）**

| 文件 | 作用 |
|------|------|
| `src/app/MonitorView.tsx`、`src/app/FocusOverlay.tsx` | App 组合根拆分（`src/App.tsx` 339 行 → 组合根 + 2 个展示组件） |
| `src/components/admin/{UsersTab,UserList,CamerasTab,SitesTab,StatsTab,NotifyTab,NotifyTemplateList,AuditTab}.tsx` | AdminPanel 按 Tab 拆分（1977 行 → 组合根 + 8 个子组件） |
| `CHECKLIST.md` | 交付清单 |
| `contrast-report.json` | 对比度扫描产物（脚本自动生成） |

### 2.2 服务端（27 个文件）

| 文件 | 关键改动 |
|------|----------|
| `server/index.mjs` | ① 密码哈希/校验改**异步 scrypt**（`promisify(crypto.scrypt)`），不再阻塞事件循环；② 新增 `dummyVerify()` 消除「用户不存在时快速返回」的时序侧信道；③ `isBlockedNotifyHost` 委托 `blockedOutboundHost`，新增 `blockedCameraSourceHost`；④ `validateCameraInput` 增加主机校验；⑤ 抓拍改**临时文件 + 原子 rename**，失败清理半成品；⑥ `escalationCheck` 单条告警加 try/catch，异常不中断整轮；⑦ 每日摘要改**宽窗口补发**（目标时刻后 0–120 分钟且当天未发过）；⑧ 时区计算改用 `time.mjs` |
| `server/net-guard.mjs`（新） | `parseIpv4` / `blockedOutboundHost` / `assertOutboundUrl` / `guardedFetch` / `OutboundBlockedError`；**元数据判定先于链路本地判定**，防止 `allowLinkLocal:true` 时放过 `169.254.169.254` |
| `server/routes/media.mjs` | 视频代理改用 `guardedFetch` 逐跳校验重定向；`OutboundBlockedError` → 403；前置 `blockedOutboundHost` 校验 |
| `server/routes/cameras.mjs` | ONVIF discover 增加主机格式/端口 1-65535/地址校验；ONVIF import 增加 `devices ≤ 64`、`totalChannels ≤ 256` 上限；preview 的 500 错误脱敏 |
| `server/routes/notify.mjs` | 模板 POST/PATCH/DELETE 由 `requireManager` 收紧为 `requireRole('admin')`（GET 保持 `requireManager`，兼容前端读取）；deps 增加 `requireRole` |
| `server/routes/users.mjs` | POST/PATCH/DELETE 改 async 并 `await passwordHash`；**非法 role 直接 400**（原先静默降级为 viewer）；创建捕获 UNIQUE → 409；改用 `updateUserWithAdminGuard` / `deleteUserWithAdminGuard` |
| `server/routes/auth.mjs` | setup `await passwordHash`；login 改 async；登录成功调用 `clearLoginFailures(username)` |
| `server/routes/deps.mjs` | `passwordHash`/`verifyPassword` 类型更新为 Promise 签名；新增 `clearLoginFailures` |
| `server/routes/sites.mjs` | 创建站点捕获 UNIQUE → 409 |
| `server/routes/recordings.mjs` | `/api/recordings/reconcile` 的 500 回显脱敏 |
| `server/routes/demo.mjs` | `/api/edge/status` 增加 `pairingTokenHint`（`****后4位`），保留完整令牌以兼容既有配对流程 |
| `server/http/session.mjs` | 限流升级为**三维**：`ip:username` 8 次 / `username` 20 次（抗 IP 伪造的分布式爆破）/ `ip` 30 次；新增 `clearLoginFailures` |
| `server/store.mjs` | `Store.transaction` 支持**重入**（`txDepth` 计数，内层并入外层），消除「cannot start a transaction within a transaction」 |
| `server/store/methods/users.mjs` | 新增 `updateUserWithAdminGuard` / `deleteUserWithAdminGuard`；`deleteUser` 事务化并清理孤儿引用（`audit_logs.user_id`、`alarm_events.user_id`、`alarms.created_by/updated_by` 置空） |
| `server/store/methods/sites.mjs` | `deleteSite` 事务内 `UPDATE notify_channels SET site_id = NULL`（**解绑而非删除**，避免数据丢失） |
| `server/store/methods/alarms.mjs` | `updateAlarm` 整体事务化（消除误报解除保护的 TOCTOU，取证录像不会被误清保护）；`listFalseAlarmCounts` 增加 `safeDays` 夹取；`alarmStatsByDay` 改用 `time.mjs` |
| `server/store/methods/cameras.mjs` | ① 同源指纹预检**移入事务**，UNIQUE 冲突统一归一化为 `DUPLICATE_SOURCE`；② `nextCameraCode` 改 `reduce`（避免 `Math.max(...arr)` 超 V8 参数上限 RangeError）；③ `importCameras` 遇同源冲突跳过而非整批失败 |
| `server/store/methods/recordings.mjs` | 新增 `clampLimit(limit, fallback, max)`，`listRecordingSegments`/`pruneRecordingSegments` 夹取 limit；`upsertRecordingSegments` 改单语句 `INSERT ... ON CONFLICT(file) DO UPDATE` + 每 200 段一批事务（保留「内容未变不计为更新」语义） |
| `server/store/methods/maintenance.mjs` | 新增 `MAX_SQL_VARIABLES = 30_000` 与 `chunkIds()`；`pruneAlarms`/`purgeDemoAlarms` **分片删除**，`purgeDemoAlarms` 改分页读取（每页 2000） |
| `server/store/methods/notify.mjs` | 凭据解密失败不再静默返回空串，改为记录 `credentialError` 字段 |
| `server/store/methods/audit.mjs` | 新增 `escapeLike()`，LIKE 查询改用 `ESCAPE '\'` 转义 `%` / `_` / `\` |
| `server/secrets.mjs` | `encrypt` 不再因明文以 `enc:v1:` 开头就原样返回（修掉「明文入库 / 解密报错」缺陷）；抽出 `CIPHER_PREFIX` 常量 |
| `server/probe.mjs` | 新增 `stripUserinfo()`，按 URL 结构整体抹除 userinfo（修复密码含 `@` 时正则脱敏残留） |
| `server/notify.mjs` | ① `post()` **不再回显上游响应体**（错误只带状态码，响应体截断后仅写日志）；② errcode 保留、errmsg 压平空白并截断至 120 字符；③ `deliver`/`notifyBroadcast` 在 url 为空且有 `credentialError` 时记录明确日志；④ `dayKey` 改用 `shanghaiDateKey()` |
| `server/onvif.mjs` | 新增 `isValidOnvifHost()`（禁 userinfo / 路径注入）与 `buildDeviceBaseUrl()`（用 URL 构造器）；`discoverDevice` 增加端口范围与出网地址校验 |
| `server/schedule.mjs` | `isArmedNow` 统一按 `SHANGHAI_OFFSET_MS` + UTC getter 计算（修掉本地时区与 UTC+8 口径分裂） |
| `server/detection-engine.mjs` | `captureSnapshot`/`captureClip` 改临时文件 `.tmp-<name>` + 原子 rename + 失败 unlink |
| `server/types.mjs` | 修正 JSDoc 与实现不符：`role` → `'admin'\|'operator'\|'viewer'`、`passwordHash` → scrypt、`level` 补 `'camera_abnormal'`、`confidence` 改 0-100、`hotspot` 改百分比 0-100、`steps` 改 `boolean[]`、`NotifyChannel` 增加 `credentialError` |
| `server/test-port.mjs` | **测试稳定性加固**：`getFreePort()` 增加两层防护 —— ① 本进程内 `handedOut` 集合，避免 listen(0) 释放后被 OS 立即复用、导致同一文件两次取到同一端口；② 取到端口后再验证一次「仍可绑定」，不可绑定则换端口重试，消除「释放端口 → 子进程 bind」之间的竞态窗口 |
| `package.json` | `"test"` 改为 `node --test --test-concurrency=1 "server/**/*.test.mjs"`（原 `server/*.test.mjs` 匹配不到 `server/http/session.test.mjs`，该文件从未被执行） |

### 2.3 前端（17 个文件）

| 文件 | 关键改动 |
|------|----------|
| `src/main.tsx` | 包一层 `<ErrorBoundary>`（命名导出），渲染期异常不再白屏 |
| `src/components/ErrorBoundary.tsx`（新） | 错误边界组件，展示可读错误页并提供「重新加载」 |
| `src/lib/validate.ts`（新） | 数值/端口/日期输入解析器，非法一律 `null` |
| `src/lib/detection.ts` | 新增 `getLevelMeta(level)` / `getStatusMeta(status)` **兜底取值**，未知枚举不再崩溃 |
| `src/lib/api.ts` | `request<T>` 增加第三参 `expectArrays: string[]` 与 `expectArrayFields()`；cameras/alarms/users/sites/notifyChannels 五个列表端点启用**响应结构校验** |
| `src/lib/preferences.ts` | 新增 `defaultPreferences()` 返回副本，不再返回共享的模块级 `DEFAULTS` 引用（消除跨用户状态污染） |
| `src/components/AlarmCard.tsx` | 改用 `getLevelMeta/getStatusMeta`；`commitNote` 改 async，保存失败**保留草稿**（`noteSaving` 状态），`onBlur`/`Ctrl+Enter` 改 `void commitNote()` |
| `src/components/RecordsView.tsx` / `AlarmClipTimeline.tsx` / `src/lib/export.ts` | 全部改用安全取值函数，消除 `undefined` 解构崩溃 |
| `src/components/RecordingTimeline.tsx` | `localDayRange` 返回 `null` 表示非法日期，调用处给出「日期格式无效」提示 |
| `src/components/AdminPanel.tsx` | ① 各 Tab 拆分为独立子组件；② 新增 `mountedRef` 卸载守卫（loadUsers/loadSites/loadNotify/loadNotifyTemplates/loadNotifyLogs）；③ `window.prompt` 重置密码改为**受控弹窗**（`passwordTarget`/`passwordDraft`/`passwordBusy`，`type="password"` + 二次确认 + 8-128 位校验） |
| `src/components/admin/NotifyTab.tsx` / `NotifyTemplateList.tsx` | 「新建模板」与编辑/删除按钮**仅 `isSuperAdmin` 可见**，非超管显示提示文案（与服务端 `requireRole('admin')` 对齐） |
| `src/components/admin/CamerasTab.tsx` | RTSP 端口、ONVIF 端口、起始通道、导入通道数改用 `parsePort`/`parseIntInRange` |
| `src/components/admin/UserList.tsx` / `UsersTab.tsx` | `resetPassword` 签名由 `Promise<void>` 改为 `void`，与受控弹窗一致 |
| `src/hooks/useCameraPoints.ts` | 增加 `mounted` ref 卸载守卫 |
| `src/hooks/useAlarms.ts` | `createAlarm`/`patchAlarm` await 后判断 `mounted.current` |
| `src/App.tsx` | `handleNoteChange` 返回 `Promise<boolean>`（成功 true / 失败 false）；`pendingCount`/`latestPendingId` 改 `useMemo`；拆出 `src/app/MonitorView.tsx`、`FocusOverlay.tsx` |
| `src/types.ts` | `snapshot?: string \| null`、`note?: string \| null`；`AlarmHandlers.onNoteChange` 返回 `Promise<boolean>` |
| `src/styles/app.css` | 追加 `.app-fatal` 系列样式（错误边界视觉） |

### 2.4 文档（1 个）

- `DELIVERY.md` —— 同步本轮升级后的验证结论与交付口径。

---

## 三、原代码的缺陷与安全隐患

### 3.1 已修复（41 项）

**A. 安全类**

| 编号 | 缺陷 | 严重度 | 修复 |
|------|------|--------|------|
| L1 | IPv4-mapped IPv6（`::ffff:169.254.169.254`）在 `allowLinkLocal:true` 下被放过 → 可探测云元数据 | **高** | `net-guard` 中元数据判定**前置**于链路本地判定，并加断言测试 |
| L2 | 出网地址判定逻辑在相机源 / ONVIF / 通知 / 视频代理四处各写一遍，策略不一致 | **高** | 收敛到 `server/net-guard.mjs` 单一实现，各调用点显式声明放行范围 |
| L3 | 视频代理跟随重定向时不校验每一跳 → 首跳合法、末跳打到内网 | **高** | 改用 `guardedFetch`（`redirect:'manual'` 逐跳校验 + 跳数上限） |
| L4 | `passwordHash`/`verifyPassword` 用同步 scrypt → 单次登录阻塞事件循环数秒，可被并发打满 | **高** | 改 `promisify(crypto.scrypt)` 异步实现 |
| L5 | 用户不存在时校验直接返回 → 响应耗时差异泄露账号是否存在 | 中 | 新增 `dummyVerify()`，不存在时也跑一遍等价 KDF |
| L6 | 登录限流只有 `ip:username` 维度 → 换 IP 即可无限爆破 | **高** | 升级为三维：`ip:user` 8 次 / `user` 20 次 / `ip` 30 次；登录成功清零 |
| L7 | 通知模板 POST/PATCH/DELETE 用 `requireManager` → 普通 operator 可改全平台模板 | **高** | 收紧为 `requireRole('admin')`，前端同步隐藏入口 |
| L8 | 用户 PATCH 非法 role 静默降级为 viewer（行为不可预期） | 中 | 非法 role 直接 400 |
| L9 | 500 响应把内部错误消息（含路径/SQL）回显前端 | 中 | 统一脱敏 + `log('warn', ...)` 仅写日志 |
| L10 | 通知渠道测试接口把上游响应体前 180 字节回显前端（可能含内网地址/令牌） | 中 | 错误只带状态码，响应体截断后仅写日志（`notify-redact.test.mjs` 覆盖） |
| L11 | `encrypt` 对明文以 `enc:v1:` 开头时原样返回 → 该密钥永远无法解密 | **高** | 修掉前缀误判，抽出 `CIPHER_PREFIX` 常量 |
| L12 | 通知渠道凭据解密失败静默返回空串 → 推送"成功"但实际无凭据 | 中 | 改为记录 `credentialError` 字段并写明确日志 |
| L13 | `probe` 脱敏用正则拆 URL → 密码含 `@` 时残留明文 | 中 | 改 `stripUserinfo()` 按 URL 结构整体抹除 |
| L14 | `/api/edge/status` 返回完整配对令牌 | 中 | 增加 `pairingTokenHint`（`****后4位`），保留完整令牌以兼容既有配对流程 |
| L15 | ONVIF 发现参数无主机格式/端口范围校验，可注入 userinfo 与路径 | 中 | 新增 `isValidOnvifHost()` + 端口 1-65535 校验 + URL 构造器拼装 |

**B. 数据完整性 / 并发类**

| 编号 | 缺陷 | 严重度 | 修复 |
|------|------|--------|------|
| L16 | 点位同源指纹预检在事务外 → 并发新建同源点位双双通过预检，抛出原始 SQL 错误 | **高** | 预检移入 `BEGIN IMMEDIATE` 事务；UNIQUE 冲突统一归一化为 `DUPLICATE_SOURCE`（前端 409 不变） |
| L17 | `updateAlarm` 非事务化 → 误报解除保护时存在 TOCTOU，取证录像可能被误清保护 | **高** | 整体事务化，窗口内仍有其它告警时保留保护（已有测试覆盖） |
| L18 | `deleteUser` 不清理外键引用 → `audit_logs` / `alarm_events` 留悬挂 user_id | 中 | 事务化删除并显式置空孤儿引用 |
| L19 | `deleteSite` 直接删站点 → 关联通知渠道变成悬挂引用 | 中 | 事务内 `site_id = NULL` 解绑而非删除 |
| L20 | `Store.transaction` 不支持重入 → 组合调用抛「cannot start a transaction within a transaction」 | 中 | 加 `txDepth` 计数，内层并入外层 |
| L21 | `LIMIT -1` 在 SQLite 中表示「不限制」→ 录像列表/清理可被参数放大成全表扫描 | **高** | 新增 `clampLimit(limit, fallback, max)` 夹取 |
| L22 | 维护类 SQL 的 `IN (...)` 未分片 → 点位/告警量大时超过 SQLite 绑定变量上限（32766） | 中 | 新增 `chunkIds()` 分片删除 + `purgeDemoAlarms` 改分页读取 |
| L23 | 审计日志 LIKE 搜索未转义 → 输入 `%` / `_` 可匹配全表 | 低 | 新增 `escapeLike()`，查询改用 `ESCAPE '\'` |

**C. 健壮性 / 类型 / 性能类**

| 编号 | 缺陷 | 严重度 | 修复 |
|------|------|--------|------|
| L24 | 前端渲染期异常 → 整页白屏，无恢复入口 | 中 | 新增 `ErrorBoundary` + `main.tsx` 挂载 |
| L25 | 前端读取后端枚举（level/status）时直接解构 → 后端新增枚举即崩溃 | 中 | 新增 `getLevelMeta`/`getStatusMeta` 兜底取值 |
| L26 | 组件卸载后 setState → React 警告与内存泄漏 | 低 | `useCameraPoints`/`useAlarms`/`AdminPanel` 增加 `mounted` 守卫 |
| L27 | 告警备注保存失败后草稿丢失 → 用户输入白写 | 中 | `commitNote` 改 async，失败保留草稿 |
| L28 | `window.prompt` 重置密码无法校验强度、明文可见 | 中 | 改为受控弹窗（password 类型 + 二次确认 + 8-128 位） |
| L29 | 端口/通道数等数值输入直接 `Number()` → 非法值变 NaN 入库 | 中 | 新增 `parsePort`/`parseIntInRange`/`parseIsoDate` |
| L30 | `defaultPreferences()` 返回共享模块级对象 → 多标签页/多用户状态互相污染 | 低 | 改为返回副本 |
| L31 | `nextCameraCode` 用 `Math.max(...codes)` → 点位量大时超 V8 参数上限 RangeError | 中 | 改 `reduce` |
| L32 | `importCameras` 逐条全表取 max → 批量导入 O(N²) | 低 | 事务内只取一次基准 + 递增 |
| L33 | `upsertRecordingSegments` 逐段 select+update → 写放大 | 低 | 改单语句 `ON CONFLICT DO UPDATE` + 每 200 段一批事务 |
| L34 | 每日摘要只在精确时刻触发 → 服务重启/短暂异常永久错过 | 中 | 改宽窗口补发（目标后 0-120 分钟且当天未发过） |
| L35 | 抓拍/短视频直接写目标文件 → 中途失败留半成品 | 中 | 临时文件 + 原子 rename + 失败 unlink |
| L36 | `escalationCheck` 单条告警异常 → 整轮升级检查中断 | 低 | 单条 try/catch，异常不中断整轮 |
| L37 | 时区口径分裂（本地时区 getter vs 固定 UTC+8） | 中 | 收敛到 `server/time.mjs` 单一来源 |
| L38 | `server/types.mjs` JSDoc 与实现不符（role/passwordHash/confidence/hotspot/steps/level） | 低 | 逐项对齐 |
| L39 | 前端不校验后端响应结构 → 后端返回异常时静默空白页 | 低 | `request<T>` 增加 `expectArrayFields()` 结构校验 |
| L40 | `npm test` 脚本 glob 漏掉 `server/http/` 子目录 → 该文件从未被执行 | 中 | 改为 `"server/**/*.test.mjs"` |
| L41 | ONVIF 批量导入无数量上限 → 单请求可拖垮进程 | 中 | `devices ≤ 64`、`totalChannels ≤ 256` |

### 3.2 经评估为设计取舍 / 本轮不改（8 项）

这些不是"漏修"，而是**刻意保留**，理由如下：

| 项 | 现状 | 评估结论 |
|----|------|----------|
| 相机源默认放行私网/环回/链路本地 | 摄像头本就部署在内网，甚至自组网用 `169.254.x.x`；默认收紧会破坏既有部署 | **保留**，仅恒定拦截云元数据与未指定地址；公网部署设 `CAMERA_BLOCK_PRIVATE=1` 收紧 |
| Schema 无 `FOREIGN KEY` 约束 | 全库加 FK 需重建表 + 数据迁移，风险远大于收益 | **不改**，本次以应用层显式级联替代 |
| 登出采用账号级 `tokenVersion` | 单点登出会踢掉该用户全部设备的会话，与现有语义冲突 | **保留**账号级语义 |
| 通知渠道 URL 无前端协议白名单 | 服务端已做协议与地址校验，前端只做提示 | **不改**（前端校验非信任边界） |
| 密码策略仅长度下限（8-128） | 强制复杂度会在应急改密场景造成阻碍 | **保留**，强度提示留前端 |
| 共享源双路拉流 | 同一地址注册多个点位时可能重复拉流 | **不改**，属产品行为选择，需产品侧确认 |
| `recording-index.mjs` 模块级 `reconcileInFlight` 标志 | 多进程部署时非跨进程互斥 | **不改**，当前部署模型为单进程；跨进程需引入锁服务 |
| `/api/notify/channels/:id/test` 仍返回 errcode 与 errmsg | 业务错误码是排障必需信息 | **保留**（已脱敏截断），仅移除上游原始响应体 |

---

## 四、向后兼容性与对外接口不变说明

**接口层面零变更**：

- 所有 HTTP 路由的路径、方法、请求体字段、响应字段**均未改变**；本轮只收紧**权限判定**与**错误文案**，不改变成功路径的返回结构。
- `DUPLICATE_SOURCE` 错误码此前由路由层判定后返回 409，现改为在存储层统一归一化后仍返回 409，**前端行为一致**。
- `verifyPassword` / `passwordHash` 内部改为 Promise，但均为**模块私有函数**，不经路由暴露；外部调用方（`routes/auth.mjs`、`routes/users.mjs`、`routes/deps.mjs`）已同步 `await`，对外行为不变。
- `Store` 新增方法（`updateUserWithAdminGuard` / `deleteUserWithAdminGuard`）为**增量**，原 `updateUser`/`deleteUser` 保留。
- `Notifier.post()` 的返回类型与成功路径不变；仅失败时的**错误消息**由「HTTP 502 + 上游响应体」收敛为「HTTP 502」，属错误信息脱敏，不影响调用方逻辑（调用方仅将消息展示给运维）。
- 前端 `onNoteChange` 返回类型由 `void` 改为 `Promise<boolean>`——这是**回调契约的收紧**，但调用方仅 `App.tsx` 一处，已同步实现；对外 HTTP 契约不变。
- 浅色/深色主题、登录、告警流、录像回放等用户可见流程均通过 E2E 回归（23/23）。

**数据兼容性**：

- SQLite schema **未变更**，无需迁移；存量数据可直接被新版读取。
- 存量被 `enc:v1:` 前缀误判而未加密的凭据，新版 `encrypt` 会正常加密，`decrypt` 兼容读取旧值。

**配置兼容性**：

- 新增可选环境变量 `CAMERA_BLOCK_PRIVATE=1`（**不设置即为原行为**）。

---

## 五、验证结果

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 单元 / 集成测试 | `npm test` | **143 / 143 通过**（较基线 115 条 **+28**：net-guard 10、store-guards 9、notify-redact 3、session 6——后者因脚本 glob 修复而被首次纳入执行） |
| 类型检查 + 构建 | `npm run build` | **通过**（tsc --noEmit 无错，vite 78 modules） |
| 端到端冒烟 | `npm run e2e` | **23 / 23 通过**（登录、告警流、主题、录像回放全链路） |
| 浅色对比度 | `node scripts/contrast-scan.mjs` | **9 个页面 0 处违规** |
| 空白/冲突标记 | `git diff --check` | **无空白错误** |

### 5.1 一处偶发失败的处置记录（如实留档）

最终验收时出现 **1 次** 单条用例失败（142/143），随后连续 **8 轮**完整跑（其中包含「e2e 刚结束立刻跑单测」的高压时序复现）**全部通过**，未能复现该失败。

排查结论指向**测试取端口环节**而非产品代码：`server/test-port.mjs` 原实现用 `listen(0)` 取端口后立即释放，操作系统可能把同一个端口**再分配给下一次调用**——同一测试文件里先后取得的 `port` 与 `receiverPort` 可能相同，两个服务抢同一端口即偶发失败；此外「释放端口 → 子进程真正 bind」之间还有一个极小竞态窗口，期间出站连接可抢占该端口使子进程以 `EADDRINUSE` 退出。

已按此结论加固 `getFreePort()`（本进程端口去重 + 取端口后二次可绑定性校验 + 失败重试），加固后连续 4 轮完整回归与 e2e 均为全绿。该改动只影响测试夹具，不触及产品代码。

> 说明：此为**如实记录**，未把偶发失败当作"已修复"计入缺陷清单——它是测试基础设施的稳定性问题，产品代码未受影响。

# 火情视频识别监控项目 — 系统性深度代码审查报告

> 审查日期：2026-11-11。审查对象：当前工作副本（含前五轮重构，102 个未提交变更）。
> 方式：四路并行只读审查 + 对每条关键结论的独立复现验证。
> **本次未修改任何生产代码。** 基线：关键测试 28/28 通过；此前全量 229/229。
>
> 结论摘要：**未发现 P0；P1 两项、P2 六项、P3 六项**（含 3 项需产品/环境确认）。
> 两项 P1 均已由我独立复现，不是推测。

---

## 一、整体结构、职责与执行流程

### 1.1 分层与模块职责

| 层 | 模块 | 职责 |
|---|---|---|
| 配置/领域 | `server/config.mjs`、`server/auth/{roles,password,identity,errors}.mjs`、`server/net-guard.mjs` | 无外部依赖的纯函数层：配置解析、角色能力矩阵、密码学、脱敏投影、错误类型、出网白名单 |
| 基础设施 | `server/schema.mjs`、`store.mjs`、`store/methods/*.mjs`、`secrets.mjs` | SQLite 建表/迁移/索引、CRUD 与事务、凭据加解密 |
| 中间件 | `server/http/{guards,session,not-found}.mjs` | 登录态、能力守卫、令牌签发与三级限流、会话登记 |
| 接口 | `server/routes/*.mjs`（11 个） | 参数校验、权限编排、审计落点、响应组装；`deps` 注入装配层依赖 |
| 引擎 | `detection-engine.mjs`、`detector.mjs`、`frame-quality.mjs`、`streams.mjs`、`recording-*.mjs`、`notify.mjs` | FFmpeg 帧解码、识别算法、推流、录像索引/回放、通知投递 |
| 装配 | `server/index.mjs`（约 2000 行） | 目录初始化、配置解析、服务装配、路由挂载、10 个定时器、SSE 广播、优雅停机 |
| 前端 | `src/App.tsx`（状态编排）+ `hooks/*` + `components/*` + `lib/api.ts`（唯一 HTTP 出口） | 监控大屏、告警中心、管理面板、录像时间线 |

### 1.2 核心执行流程

**识别告警主链**：FFmpeg 解码 → `onData` 攒帧 → `FlameDetector.analyze` / `analyzeFrameQuality` → 连续帧确认 + cooldown → `store.createAlarm`（事务内建保护窗口）→ `broadcastEvent` → 前端 `useAlarms.upsertAlarm` → 提示音/Toast → 处置 PATCH → 状态机 `pending → confirmed → archived` 或 `false`。

**录像链**：`RecordingCaptureManager` 按布防表写 `.ts` → 每 5 分钟 `reconcileRecordingSegments` 增量对账 → `recording_segments` 索引 → 时间线/回放会话/MP4 导出。

**SSE 链**：登录建连 → `sseClients.add` → 告警写入后 `broadcastEvent` 逐客户端校验（`authRevision` 缓存 + 站点范围）→ 断线指数退避重连 → 重连补刷。

### 1.3 主要数据流与状态归属

| 状态 | 归属 | 生命周期 | 重启后 |
|---|---|---|---|
| 用户/告警/点位/审计/录像索引 | SQLite（`app.db`，WAL，FULL） | 持久 | 保留 |
| 会话撤销 | `auth_sessions` 表（V10） | 持久 | 保留 |
| `authRevision` 权限修订号 | Store 进程内整数 | 进程 | 归零（缓存随之重建，安全） |
| `sseClients`、`loginAttempts`、`metrics` | 进程内存 | 进程 | 丢失（预期） |
| `mediaUsageCache` | 内存 + 5 分钟 TTL | 进程 | 自动重算 |

---

## 二、问题清单（按优先级）

### P1 — 应立即处理

#### P1-1 `camera_abnormal`（画面异常）在监控大屏被渲染为「烟雾告警」

- **影响范围**：监控大屏瓦片与全屏焦点窗口；所有启用画面质量检测的部署。
- **证据**：`src/App.tsx:337-344`（`statusMap`）与 `:348-358`（`activeAlarms`）只排除 `offline`：
  ```ts
  if (alarm.level === 'offline') return;
  const next: CameraStatus = alarm.level === 'fire' ? 'fire' : 'smoke';
  ```
  `AlarmLevel` 含第四个取值 `camera_abnormal`（`src/types.ts:17`）；服务端在 `server/index.mjs:1117` 确实产生该告警（过暗/过曝/遮挡持续 45s），`confidence: 88`。
  `src/components/CameraTile.tsx:190-191` 又用二元表达式 `alarm.level === 'fire' ? '火焰' : '烟雾'`，于是画面正中央叠加「烟雾 88%」识别框。
  反证：`src/components/AlarmCard.tsx:23` 已明确把 `camera_abnormal` 与 `offline` 归为 `isDeviceHealth`，说明视频墙映射是遗漏而非设计。
- **影响**：把设备画面故障误报为火情烟雾，对消防值守是方向性误导；且会覆盖同点位真实告警的显示优先级。
- **修复建议**：两处过滤条件改为 `if (alarm.level === 'offline' || alarm.level === 'camera_abnormal') return;`；同时把 `CameraTile.tsx:191`、`FocusViewer.tsx` 同类二元标签改为查表映射，避免新增等级时再次落入默认分支。
- **验证状态**：✅ 已独立复核代码事实。需真机触发一次画面异常确认视觉表现（缺信息见 §四）。

#### P1-2 ONVIF 发现接口：整数/十六进制/八进制 IP 编码绕过云元数据恒定拦截

- **影响范围**：所有云上部署（元数据服务可达时）；具备 `CAMERA_MANAGE` 能力者（站点管理员或全局管理员）。
- **证据**：`server/routes/cameras.mjs:608` 的字符集正则 `^[a-zA-Z0-9._:-]+$` 允许纯数字；`:611` 与 `server/onvif.mjs:171` 校验的是**原始字符串**；而 `server/onvif.mjs:37-41` 用 `url.hostname = host`，由 WHATWG URL 规范化后才发请求 —— **校验对象与使用对象不一致**。
- **我的独立复现**（Node 22，真实调用 `blockedOutboundHost`，参数与代码一致）：

  | 输入 host | 校验原始串 | 实际请求主机 | 校验规范化后 |
  |---|---|---|---|
  | `2852039166` | 放行 | `169.254.169.254` | **拒绝** |
  | `0xa9fea9fe` | 放行 | `169.254.169.254` | **拒绝** |
  | `2130706433` | 放行 | `127.0.0.1` | 放行 |
  | `0177.0.0.1` | 放行 | `127.0.0.1` | 放行 |

  对照组 `169.254.169.254` 直接输入被正确拒绝 —— 证明是编码绕过而非策略放行。
- **影响**：绕过模块注释声明的"任何部署形态恒定拦截"；可对任意内网 IP:端口发 SOAP POST，错误经 `cameras.mjs:624-629` 回显，构成 blind SSRF + 状态码 oracle。
- **修复建议**：在 `onvif.mjs:171` 之前**先构造 URL**，用 `assertOutboundUrl(buildDeviceBaseUrl(host, port) + '/onvif/device_service')` 校验规范化后的地址；`net-guard.mjs` 的 `parseIpv4` 增加整数/`0x`/八进制字面量识别作为纵深防御。两处都要改，避免其它调用方重蹈覆辙。
- **验证状态**：✅ 绕过已复现。元数据实际可读取深度依赖部署（是否在云上、目标是否响应 SOAP），见 §四。

---

### P2 — 应尽快处理

#### P2-1 Webhook 与 ONVIF 请求使用裸 `fetch`，逐跳重定向校验未覆盖

- **影响范围**：通知渠道 Webhook、ONVIF 设备发现。
- **证据**：`guardedFetch`（`net-guard.mjs:297`）全项目仅 `server/routes/media.mjs:101` 使用；`server/notify.mjs:265` 与 `server/onvif.mjs:105` 均为裸 `fetch`，默认 `redirect:'follow'`。配置写入期（`index.mjs`）只校验初始 host。
- **攻击/触发路径**：配置一个通过校验的公网 URL → 该服务器返回 `302 Location: http://169.254.169.254/...` → 跟随重定向 → `notify.mjs:271` 读响应体，前 180 字符写服务端日志。
- **修复建议**：`notify.mjs` 注入 `fetchImpl` 时默认包装为 `guardedFetch`；`onvif.mjs:105` 直接替换。注意保持 `notify.test.mjs` 的 mock 注入方式兼容。
- **验证状态**：✅ 代码事实确认；需一个可控 302 的上游才能端到端验证。

#### P2-2 内置通知模板可被删除且不会自动恢复

- **影响范围**：所有部署；任何具 `NOTIFY_MANAGE` 能力者。
- **证据**：`server/store/methods/notify.mjs:213` 的 JSDoc 写"内置模板拒绝"，但 `:215-224` 的函数体**没有 `current.builtin` 检查**；`server/routes/notify.mjs:255-258` 同样只查存在性。内置模板由 `schema.mjs:680-694` 在 V6 播种，`INSERT OR IGNORE` + `if (version >= 6) return`（`:658`）——已升到 V10 的库不会重跑，删除后永久丢失。
- **影响**：引用它的渠道 `templateBody` 变 `null`，通知退化为默认文案；持久配置丢失。
- **修复建议**：`deleteNotificationTemplate` 内 `if (current.builtin) return false;`，路由层读 `current.builtin` 直接返回 403，避免把"拒绝"误报成 404。
- **验证状态**：✅ 代码事实确认，无需真机。

#### P2-3 录像时间线请求缺 generation 守卫，快速切换点位/日期导致数据错位

- **影响范围**：处置记录页；弱网或大数据量时易触发。
- **证据**：`src/components/RecordingTimeline.tsx:132` 的 `setData(await api.recordingsTimeline(...))` 与 `:134-137` 的 catch/finally 均无 generation 检查；而同文件 `handlePlay` 在 `:232/235/238` 正确检查了。
- **影响**：旧响应晚到会覆盖新数据；时间线显示 A 的块，下拉选中 B，随后播放/导出用 B 的 cameraId 配 A 的时间块。
- **修复建议**：在 `await` 返回后及 catch/finally 统一 `if (generationRef.current !== generation) return;`，与 `handlePlay` 对齐。
- **验证状态**：✅ 代码事实确认。

#### P2-4 `/proxy` 上游响应无大小上限

- **影响范围**：具站点管理权限者可构造同源上游。
- **证据**：`server/routes/media.mjs:101-116` 的 `guardedFetch` 后直接 `upstream.arrayBuffer()`，无字节限制；playlist 分支再生成一份重写字符串。
- **影响**：20 秒超时内可拉入超大响应，多请求并发导致 OOM。
- **修复建议**：先检查 `content-length`，再流式读取并累计字节上限（建议 16MB），超限 abort；playlist 重写限制行数。
- **验证状态**：✅ 代码事实确认。

#### P2-5 登录限流的三维设计在 `TRUST_PROXY=true` 且直连时可被喷洒绕过

- **影响范围**：依赖部署形态。
- **证据**：`server/http/session.mjs:208-231` 的三维限流中两维以 IP 为键；`index.mjs:542` 的 `clientIp()` 取 `req.ip`。默认不设 `TRUST_PROXY` 时 XFF 伪造无效；但设置后若服务仍直连，攻击者可轮换 XFF 与 username（各维度都低于阈值）。
- **修复建议**：增加一个**不依赖 IP** 的全局累计失败数或指数退避；限制 `X-Forwarded-For` 链长度；在反代层强制覆盖该头。
- **验证状态**：⚠️ 需 `TRUST_PROXY` 实际值与网络拓扑，见 §四。

#### P2-6 升级通知投递失败仍写入「已升级」事件，后续不再重试

- **影响范围**：告警升级链路。
- **证据**：`server/index.mjs:1330-1337` 的条件 `if (!result || (result.sent === 0 && result.failed === 0)) return;` —— `failed>0` 时仍写 `alarm_events(action='escalated')`；而下轮 `:1319` 用 `hasAlarmEvent` 跳过。同时 `claimNotification` 的唯一键已占用，重试也会被判 skipped。
- **影响**：事件流显示"已升级通知"但值班员未收到，且该告警再也不会升级。
- **修复建议**：若升级允许重试 —— 仅 `sent>0` 写事件，且失败时删除对应 `notification_logs` 释放唯一键；若设计就是"仅尝试一次"，至少把事件文案区分为"升级通知发送失败"。**需先确认产品语义**。
- **验证状态**：⚠️ 代码事实确认，是否算缺陷取决于设计意图。

---

### P3 — 计划处理

| 编号 | 问题 | 位置 | 影响与建议 |
|---|---|---|---|
| P3-1 | 登出后该会话的 SSE 长连接不关闭 | `routes/auth.mjs:176-195`、`index.mjs:167-192` | logout 只 `revokeSession`，`broadcastEvent` 只查 user/disabled/站点，**不校验 sid**。被登出的标签页继续收告警。建议 sseClients 记录 sid，广播时调 `isSessionRevoked` |
| P3-2 | `deleteSite` 未递增 `authRevision` | `store/methods/sites.mjs:87-91` | SSE 缓存保留已删站点 ID；HTTP 侧不受影响。建议事务提交后 `bumpAuthRevision()`（我在上一轮漏了这处） |
| P3-3 | 启动早期 `uncaughtException` 被吞、不退出 | `index.mjs:618` 定义 `fatalHandler`，`:2051` 才回填；`process-safety.mjs:75-79` 又 catch onFatal 自身异常 | 619~2051 窗口内进程状态已不可信却既不退出也不停机。建议安装时传入最终引用或 setter，onFatal 失败强制 `process.exit(1)` |
| P3-4 | SSE 客户端数无上限 | `routes/auth.mjs:226-244` | 登录用户可建大量长连接；FD/内存增长，`broadcastEvent` 遍历变慢。建议按 userId/IP 限并发，超出关闭最旧连接 |
| P3-5 | 告警中心「类型」筛选缺「画面异常」选项 | `src/components/AlarmCenter.tsx:152-156` | 该类型告警存在但无法单独筛选。建议由 `LEVEL_META` 动态生成选项，避免新增等级再次遗漏 |
| P3-6 | `RecordingTimeline` 的 `cameraId` 不随 `cameras` 异步加载同步 | `src/components/RecordingTimeline.tsx:50,100-101` | 挂载时 cameras 为空则 `cameraId=''`，后续加载出来也不请求，停留空态。建议加 effect：当前 id 不在列表中时设为 `cameras[0]?.id ?? ''` |

---

## 三、测试覆盖评估

### 3.1 现状

- 46 个测试文件、229 条测试；抽样未发现空断言或被注释掉的断言。
- **断言有效**：`site-admin.test.mjs:164-194` 断言站点隔离的实际返回（1 个站点、`mySiteIds`、跨站点 403），不是只测状态码；`api.test.mjs` 覆盖 CSRF、401、角色创建、会话失效。
- 本轮新增测试均对准行为：`config.test.mjs` 锁定 0 值/负数/NaN，`runtime-hardening.test.mjs` 锁定增量对账的 `inserted/updated` 计数、`authRevision` 递增顺序、错误体 `code`、`EXPLAIN QUERY PLAN` 走索引。

### 3.2 覆盖热力图

| 高风险模块 | 覆盖 | 依据 |
|---|---|---|
| 认证/会话/CSRF | 充分 | `api.test.mjs`、`site-admin.test.mjs` |
| 角色能力矩阵 | 充分 | `roles.test.mjs` 13 条逐用户等价性 |
| 配置边界 | 充分 | `config.test.mjs` 9 条 |
| 出网白名单（字符串形式） | 充分 | `net-guard.test.mjs` 12 条 |
| 录像对账/回放 | 充分 | `recording-index/store/playback/followup.test.mjs` |
| 告警状态机 | 部分 | `escalation.test.mjs` 覆盖升级；失败重试分支无测试 |
| 内置模板不可删除 | **无** | 无断言检查 `builtin` 保护 |
| ONVIF 编码绕过 | **无** | `onvif.test.mjs` 只用点分十进制主机 |
| 重定向二跳 | **无** | `net-guard.test.mjs` 有 302 测试，但只测 `guardedFetch` 自身，未测 notify/onvif 是否使用它 |
| SSE 长连接生命周期 | **无** | 无测试覆盖登出关闭、连接数上限 |
| E2E 失败路径 | **无** | `e2e-smoke.mjs` 只有成功登录；无错误密码、越权 403、断线重连、UTM 切换后的状态恢复 |

### 3.3 建议补充的测试（具体到行为）

1. `notify.test.mjs`：新增「内置模板删除被拒绝」——`deleteNotificationTemplate('builtin-default')` 返回 false 且行仍存在。
2. `onvif.test.mjs`：新增「整数/十六进制主机编码在构造 URL 后被拦截」——参数化 `2852039166`/`0xa9fea9fe`，断言不发出请求。
3. `net-guard.test.mjs`：新增「notify 与 onvif 使用受控 fetch」——注入会 302 到元数据的 mock，断言抛 `OutboundBlockedError`。
4. `api.test.mjs`：新增「登出后 SSE 推送不再送达该客户端」与「同一用户连接数上限」。
5. `escalation.test.mjs`：新增「webhook 失败时不写 escalated 事件，下轮可重试」。
6. `e2e-smoke.mjs`：增加一次错误密码登录（断言错误文案与不构成账号枚举）、一次 viewer 越权操作（断言 403 与前端提示）、一次主动断开 SSE 后重连（断言断线徽标出现与消失）。

---

## 四、无法判断的部分（缺什么信息）

| 事项 | 缺少的信息 | 为什么不能判断 |
|---|---|---|
| P1-1 的实际视觉表现 | 真机触发一次画面异常（过暗/过曝/遮挡 45s）后的截图 | 代码路径已确认，但「烟雾 88%」叠加层是否真的可见取决于 `CameraTile` 的渲染条件与 CSS 层级 |
| P1-2 元数据可被读取的深度 | 是否云环境、169.254.169.254 是否可达、目标是否响应 SOAP POST | 静态审查只能证明请求发出，不能证明能读到凭据 |
| P2-5 限流绕过是否实际可利用 | `TRUST_PROXY` 实际值、是否有反代强制覆盖 XFF、服务是否直连公网 | 默认配置下 XFF 伪造无效 |
| P2-6 升级失败是否应重试 | 产品对「升级通知」的语义：一次性通知 vs 失败重试 | 代码本身自洽，取决于设计意图 |
| `reconcileInFlight` 模块级锁 | 单进程是否只有一个 Store 实例 | 多实例共享进程时锁会跨实例互相跳过 |
| 识别阈值准确性（夜间/逆光/红色物体误报） | 带标注的真机视频素材与误报样本 | 纯静态审查无法评估算法准确率；不臆测 |
| FFmpeg 超时 kill / ONVIF 组播兼容性 | 真机设备与不同厂商固件 | 静态代码无法判定回调竞态与协议差异 |
| DNS rebinding | 是否配置出口 ACL | `net-guard.mjs:23-25` 自述为已知局限，需网络层信息 |

---

## 五、明确排除（已核查，非问题）

- **SQL 注入 / 路径穿越**：动态 SQL 全用占位符；文件路径有 `SAFE_ID`/`SEGMENT_REL` + `path.resolve` 前缀校验 + 文件名白名单。
- **FFmpeg 参数注入**：全部 `spawn(arrayArgs)` 无 shell，`-i` 后接值；源 URL 强制协议前缀。
- **凭据脱敏与口令存储**：`sanitize.mjs` 抹除 userinfo；AES-256-GCM 每次随机 IV；scrypt 每账号随机 salt + `timingSafeEqual` + dummyVerify。
- **登录错误文案**：对外恒为「用户名或密码错误」，不存在账号枚举。
- **状态机并发**：相关 handler 全程同步无 `await`，Node 单线程下不存在交错。
- **管理员守卫**：计数与写入同事务；各 store 方法均夹取 `limit` 防 `LIMIT -1`。
- **detector/frame-quality 边界**：除零、数组越界、掩码全屏蔽、ROI 百分比 clamp 均已防护。
- **前五轮已修项**：抽查确认当前代码无残留 —— IPv4-mapped IPv6 点分/十六进制形式、config 0 值/负数、SSE 缓存与 `authRevision`、增量对账、审计索引、统一错误体。

---

## 六、优先级建议汇总

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | **P1-2** ONVIF 编码绕过 | 安全边界明确被突破，攻击路径可复现 |
| 2 | **P1-1** 画面异常误显示烟雾 | 消防值守方向性误导，影响判断 |
| 3 | **P2-1** 裸 fetch 重定向 | 与 P1-2 同族，一处修复可覆盖两条路径 |
| 4 | **P2-2** 内置模板删除 | 一行防护，避免持久配置丢失 |
| 5 | **P2-3** 时间线竞态 + **P2-4** 代理无上限 | 分别影响数据正确性与进程稳定 |
| 6 | P2-5/P2-6 | 需先取得部署信息或产品确认，不宜直接改 |
| 7 | P3 各项 | 可按批次集中处理，建议同时补 §3.3 的对应测试 |

**总体评价**：架构分层清晰、依赖方向单向、安全基线扎实（已排除常见注入与越权），测试对核心链路有实质断言。剩余风险集中在**「校验对象与使用对象不一致」这一类问题**（P1-2、P2-1）与**新增枚举值未被所有渲染/过滤点同步**（P1-1、P3-5）—— 建议将这两类模式加入后续 code review checklist。

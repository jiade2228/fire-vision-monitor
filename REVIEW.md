# 项目审查报告（2026-10-31）

范围：`火情视频识别监控项目-93014924` 全部源码（server/ 约 15 个模块、src/ 前端、scripts/ 工具、CI/Docker），以及 git 入库文件与敏感内容。基线：测试 65/65、E2E 11/11、构建通过。

---

## 一、问题清单（按优先级）

### P0 · 应立即修复的缺陷

| # | 问题 | 位置 | 影响 | 修复建议 |
|---|---|---|---|---|
| 1 | **告警保留清理留下孤儿数据**：`pruneAlarms()` 只 `DELETE FROM alarms`，`alarm_events` / `notification_logs` 无外键、无级联，告警删除后事件与推送日志永久残留 | `server/store.mjs` `pruneAlarms` | 数据膨胀、按 alarm_id 查询出现指向不存在告警的记录；生产已有 17 条事件对 2 条告警的实例 | 在同一事务里按 alarm_id 删 `alarm_events` 与 `notification_logs`；补「删除告警后关联记录同步清理」测试 |
| 2 | ~~静态资源强缓存规则与 Vite 文件名不匹配~~（**已复核：本条为审查误诊**） | `server/index.mjs` 静态服务中间件 | 复核后实测：`express.static` 已全局 `maxAge: 1y + immutable: true`，`/assets/*.js` 响应头实测为 `Cache-Control: public, max-age=31536000, immutable`，`/` 为 `no-store`。我此前按印象写入了不存在的「hex 正则」，此条不成立，无需修复。 | （无动作） |

### P1 · 安全与数据治理

| # | 问题 | 位置 | 影响 | 修复建议 |
|---|---|---|---|---|
| 3 | **Webhook 目标主机未限制**（协议校验原本已有）：`parseNotifyChannelInput` 已限 `http/https` 与长度，但主机的 IP 段未限制，可指向 `169.254.169.254`（云元数据）等 | `server/index.mjs` `parseNotifyChannelInput` | 仅管理员/站点管理员可配，风险中低 | **已修复**：新增 `isBlockedNotifyHost()`——永久拦 `169.254.0.0/16` 与 `0.0.0.0`；环回与私网默认放行（内网/本机 Webhook 是真实用法），公网部署设 `NOTIFY_BLOCK_PRIVATE=1` 时额外拦环回、私网与 `.local`；已加测试 |
| 4 | **审计日志只有条数上限、无天数保留**（原描述「无保留策略」不准确）：`pruneAuditLogs()` 已按「保留最近 20000 条」裁剪，但缺按保留期的清理语义 | `server/store.mjs` | 20000 条足以兜底不膨胀，属治理一致性而非缺陷 | **已补**：新增 `pruneAuditLogsByAge()` + `AUDIT_RETENTION_DAYS`（默认 180 天），在每日 `retentionRun` 中与告警/推送日志一起执行；已加测试 |
| 5 | **登录限流表可被灌满后整体清空**：`loginAttempts.size > 10000` 直接 `clear()`，给攻击者制造重置窗口 | `server/index.mjs` 登录限流 | 低危，内存型限流的常见边角 | 改 LRU 淘汰最旧键而非全清；按 IP 维度再设一层总限流 |

### P2 · 可维护性

| # | 问题 | 建议 |
|---|---|---|
| 6 | `server/index.mjs` 约 3200 行单文件，承载全部路由与中间件 | 按域拆 `routes/{auth,cameras,alarms,notify,sites,demo,audit}.mjs`，共享 `requireAuth/requireRole/allowedSiteIdsFor` 到 `http/guards.mjs`。分 2-3 次小步迁移，每步跑全量测试 |
| 7 | `server/store.mjs` 约 1800 行，schema 迁移与业务方法混杂 | 拆 `schema.mjs`（建表+迁移）与 `store/` 方法模块；迁移逻辑单独可测 |
| 8 | 后端无类型约束，靠前端的类型与人工对齐 | 先给 store/引擎/notify 的公共接口加 JSDoc 类型（不改构建链），长期再评估 TS 化 |
| 9 | E2E 测试管理员密码硬编码 `Admin12345!` | 改 `E2E_ADMIN_PASSWORD` 环境变量（默认现值），注释「仅用于临时测试实例」 |

### P3 · 性能（当前规模非瓶颈，记录即可）

- 检测引擎每路 160×90@1fps 抽帧、24 路上限、关键帧降载开关，CPU 设计已合理；转码 8 路上限、90 秒空闲停流。
- 告警/通知/审计列表无虚拟滚动，300 条内可接受；超过再引入。
- `/api/system` 存储扫描已 5 分钟缓存，OK。

### 已确认良好的部分（无需改）

- 会话：HMAC 签名 + `tokenVersion` 强制下线；HttpOnly + SameSite=Lax + HTTPS 时 Secure；7 天过期。
- CSRF：自定义头 + Origin 校验；CSP 严格（`script-src 'self'`、无 `unsafe-eval`）、`object-src 'none'`、`frame-ancestors 'self'`；HSTS 仅 HTTPS。
- 密码：scrypt + `timingSafeEqual`；长度 8-128。
- SQL：全参数化；多版本迁移（V1→V5）有副本演练记录。
- 密钥：`credentials.key`/`session.secret`/`edge.token` 均 0600、`wx` 独占创建；渠道密钥 AES-256-GCM 落库，接口只回 urlHint。
- 代理：`/proxy/:id` 同源限制防 SSRF；跨域越权 404 防探测。
- 子进程：FFmpeg 退出按指数退避重启、关停清理、演示实例停止即回收。
- 测试：65 项 + E2E 11 项，动态端口避免撞车。


### 审查复核修正记录（重要）

首版报告中三项判断经复核不成立，已在上表标注，此处集中说明，避免误导后续工作：

1. **「静态资源强缓存失效」——误诊**。`express.static` 已全局 `maxAge: '1y', immutable: true`，`index.html` 单独 `no-store`。实测：`/assets/index-*.js` 返回 `Cache-Control: public, max-age=31536000, immutable`。报告中提到的「hex 正则」并不存在，属我按印象误写。
2. **「Webhook 未限制协议」——不准确**。协议（http/https）与长度校验原本就有，真实缺口只是「目标主机 IP 段未限」，已按分层策略修复。
3. **「审计日志无保留策略」——不准确**。原本已有「保留最近 20000 条」的上限裁剪，缺的是按天数的保留期语义，已补。

教训：审查必须逐条对照实现取证（读代码 + 实测响应），不能凭架构印象推断；本次是因「以为是常见写法」而写了不存在的实现细节。

---

## 二、新增功能优先级（价值 / 必要性 / 复杂度）

| 优先级 | 功能 | 价值与必要性 | 复杂度 |
|---|---|---|---|
| P1 | **告警保留的级联清理**（缺陷修复，见问题 1） | 数据一致性底线 | 半天 |
| P1 | **空状态快速引导**：无视频源时给出「看演示 → 接摄像头 → 配通知」三步卡 | 新用户第一印象与自助上手；此前已出现「导入测试无告警」的真实困惑 | 半天 |
| P1 | **审计日志保留策略**（见问题 4） | 与告警/推送一致的治理闭环 | 半天 |
| P2 | **告警短视频时间线回放**：把已有告警短视频按时间轴排列、点击播放、前后跳转、自动连播 | 复盘与演练价值高；数据已存在，不需要持续录像，是「完整录像回放」的低成本第一阶段 | 1 天 |
| P2 | **点位批量操作**：批量启停检测、批量灵敏度、批量删除 | 点位超过十几路后的刚需；当前 6 路可缓 | 半天 |
| P2 | **通知文案模板**：站点/点位/时间/置信度/处置链接可配 | 对接现有值班流程时有用 | 半天 |
| 暂缓 | 持续录像时间线回放（分段存储 + 时间索引 + 播放器） | 价值高但依赖真机与存储设计，建议真机联调后做 | 大 |
| 暂缓 | PTZ 云台控制、地图视图、AI 模型替换、多节点集群 | 无对应数据/硬件/规模诉求，属过度设计 | — |

---

## 三、GitHub 开源上传前：文件分类

### 可公开（已入库 88 个文件，全部安全）
- `src/`、`server/`、`scripts/`、`public/`、`index.html`、`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`
- `README.md`、`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.gitignore`、`.github/workflows/ci.yml`
- `edge-gateway.example.json`、`nvr-test.example.json`（仅示例，无真实地址/凭据）
- 本报告（`REVIEW.md`）

### 必须保持私密（已在 .gitignore，上传前再核对）
| 内容 | 原因 |
|---|---|
| `data/`（`app.db`、`credentials.key`、`session.secret`、`edge.token`、`backups/`、`snapshots/`、`recordings/`、`previews/`、`instance.lock`、`app.json*`） | 用户数据、账号哈希、会话/加密/网关密钥、媒体 |
| `node_modules/`、`dist/` | 依赖与构建产物，由 CI/本地重建 |
| `.env`、`.env.*` | 环境密钥 |
| `test-videos/` | 视频素材体积大，且含 CC-BY-SA 素材，不入库更稳（README 已注明来源与用途） |
| 工作区外的临时目录（`.tmp-*`、`.workbuddy/`） | 不在项目内，不会被提交；保持现状 |

### 上传前需要新增/调整
1. **`LICENSE`**：建议 MIT（代码）+ 单独说明：文档/界面可同 MIT；`test-videos/` 素材遵循各自 CC 协议（CC BY / CC BY-SA / CC0），不入库、仅在本地测试用。若希望更明确的专利授权，可选 Apache-2.0。
2. **`SECURITY.md`**：漏洞反馈渠道、密钥与数据不入库约定、生产部署必须 HTTPS 与初始化管理员、备份与 `credentials.key` 同备份。
3. **`CONTRIBUTING.md`（可选）**：`npm test` / `npm run e2e` / `npm run build` 必过；分支与提交风格；不提交 `data/`、`.env`、构建产物。
4. **`.gitignore` 补充**（建议）：`*.db`、`*.db-shm`、`*.db-wal`、`coverage/`、`playwright-report/`、`.DS_Store`、`Thumbs.db`、`scripts/.tmp-*.mjs`（防止临时脚本误入库）。
5. **`package.json`**：补 `description`、`license`、`repository`、`keywords`、`engines.node`（>=22.5）；确认 `private` 字段按开源意图去除。
6. **依赖漏洞**：本环境 npm 镜像不支持 audit 接口，上传前在官方 registry 执行 `npm audit`（生产与开发依赖分别看），并跑 `npm outdated` 评估升级。

### 历史与清理
- 当前 git 历史仅本地 9 个提交，无敏感文件入库记录；可直接 `git remote add origin <repo>` 推送 main。
- 推送前再跑：`git ls-files | grep -Ei "data/|dist/|node_modules/|\.env|app\.db|credentials\.key|edge\.token"`（应为空）。
- 若未来误提交密钥：立即轮换该密钥（`credentials.key` 轮换会使已加密渠道配置无法解密，需同时重配），并用 `git filter-repo` 清史后强推。

---

## 四、发布前检查清单（2026-11-06 建立，2026-11-08 复核）

代码与测试
- [x] P0：告警级联清理已修复并有回归测试（#2「静态缓存失效」经复核为误诊，无需动作）
- [x] P1 三项：Webhook 主机校验、审计按天保留、登录限流 LRU 均已处理
- [x] `npm test` 85/85、`npm run e2e` 11/11、`npm run build` 通过（11-06 建立，11-08 三批复跑同一基线）
- [x] 官方 registry `npm audit` 0 漏洞
- [x] 11-06 补修：`openStore` 不再把并发/锁竞争误判为数据库损坏（见第五节）
- [x] 11-06：持续录像第一阶段（V8 索引、对账、时间线）落地并有测试（见第六节）

敏感内容
- [x] `git ls-files` 123 个文件，无 `data/`、`dist/`、`node_modules/`、`.env*`、密钥或媒体
- [x] 示例配置改用 RFC 5737 文档地址 + 占位符（`739827e`）
- [x] E2E 密码改 `E2E_ADMIN_PASSWORD` 环境变量（`9174c29`）
- [ ] 生产管理员强密码、演示点位/演示数据清理：需在目标实例上人工确认（本地 `data/` 仍留有历史运行数据）

文档与许可
- [x] `LICENSE`（MIT）+ 测试素材 CC 协议说明
- [x] `README.md` 与实际一致（11-06 更新目录结构：路由已拆分、schema V8、持续录像索引）
- [x] `SECURITY.md`、`CONTRIBUTING.md` 就位
- [ ] `package.json` 的 `repository` 字段：待仓库地址确定后补（description / license / keywords / engines 已齐）

仓库与 CI
- [x] `.gitignore` 补充项（含 `.workbuddy/`、诊断临时目录与 Playwright 产物）已提交
- [ ] 推送 main 后 CI（test + build + e2e）全绿：**阻塞**——本地无 `git remote`、无 gh CLI，需提供仓库地址
- [ ] 分支保护（main 需 PR + CI）：同上，待仓库创建后配置

部署形态确认
- [ ] 真机联调与公网拓扑（VPS 部署 / 隧道扩展）待拍板
- [ ] 生产守护 watchdog：**代码已修**（11-06 增加单实例判定、指数退避、45s 启动窗口与 5 分钟卡死兜底），仍需在目标机器验证一次「停止后自动拉起」

另：持续录像回放的**第一阶段已完成**（V8 索引、目录扫描/对账、时间线 API 与前端时间条，见 `docs/continuous-recording-design.md` 实施记录）；采集 worker、按需转码、导出仍依赖真机验证磁盘与 FFmpeg 行为，按原判定暂缓。

---

## 五、11-06 复核：`data/` 下 `*.corrupt-*` 副本堆积

**现象**：`data/` 有 6 套 `app.db*.corrupt-*`（10-30 至 11-06 10:41，约 6MB）；`app.db-wal` 935KB 远大于 `app.db` 102KB；`instance.lock` 记录 pid 7044 于 11-06 10:45 启动。

**取证**：在数据库副本上 `PRAGMA quick_check` / `integrity_check` 均为 `ok`，`schema_version=7`、11 张表；对副本执行完整 `openStore()` 成功。即库文件并未损坏。

**根因**
1. `openStore` 的 `catch` 覆盖建表、V1→V7 全部迁移与 `ensureDefaultSite`，任意异常（典型为多实例并发时的 `SQLITE_BUSY`）都被贴上「数据库损坏」标签并复制现场；
2. `backupCorruptFiles` 无判重、无清理，每次失败新增 3 个文件，反复启动即无限累积，且错误信息误导排查方向；
3. `scripts/fire-watchdog.ps1` 健康检查失败即每 12 秒拉起新实例，没有「启动中」退避，易与慢启动叠加形成并发启动；
4. `PRAGMA journal_mode = WAL`（需排他锁）排在 `busy_timeout = 5000` 之前，竞争时立即 BUSY 而非等待。

**本轮修复**
- 仅 `errcode` 11/26（`SQLITE_CORRUPT` / `SQLITE_NOTADB`）或明确的损坏消息才判为损坏并备份；其余异常抛出真实原因并附 `cause`，不再生成误导性备份。
- `backupCorruptFiles` 对「主库 + WAL 内容等价」的重复现场跳过复制（shm 会被运行时重建，不参与判重），历史副本不自动删除。
- `busy_timeout` 提前到建立连接后的第一条 PRAGMA。
- 新增 3 项回归测试：错误分类、重复备份去重、非损坏失败不产生副本。

**已闭环（11-06 用户确认后执行）**
- `data/` 下 6 套（16 个文件、5.3MB）历史副本已全部送入回收站；完整备份保留在 `data/backups/corrupt-copies-20261106/`（逐字节校验一致），数据库本体 md5 未变、`/healthz` 200。
- watchdog 的重启退避已于同日第二轮改动补齐，但仍建议在目标机器联调时验证。

---

## 六、11-06 第二轮：守护脚本 + 持续录像第一阶段

**守护脚本 `scripts/fire-watchdog.ps1`**：原来健康检查失败即每 12 秒无条件 `Start-Process`，慢启动会叠加多实例。现改为：
- 用 `instance.lock` 的 pid + `Win32_Process.CommandLine` 双重确认「确实在跑本项目」的实例（防 pid 复用误判）；
- 已有实例存活时只等待并指数退避（15→120s），不重复拉起；
- 无实例时拉起一次并给 45 秒启动窗口；连续 5 分钟不健康才判定卡死、显式终止后重建；
- 写 `data/watchdog.log`（已被 `*.log` 忽略）；PowerShell 语法校验 0 错误，UTF-8 BOM 与中文路径保持完好。

**持续录像第一阶段**（设计文档 §9 第 1 步的索引部分）：
- schema **V8**：`recording_segments` 表 + 两个索引，新库建表与 V7→V8 迁移共用同一段 DDL；
- 目录改为 `data/continuous/<cameraId>/<YYYYMMDD>/<HHmmss>.ts`（UTC），与 `data/recordings/` 的告警短视频 mp4 隔离，避免被媒体水位扫描误清理；
- `server/recording-index.mjs`：目录扫描、按相邻段校准时长、文件系统→索引对账、`buildTimeline`（合并连续块 + 生成 gap），全部不依赖 FFmpeg；
- `server/store/methods/recordings.mjs`：批量补录、时间窗查询、孤儿清理、保护段标记与豁免淘汰；
- `GET /api/recordings/timeline`（登录 + 站点权限，跨站点 404）与 `POST /api/recordings/reconcile`（超管），5 分钟自动对账，shutdown 清理定时器；
- 前端 `RecordingTimeline.tsx` 挂在「处置记录」页：24h 时间条、缺口/保护段图例、日期与点位切换、点击定位；
- `RECORDING=1` 目前只影响 `enabled` 标记，**不会启动录像进程**；`play`/`export`、采集 worker、保护段自动联动仍待真机。

**验证**：`npm test` 85/85（新增 7 项录像索引/接口测试）、`npm run build`、`npm run e2e` 11/11 全绿。
另修正两处把 schema 版本硬编码为 `7` 的测试，改为断言 `SCHEMA_VERSION` 常量，避免后续迁移反复改测试。

---

## 七、11-08 复核：三批优化、UI 缺陷修复与当前状态

**代码优化三批**（均为行为不变的等价抽取，每批全量验证）：

| 提交 | 范围 | 要点 |
|---|---|---|
| `6ee14ba` | 第一批 4 项 | timeline 改回主键查询并修正错误注释、7 个测试固定端口改动态端口、CSV 下载逻辑抽取、删除 `detection.ts` 死代码 |
| `ecf6fef` | 第二批 8 项 | 事务复用、批量导入 O(N²)→O(N)、audit 筛选条件共用、路由输入解析与保留路径常量共享、装配层清理、JSDoc 漂移修正 |
| `599d0e1` | 第三批 4 项 | Webhook 签名 helper、告警抓图/短视频 handler 抽取、冗余循环条件化简、灵敏度类型同源 |

**UI 缺陷修复（本次）**：`src/styles/app.css` 的审计日志表格 `.audit-table*` 引用了 4 个**未定义且无 fallback** 的变量（`--color-border-tertiary` / `--color-background-secondary` / `--color-text-primary` / `--font-mono`），使容器与单元格边框、表头背景、操作列文字色、等宽字体声明全部失效。已对齐项目现有设计变量 `--line` / `--panel-2` / `--text` / `--mono`，不引入新配色体系。`--muted` 的 3 处引用均带 fallback、视觉正常，仅命名不统一，暂不动。

**浅色主题（新增，用户选定「手动切换」方案）**：`src/lib/theme.ts` + `:root[data-theme='light']`，顶栏「浅色/深色」按钮切换、localStorage 持久化、`main.tsx` 挂载前应用防闪烁、`theme-color` meta 同步。为保证默认深色外观逐字不变，将约 51 处硬编码语义色与强调白字改为 CSS 变量并保留原深色取值；浅色块给出对比度更高的取值。E2E 新增 2 项（切换后 `color-scheme`/背景生效、刷新后保持），共 13 项全绿。
**已知限制**：仍有大量 `rgba(126,168,214,x)` 半透明边框、深色遮罩与少量硬编码色未适配，浅色主题为第一版，需按页面逐块视觉回归；未做逐页截图验收。

**当前基线**：`npm test` 85/85（skipped 0）、`npm run build`、`npm run e2e` **13/13**；git 工作区干净。

**仍未解决 / 需拍板**
- 代码：CSS 死样式与重复定义清理、`Dockerfile` build 阶段缺 FFmpeg 导致测试集合与 CI 不一致、`e2e-smoke.mjs` 个人机器路径与中文文案断言、P3 魔法数字、`AdminPanel.tsx`(3421 行) / `App.tsx`(982 行) 分步拆分。
- 取证后刻意不统一：notify 三处 payload 结构、`media.mjs` 三处守卫块的 404 形态差异（统一会改行为或引入过度参数化）。
- 明确排除（会改响应/方法面）：统一 404 响应体、`/proxy/*` 的 `app.all` 收敛、历史迁移重构、拆分 `main()`。
- 外部阻塞：GitHub 仓库地址（无 remote / 无 gh CLI / 无 token）、持续录像采集与按需转码真机联调、watchdog 生产验证、目标实例管理员强密码与演示数据确认。
- **新增功能与配色方案**（浅色主题、主题切换、新功能清单）尚无具体需求对象，未实施，需先明确范围。

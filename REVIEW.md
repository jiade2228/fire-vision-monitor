# 项目审查报告（2026-10-31）

范围：`火情视频识别监控项目-93014924` 全部源码（server/ 约 15 个模块、src/ 前端、scripts/ 工具、CI/Docker），以及 git 入库文件与敏感内容。基线：测试 65/65、E2E 11/11、构建通过。

---

## 一、问题清单（按优先级）

### P0 · 应立即修复的缺陷

| # | 问题 | 位置 | 影响 | 修复建议 |
|---|---|---|---|---|
| 1 | **告警保留清理留下孤儿数据**：`pruneAlarms()` 只 `DELETE FROM alarms`，`alarm_events` / `notification_logs` 无外键、无级联，告警删除后事件与推送日志永久残留 | `server/store.mjs` `pruneAlarms` | 数据膨胀、按 alarm_id 查询出现指向不存在告警的记录；生产已有 17 条事件对 2 条告警的实例 | 在同一事务里按 alarm_id 删 `alarm_events` 与 `notification_logs`；补「删除告警后关联记录同步清理」测试 |
| 2 | **静态资源强缓存规则与 Vite 文件名不匹配**：immutable 正则 `\./[0-9a-f]{8,}\.` 只认 hex，而 Vite 产物 hash 是字母数字混合（如 `index-Bgu3cM9H.js`），因此带 hash 的 JS/CSS 实际没有 immutable 缓存 | `server/index.mjs` 静态服务中间件 | 每次刷新都回源拉取 JS/CSS，弱网/大屏多开时首屏变慢 | 对 `/assets/` 下的构建产物统一 `Cache-Control: public, max-age=31536000, immutable`（文件名含 hash 即安全）；`index.html` 保持 no-cache |

### P1 · 安全与数据治理

| # | 问题 | 位置 | 影响 | 修复建议 |
|---|---|---|---|---|
| 3 | **Webhook 地址缺少校验**：通知渠道 URL 直接由服务端 `fetch`，未限制协议/目标。管理员可误配或指向内网服务、云元数据地址（SSRF 面） | `server/notify.mjs` `post/postWithRetry`；`parseNotifyChannelInput` | 仅限管理员/站点管理员可配，风险中低，但属于典型 SSRF 入口 | 仅允许 `http/https`；可选禁 `169.254.0.0/16`、`localhost`、内网段（提供 `NOTIFY_ALLOW_PRIVATE=1` 供内网 Webhook 场景）；URL 长度限制已有 |
| 4 | **审计日志无保留策略**：`audit_logs` 只增不清，长期运行膨胀 | `server/store.mjs` `retentionRun` | 量小但无界；目前 22 条 | 加 `AUDIT_RETENTION_DAYS`（默认 180 天）复用现有每日清理 |
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

## 四、发布前检查清单

代码与测试
- [ ] P0 两项缺陷（告警级联清理、静态缓存）已修复并有回归测试
- [ ] P1 三项（webhook 校验、审计保留、限流 LRU）已处理
- [ ] `npm test` 全绿、`npm run e2e` 全绿、`npm run build` 通过
- [ ] `npm audit` 在官方 registry 无高危漏洞

敏感内容
- [ ] `git ls-files` 不含 `data/`、`dist/`、`node_modules/`、`.env*`、任何密钥/媒体
- [ ] 示例配置（edge-gateway/nvr-test）无真实 IP、账号、密码
- [ ] E2E 密码仅用于临时实例，已改环境变量
- [ ] 生产管理员已改强密码；演示点位/演示数据已清理

文档与许可
- [ ] `LICENSE` 已添加（MIT 或 Apache-2.0）并声明素材 CC 协议
- [ ] `README.md` 功能/部署/环境变量/FAQ 与实际一致
- [ ] `SECURITY.md`、`CONTRIBUTING.md` 就位
- [ ] `package.json` 元数据（license/repository/engines）补齐

仓库与 CI
- [ ] `.gitignore` 补充项已提交
- [ ] 推送 main 后 CI（test+build+e2e）全绿
- [ ] 分支保护：main 需 PR + CI 通过（可选但推荐）

部署形态确认
- [ ] 真机联调与公网拓扑（A1 服务上 VPS / A2 隧道扩展）已拍板
- [ ] 生产守护（watchdog/compose）在目标机器验证过一次「停止后自动拉起」

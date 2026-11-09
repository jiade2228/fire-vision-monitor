# 火情视频识别监控平台 · 统一交付说明

> 本文件是本次全部工作的**唯一交付入口**：代码、测试、配置、部署步骤、验收标准与已知限制都在这里对齐。
> 交付基线：本地 `main` 分支，工作区干净；整合提交与后续修订见 `git log --oneline -10`。
> 平台：Windows / Node 22 / Express 5 + node:sqlite / React 19 + TS + Vite 7。

---

## 1. 交付物清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 应用代码 | `server/`、`src/`、`scripts/` | 后端服务、前端、守护与测试脚本 |
| 构建与部署 | `Dockerfile`、`docker-compose.yml`、`.github/workflows/ci.yml` | 多阶段构建 + CI（test/build/e2e） |
| 发布工具 | `scripts/publish.mjs` | 参数化仓库地址，补齐 `repository` 元数据并推送 main |
| 设计文档 | `docs/continuous-recording-design.md`、`REVIEW.md` | 持续录像设计 + 历次审查结论 |
| 本交付说明 | `DELIVERY.md` | 全条目对照、约束、验证、部署与验收 |

**主要提交序列**：`6ee14ba`（第一批优化）→ `ecf6fef`（第二批后端等价抽取）→ `599d0e1`（第三批通知/媒体抽取）→ `43f18a6`（UI 缺陷修复 + 审查完善）→ `be5f228`（浅色主题）→ `cb12965`（低风险清理）→ 本文件所在提交（全量收口）。

---

## 2. 全部条目逐项对照（不遗漏）

### 2.1 代码审查优化清单

| # | 条目 | 状态 | 落地提交 / 位置 |
|---|---|---|---|
| 1 | P0 告警级联清理、静态缓存复核 | ✅ 已完成（缓存项为审查误诊，无需改） | 历史提交 |
| 2 | P1 Webhook 主机校验、审计按天保留、登录限流 LRU | ✅ 已完成 | 历史提交 |
| 3 | timeline 主键查询 + 错误注释修正 | ✅ | `6ee14ba` · `server/routes/recordings.mjs` |
| 4 | 7 个测试固定端口 → 动态端口 | ✅ | `6ee14ba` |
| 5 | CSV 下载逻辑抽取、删除 `detection.ts` 死代码 | ✅ | `6ee14ba` |
| 6 | 路由 deps 样板与 JSDoc 漂移 | ✅ | `ecf6fef` 修漂移；本轮 `server/routes/deps.mjs` 统一 `RouteDeps` typedef（10 个路由模块） |
| 7 | cameras 站点解析/权限三段式（6 处） | ✅ | `ecf6fef` 抽 `siteIdInput`；本轮抽 `siteGuard`，4 种中文文案逐字保留 |
| 8 | recordings 手写事务 → `Store.transaction()` | ✅ | `ecf6fef` |
| 9 | `importCameras` O(N²) → O(N) | ✅ | `ecf6fef` |
| 10 | audit list/count 筛选条件共用 | ✅ | `ecf6fef` · `buildAuditFilter` |
| 11 | SPA 回退 / 404 保留前缀共用 | ✅ | `ecf6fef` · 刻意保留两处排除范围差异 |
| 12 | 装配层清理（未用解构、timer、JSDoc 字段） | ✅ | `ecf6fef` |
| 13 | Webhook 签名 helper + 三处 payload 构造抽取 | ✅ | `599d0e1` 签名；本轮 `buildChannelBody`，保留三处 title / payload / `X-Fire-Event` 差异 |
| 14 | 告警抓图/短视频 handler 抽取 | ✅ | `599d0e1` · `serveAlarmMedia` |
| 15 | media 三处守卫块抽取 | ✅ | 本轮 `mediaCameraFor`，保留协议白名单、`sourceUrl` 检查与三种 404 形态差异 |
| 16 | 三处 FFmpeg 一次性进程封装 | ✅ | 本轮 `server/ffmpeg-once.mjs`，超时 5000/25000/8000 与失败语义逐项参数化 |
| 17 | 输入校验小工具、冗余循环条件、类型同源 | ✅ | `ecf6fef` / `599d0e1` / `cb12965` |
| 18 | CSS 死样式（20 个静态类，37 条规则含后代/伪元素/@media） | ✅ | 本轮；动态拼接类全部保留，未留空规则 |
| 19 | `.clip-download` / `.user-row` 重复定义合并 | ✅ | 本轮；合并后计算样式与原来逐字等价 |
| 20 | 半透明边框/遮罩变量化（99 处声明） | ✅ | 本轮；`:root` 取原值保证深色不变，light 给浅色值 |
| 21 | `--muted` 历史别名补齐、重试延时常量、FFmpeg 跳过告警 | ✅ | `cb12965` |
| 22 | `levelLabelFor` 复用、后端 `DIR_MODE` 常量 | ✅ | 本轮 |
| 23 | `createSite` 对 TEXT 主键误用 `last_insert_rowid()` 的失效 fallback | ✅ | 本轮；统一用同一 `siteId` 插入并回读 |
| 24 | `status()` JSDoc 补齐、schema 版本断言改常量 | ✅ | `ecf6fef` / `6ee14ba` |
| 25 | `AdminPanel.tsx`(3421 行) / `App.tsx`(982 行) 分步拆分 | ⚠️ **第一步已落地**：抽出 `StatsChart` / `StatsOverview` / `AuditLogTable` 三个零状态纯展示组件，AdminPanel 降至 3263 行；其余 5 个 Tab 与 App.tsx 待后续批次（见 §6） | 本轮 |
| 26 | P3 时区偏移/阈值魔法数字散落 | ⚠️ 部分：UTC / 本地墙上时间 / +8 展示三套语义**刻意不统一**（统一会改行为）；已抽常量的部分见 #17/#22 | — |
| 27 | P3 schema 历史迁移版本守卫重复、V4/V7 alarms 重建重复 | ⛔ **经评估排除**：已跑完的历史迁移，改动零收益且风险高 | — |

### 2.2 功能、UI 与配色

| 条目 | 状态 | 说明 |
|---|---|---|
| 审计表格 4 个失效 CSS 变量（真实 UI bug） | ✅ | `43f18a6`：边框、表头背景、操作列色、等宽字体恢复 |
| 新增浅色主题 + 顶栏手动切换 | ✅ | `be5f228`：`src/lib/theme.ts`、localStorage 持久化、挂载前应用防闪烁、`theme-color` 同步；默认深色外观逐字不变 |
| 浅色主题剩余硬编码适配 | ✅ | 本轮：81 处半透明边框 + 18 处深色遮罩变量化，light 下给出对比度取值 |
| 主题切换与持久化的自动化验证 | ✅ | E2E 新增 2 项，共 13 项 |
| 「增加具体功能」 | ⛔ 未臆测 | 历次均未给出功能清单与验收标准；输入模板见 §5.7 |
| 「修复具体 bug」 | ⛔ 未臆测 | 多轮审查未发现 P0/P1 功能缺陷；已修的是上述 UI 失效。bug 输入模板见 §5.7 |

### 2.3 工程与测试

| 条目 | 状态 | 说明 |
|---|---|---|
| `Dockerfile` build 阶段缺 FFmpeg → 测试集合与 CI 不一致 | ✅ | 本轮：build 阶段安装 FFmpeg 并清理 apt lists，runtime 安装保留，层缓存顺序不变 |
| `e2e-smoke.mjs` 个人机器路径 | ✅ | `cb12965`：改 `PUPPETEER_REQUIRE_DIR` + 项目 `node_modules` |
| E2E 依赖中文文案精确匹配（14 处） | ✅ | 本轮：组件加 `data-testid`，E2E 改用稳定选择器；仅保留 1 处状态值文本比对（语义需要）与自建数据断言 |
| 测试基线 | ✅ | `npm test` 85/85、`npm run build`、`npm run e2e` 13/13 |

### 2.4 经评估明确排除（非遗漏）

统一 404 响应体（JSON / 文本 / 空体混用）、`/proxy/*` 的 `app.all` 收敛为 GET/HEAD、重构 V1→V8 历史迁移、拆分约 1060 行 `main()`、大列表虚拟化（当前 300 条上限）。这些都会改变对外行为或属零收益大重构，与「保持行为不变」约束冲突。理由记录在 `REVIEW.md` 第七节。

### 2.5 需外部环境执行（已给出可直接执行的步骤）

GitHub 推送、持续录像采集/按需转码/导出真机联调、watchdog 生产验证、目标实例管理员强密码与演示数据清理、公网拓扑拍板 —— 全部在 §5 给出命令或验收清单，不再以「请提供 XX」悬空。

---

## 3. 接口、命名与行为约定（本次全部保持一致）

- **路由**：`registerXxxRoutes(app, deps)` 工厂模式不变；deps 键名不变；JSDoc 统一引用 `import('./deps.mjs').RouteDeps`（纯类型模块，运行时零影响）。
- **数据层**：`Store.prototype` 经 `Object.assign(..., 领域方法)` 挂载；公共方法名、参数与返回结构不变；schema 保持 **V8**。
- **HTTP**：状态码、响应体、中文错误文案逐字不变；跨站点一律 404 防探测；媒体 404 的三种形态（JSON / `send(文本)` / 空体）刻意保留。
- **通知**：Webhook `X-Fire-Signature` 算法与 `X-Fire-Event` 头差异保留；三类渠道 payload 字段顺序不变（保证 `JSON.stringify` 与签名输入一致）。
- **文件与目录**：`data/recordings/` 存告警短视频 mp4（受 `MEDIA_MAX_BYTES` 管理）；`data/continuous/<cameraId>/<YYYYMMDD>/<HHmmss>.ts` 存录像段（UTC），两者隔离。
- **主题**：存储键 `flame-vision.theme.v1`，默认 `dark`；`:root` 深色取值不可改，浅色由 `:root[data-theme='light']` 覆盖。
- **时区**：录像段文件名按 UTC、布防时间表按本地墙上时间、告警展示按上海 +8，三套语义各有用途，不得强行统一。

---

## 4. 验证基线与证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | **85/85**，failed 0 / skipped 0 |
| 类型检查 + 构建 | `npm run build` | `tsc --noEmit` 通过，Vite 63 modules，产物正常 |
| E2E 冒烟 | `npm run e2e` | **13/13**（含主题切换与持久化） |
| CSS 静态自检 | 括号平衡、未定义变量、自引用、死类残留、动态类存活 | 全 PASS；深色计算样式逐字还原对比相等 |
| 后端语法 | `node --check`（15 个改动文件） | 全通过 |
| FFmpeg/通知行为 | mock spawn 5 种生命周期分支、mock fetch 9 组 body/headers | 与原语义一致 |
| Git | `git diff --check`、`git status` | 干净 |

三个并行模块（样式 / 前端+E2E+Docker / 后端）改动合并后**一次全量验证全绿**，可确认相互兼容。

---

## 5. 部署与发布（可直接执行）

### 5.1 本地启动
```bash
npm ci
npm test && npm run build
node server/index.mjs --port 4173      # 或 npm start
curl http://127.0.0.1:4173/healthz     # 期望 200
```

### 5.2 Docker
```bash
docker build -t fire-vision-monitor .
```
build 阶段已安装 FFmpeg，`npm test` 与 CI 覆盖同一批用例；runtime 阶段 `npm ci --omit=dev` 并带 HEALTHCHECK。

### 5.3 推送 GitHub（唯一需要你提供的是仓库地址）
```bash
node scripts/publish.mjs https://github.com/<owner>/<repo>.git            # 预演
node scripts/publish.mjs https://github.com/<owner>/<repo>.git --apply     # 实际执行
```
脚本会：补 `package.json` 的 `repository` → 配置 `origin` → `git push -u origin main`。默认预演不做任何改动；凭据由本机 git 凭据管理器提供，脚本不接触 token。

### 5.4 CI 与分支保护
推送后到仓库 Actions 确认 `test + build + e2e` 全绿；在 Settings → Branches 为 `main` 配置「需 PR + CI 通过」。

### 5.5 持续录像真机验收清单（依赖真实设备，设计文档 §8）
- [ ] 24 路子码流 copy 录像的磁盘写入速率与 CPU 占用
- [ ] `kill -9` 后重启，索引对账补录正确、TS 段可播
- [ ] 超配额淘汰时保护段豁免、IO 平滑
- [ ] 跨 NTP 校时/夏令时无时间戳跳变
- [ ] Windows 现场路径文件名合法性与 fsync 行为
- [ ] 按需转码并发上限与 90s 回收在时间线拖拽下的体验
> `RECORDING=1` 目前只影响时间线的 `enabled` 标记，**不会启动录像进程**；采集 worker、`play`/`export`、保护段自动联动需在以上验收通过后实施。

### 5.6 生产守护 watchdog
`scripts/fire-watchdog.ps1` 已具备单实例判定、指数退避、45s 启动窗口、5 分钟卡死兜底与 `data/watchdog.log`。部署后验证一次「停止服务 → 自动拉起 → 日志有记录」。

### 5.7 交付后初始化 / 需求输入模板
```bash
npm run reset-password -- --username admin      # 生产管理员强密码（不传 --password 会生成随机强密码）
# 管理端「演示数据清理」或 POST /api/demo/purge  # 清理演示点位/告警
```
- **新增功能输入模板**：功能名 / 目标用户 / 触发入口 / 验收标准 / 是否依赖真机或新硬件。
- **bug 输入模板**：页面或接口 / 复现步骤 / 期望与实际 / 报错日志或截图 / 发生时间（便于查 stdout JSON 日志）。
没有这些信息时不臆测实现。

---

## 6. 已知限制

1. **浅色主题为第一版**：E2E 验证变量生效与持久化，但**未做逐页截图视觉回归**；`--line/--line-strong` 的 light 值仍为硬编码，少量语义色（火焰橙、危险红等）沿用原值。建议交付后在浏览器按「实时监控 / 告警中心 / 处置记录 / 系统管理（6 个 Tab）/ 聚焦弹窗」逐页目视一次。
2. **前端拆分仅第一步**：`AdminPanel.tsx` 3421 → 3263 行，抽出 3 个纯展示组件；cameras/users/sites/notify 等 Tab 与 `App.tsx` 仍在原文件。如需继续，按 Tab 逐个抽离，每批跑全量测试。
3. **CSS `rgba(var(--x), a)` 写法**：依赖现代浏览器对 CSS 变量在旧式 `rgba()` 中展开的支持（Chromium/Firefox/Safari 均支持）；代入后计算值与原深色逐字相等。
4. **E2E 仍保留 1 处中文状态值比对**（`'处置中'`）：这是状态跃迁断言，固定 testid 会让 pending 态提前通过；另 2 处是自建数据的渲染断言，刻意保留。
5. **真机相关功能未实施**：持续录像采集 worker、按需转码、导出、保护段自动联动（见 §5.5）。
6. **外部信息未提供**：GitHub 仓库地址、真机环境、目标实例访问，相关动作以脚本/清单交付而非代执行。

---

## 7. 可检查的完成标准

- [x] `npm test` 85/85、`npm run build`、`npm run e2e` 13/13 全绿
- [x] `git diff --check` 干净、`git status` 干净
- [x] CSS 无未定义变量 / 无自引用 / 无空规则；动态拼接类全部存活
- [x] 深色主题计算样式与改动前逐字相等；浅色主题切换与刷新持久化通过 E2E
- [x] 后端 15 个改动文件 `node --check` 通过；FFmpeg/通知行为 mock 验证等价
- [x] 全部审查条目在 §2 有明确状态（完成 / 部分 / 排除 / 需外部环境），无遗漏
- [x] 每个需外部环境的条目都有可直接执行的命令或验收清单
- [ ] 交付后：填仓库地址跑 `publish.mjs --apply` → CI 全绿 → 分支保护
- [ ] 交付后：按 §5.5 / §5.6 完成真机与守护验证
- [ ] 交付后：按 §6.1 完成浅色主题逐页目视；按 §5.7 完成强密码与演示数据清理

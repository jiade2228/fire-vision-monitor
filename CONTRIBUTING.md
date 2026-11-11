# 贡献指南

## 开发环境

```bash
npm ci
npm run dev      # Vite 5173 + API 8787
```

需要 Node ≥ 22.5（使用内置 `node:sqlite`）与 FFmpeg（检测与转码依赖）。

## 提交前必须通过

```bash
npm test         # 单元与接口测试（串行执行）
npm run build    # tsc --noEmit + vite build
npm run e2e      # 端到端冒烟（需要本机 Chrome，缺失会自动跳过）
```

三项任一失败请先修复再提 PR。CI 会在 push / PR 时自动执行同样三项。

## 代码约定

- 后端为原生 ESM（`server/*.mjs`），不引入构建步骤；新模块请保持无框架依赖的纯 Node 风格。
- 数据库变更必须走 `server/store.mjs` 的迁移函数（`migrateSchemaV*`），并同时在 `server/store.test.mjs` 补「旧版本库原地升级」回归。
- SQL 一律参数化，禁止字符串拼接用户输入；需要动态 `IN` 列表时用占位符展开（参考 `purgeDemoAlarms`）。
- 子进程（FFmpeg）必须有超时、退出码与清理路径；新增常驻进程需在关停流程中释放。
- 前端不引入新的重型依赖（如 UI 框架），样式写在 `src/styles/app.css`，遵循现有 CSS 变量。
- 涉及权限的路由必须显式使用 `requireAuth` / `requireRole` / `allowedSiteIdsFor`，并补越权断言。
- 日志用 `log(level, event, fields)` 单行 JSON，勿拼接多行文本。

## 测试约定

- 测试起的服务使用 `getFreePort()`（`server/test-port.mjs`）动态端口，禁止写死端口。
- 依赖 FFmpeg 的测试用 `skip: !ffmpegOk` 优雅跳过，不得依赖开发者本机环境。
- 新增功能的 PR 请附最小复现路径（命令或 UI 步骤），便于评审复跑。

## 分支与提交

- 分支：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`
- 提交信息用中文一句话说明「做什么」，正文列改动点与验证方式
- 不要提交 `data/`、`dist/`、`node_modules/`、`.env*`、`test-videos/` 与任何密钥

## 不接受的改动

- 引入不必要的大型依赖或构建工具链替换
- 关闭/绕过安全校验（CSRF 头、站点隔离、密码策略）以「方便调试」
- 未带测试的数据层或权限变更

## 文档与多语言

- 项目说明维护**中英双语**：`README.md`（简体中文，默认）与 `README.en.md`（English）。
  修改功能、配置项或部署方式时**两份都要同步**，并在文件顶部保留语言切换链接。
- 其它文档（`DELIVERY.md`、`docs/*`）以中文为主，需要时在文末补 `English summary` 小节。
- 新增或调整行为后，同步更新 `DELIVERY.md` 的「验收基线」数字（测试条数、E2E 结果）。

## 评审清单

提交前对照 [docs/REVIEW-CHECKLIST.md](./docs/REVIEW-CHECKLIST.md) 自查，其中六类根因
（出网校验时机、枚举消费点、防御模式半覆盖、安全依赖配置、事件语义、配置解析）
都是历史上真实造成过缺陷的模式，不要凭直觉跳过。

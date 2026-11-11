# 交付与运维清单（最终收口）

> 单一运维入口：汇总「当前已验证状态 / 本地复验命令 / 待外部执行的动作 / 验收标准」。
> 完整设计、接口约定与历史审查见 `DELIVERY.md` 与 `REVIEW.md`；本文件只给可直接执行的结论与命令。

## 0. 一句话结论

代码、测试、构建、浅色主题对比度、前端拆分**全部本地验证通过**：`npm test` **115/115**、`npm run e2e` **23/23**、构建 **76 modules**、浅色主题 **9 个视图/管理 Tab 共 0 处 WCAG 对比度不达标**、`AdminPanel` 与 `App` 已全量拆分。

唯一未执行的是**需要外部环境的动作**（GitHub 推送、watchdog 真机验证、真机录像验收、目标实例强密码与演示数据清理）——均已给出可直接执行的命令与清单，并非代码缺口。

---

## 1. 当前已验证状态（本机复验，as-built）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | **115/115** pass，0 fail / 0 skip |
| 类型检查 + 构建 | `npm run build` | `tsc --noEmit` 通过，Vite **76 modules** |
| E2E 冒烟 | `npm run e2e` | **23/23** pass（含浅色主题切换 / 持久化 / 对比度断言） |
| 浅色主题对比度 | `node scripts/contrast-scan.mjs` | **9 视图 / 管理 Tab 共 0 处** WCAG 不达标（正文 ≥4.5:1，大字号/加粗 ≥3:1） |
| Git | `git status` / `git diff --check` | 改动已就位，`diff --check` 无冲突标记 |
| 发布预演 | `node scripts/publish.mjs <repo>` | 默认 dry-run，零改动、零风险（已就绪，按你的要求未实际推送） |

---

## 2. 本最终批次完成的收口项

- **浅色主题逐页对比度精修**：在 `src/styles/app.css` 的 `:root[data-theme='light']` 块补充结构面覆盖，以及监控瓦片内部、告警占位、主题切换开关等语义色；不达标项 **660 → 381 → 0**。
  同时修正了扫描脚本 `resolveBg` 的合成顺序 bug（原本会把任意渐变祖先误判为最终背景、忽略元素自身不透明背景），使扫描结果真实可靠。**深色主题外观逐字未改**——所有改动均限定在 `:root[data-theme='light']` 选择器内。
- **前端拆分收口**：`AdminPanel.tsx` **3101 → 1583 行**，6 个 Tab（Cameras / Users / Sites / Stats / Notify / Audit）抽出独立组件；`App.tsx` 监控视图与聚焦弹窗抽出 `src/app/MonitorView.tsx` / `FocusOverlay.tsx`。所有 hooks / handlers 保留在父组件，仅抽取 JSX，拆分后 `tsc --noEmit` 与全量测试 / E2E 全绿。
- **新增 `scripts/contrast-scan.mjs`**：真实浏览器走通登录 → 切浅色 → 遍历 9 视图，输出 `contrast-report.json`，作为浅色主题可读性的回归守护。

---

## 3. 本地复验命令（任何人接手都能跑）

```bash
npm ci
npm test                       # 期望 115/115
npm run build                  # tsc --noEmit + vite build，期望成功
npm run e2e                    # 期望 23/23（需本机 Chrome + puppeteer-core）
node scripts/contrast-scan.mjs # 期望 9 视图 0 处不达标（需本机 Chrome）
```

> 对比度扫描与 E2E 需要本机 Chrome；缺失时脚本会优雅跳过并提示，不阻塞其它验证。

---

## 4. 待外部环境执行的动作（命令已就绪，非代码缺口）

### 4.1 推送到 GitHub（已就绪，按你的要求暂未推送）

```bash
node scripts/publish.mjs https://github.com/<owner>/<repo>.git          # 预演（零改动）
node scripts/publish.mjs https://github.com/<owner>/<repo>.git --apply  # 实际推送（幂等、带 git 异常防护）
```

推送后到仓库 Actions 确认 `test + build + e2e` 全绿；Settings → Branches 为 `main` 配置「需 PR + CI 通过」。

### 4.2 生产守护 watchdog（代码已完成，需目标机验证一次）

部署 `scripts/fire-watchdog.ps1` 后验证：停止服务 → 自动拉起 → `data/watchdog.log` 有记录。

### 4.3 持续录像真机验收（代码已实现，需现场设备）

- [ ] 24 路子码流 copy 录像的磁盘写入速率与 CPU 占用
- [ ] `kill -9` 后重启，索引对账补录正确、TS 段可播
- [ ] 超配额淘汰时保护段豁免、IO 平滑
- [ ] 跨 NTP 校时 / 夏令时无时间戳跳变
- [ ] Windows 现场路径文件名合法性与 fsync 行为
- [ ] 按需转码并发上限与 90s 回收在时间线拖拽下的体验

### 4.4 目标实例初始化（强密码 + 演示数据清理）

```bash
npm run reset-password -- --username admin           # 不传 --password 生成随机强密码
# 管理端「演示数据清理」或 POST /api/demo/purge      # 清理演示点位/告警
```

---

## 5. 验收标准（是否可交付）

- [x] `npm test` 115/115、`npm run build`、`npm run e2e` 23/23 全绿
- [x] `node scripts/contrast-scan.mjs` 浅色主题 0 处对比度不达标（9 视图）
- [x] `git diff --check` 干净
- [x] 深色主题计算样式逐字不变（改动仅在 `:root[data-theme='light']`）
- [x] 前端拆分后类型检查 + 全量测试 / E2E 通过
- [ ] 交付后：填仓库地址跑 `publish.mjs --apply` → CI 全绿 → 分支保护
- [ ] 交付后：按 §4.2 / §4.3 完成 watchdog 与真机验收
- [ ] 交付后：按 §4.4 完成强密码与演示数据清理

---

## 6. 已知限制（透明披露）

1. 浅色主题已通过**自动化逐元素对比度扫描（0 不达标）**，但仍建议人工目视一次「实时监控 / 告警中心 / 处置记录 / 系统管理 6 Tab / 聚焦弹窗」的观感。
2. 深色主题本次未重跑对比度扫描（扫描脚本固定切浅色）；其外观为原始设计、未被改动。如需深色 WCAG 报告，可扩展脚本增加深色分支。
3. 持续录像功能代码完整，但 §4.3 六项为真机 / 性能验收，非实现前置；`RECORDING=0` 默认不启动采集，索引 / 对账 / 回放 / 导出对历史段完全可用。
4. 外部阻断项（GitHub 地址、真机、watchdog、强密码 / 演示清理）为环境动作，已脚本化 / 清单化交付，非代码缺口。

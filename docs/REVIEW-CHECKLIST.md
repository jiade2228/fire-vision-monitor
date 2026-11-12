# 代码审查检查清单（防复发）

> 源于第五、六轮审查的 6 类根因。提交前逐项自查；review 时逐项确认。
> 这些不是风格偏好，而是**已经造成过真实缺陷**的模式。

## 1. 出网地址：校验对象必须等于使用对象

**曾经导致的缺陷**：IPv4-mapped IPv6 十六进制绕过、ONVIF 整数/十六进制 IP 绕过、Webhook 302 跳内网。

- [ ] 任何从配置或用户输入得到的主机名/URL，**先构造 URL 得到规范化 hostname，再校验**，不要校验原始字符串。
- [ ] 所有服务端 HTTP 出网必须经过 `net-guard.mjs` 的 `guardedFetch`，不要直接 `fetch`。
  - 自查命令：`grep -rn "await fetch\|globalThis.fetch" server/ --include="*.mjs"`
  - 新增加的接口若必须用裸 fetch（如测试注入），要在 PR 中说明理由。
- [ ] 新增出网点时，在下方清单登记并说明校验方式。

| 出网点 | 位置 | 校验方式 |
|---|---|---|
| `/proxy` 视频代理 | `routes/media.mjs:101` | `guardedFetch` + 逐跳 |
| ONVIF SOAP | `onvif.mjs:105` | `guardedFetch` + `assertOutboundUrl` |
| 通知 Webhook | `notify.mjs:265` | 默认 `fetchImpl = guardedFetch` |
| ONVIF 主机格式 | `routes/cameras.mjs:608` | 字符集 + `assertOutboundUrl`（规范化后） |

## 2. 联合类型扩展：让编译器帮你找消费点

**曾经导致的缺陷**：新增 `camera_abnormal` 后，大屏把它渲染成「烟雾」，筛选下拉缺选项。

- [ ] 新增 `AlarmLevel` / `CameraStatus` 等联合类型的取值时，必须逐一检查六处：
  1. `src/lib/detection.ts` 的 `LEVEL_META`、`LEVEL_LABELS`
  2. `src/App.tsx` 的 `ALARM_TO_CAMERA_STATUS`（大屏映射）
  3. `src/components/AlarmCenter.tsx` 的筛选下拉
  4. `src/components/AlarmCard.tsx` 的设备健康分类
  5. `src/components/CameraTile.tsx` / `FocusViewer.tsx` 的标签
  6. 服务端文案表（如摘要的 `summaryLevelNames`）
- [ ] **禁止**用 `x === 'fire' ? A : B` 这类二元表达式处理多值枚举 —— 未知值会被静默映射成 B。改用 `Record<Union, T>` 查表或 `Partial<Record<...>>` 白名单。
- [ ] 大屏/叠加层用**白名单**：新增等级默认不显示，而不是默认显示成某种已知类型。

## 3. 防御模式要覆盖完整路径

**曾经导致的缺陷**：`generationRef` 只护住播放没护住时间线；`authRevision` 漏了 `deleteSite`；内置模板 JSDoc 说拒绝但没实现。

- [ ] 给某个异步操作加 generation/序号守卫时，检查它的**所有** await 分支（成功、catch、finally）。
- [ ] 新增任何改变用户权限或站点归属的写入时，调用 `bumpAuthRevision()`。
  - 自查命令：`grep -rn "bumpAuthRevision" server/store/methods/`
  - 已有：createUser / updateUser / bumpTokenVersion / deleteUser / setUserSites / deleteSite
- [ ] JSDoc 中承诺的行为（"拒绝"、"不可删除"）必须有对应实现**和**测试。文档不是契约，测试才是。

## 4. 安全不能依赖部署配置

- [ ] 限流、连接数、超时等不能只依赖 `TRUST_PROXY` / XFF 等外部配置；至少有一个不依赖它们的代码级兜底维度。
- [ ] 长连接（SSE/WebSocket）必须有数量上限，且登出/会话撤销时主动关闭对应连接。
- [ ] `uncaughtException` 处理器不能把进程置于"既不退出也不停机"的状态。

## 5. 事件记录的是结果，不是意图

- [ ] 写"已发送/已升级/已完成"事件前，确认操作**真的成功**。失败时不要写成功事件，否则判重逻辑会让重试永久失效。
- [ ] 去重键的设计要区分"已完成"与"失败可重试"：`sent` 保持幂等，`failed` 允许重新 claim。

## 6. 配置解析

- [ ] 数值配置统一用 `server/config.mjs` 的 `envNumber`，不要写 `Number(x) || default`。
- [ ] 明确 0 的语义（关闭 vs 非法），用 `allowZero` 显式声明。
- [ ] 需要整数的配置传 `integer: true`；默认保留小数（`ESCALATION_MINUTES=0.01` 是既有测试契约）。

## 7. 测试不得依赖运行环境（时区 / 平台 / 路径）

**曾经导致的缺陷**：`schedule.test.mjs` 用 `new Date(2026, 10, 2, 10, 0)` 构造输入，
该构造函数按**本地时区**解释参数。开发机是 GMT+8，CI 是 UTC，同一断言结论相反——
本地全绿、CI 失败。被测的 `isArmedNow` 本身是正确的（内部固定 +8），错的只是测试。

- [ ] 涉及业务时间的测试，用 UTC 绝对时刻构造输入，不要用 `new Date(y, m, d, hh, mm)`。
  本项目业务时区固定 Asia/Shanghai（+8），可用 `new Date(Date.UTC(y, m-1, d, hh-8, mm))`。
- [ ] 跨平台路径断言不要用宿主的 `path.join` 拼对方平台的路径（Windows 上会得到反斜杠），
  用被测代码同一套平台感知拼接。
- [ ] 断言文件系统行为时注意大小写敏感差异（Linux 区分大小写，Windows/macOS 默认不区分）。
- [ ] **本地验证要模拟 CI 时区**：`TZ=UTC npm test`。只跑默认时区会漏掉这类问题。

---

## 提交前最小验证

```bash
npx tsc --noEmit
npm test
TZ=UTC npm test                 # 模拟 CI 时区，捕捉本地时区依赖
node --test --test-concurrency=1 server/net-guard.test.mjs server/runtime-hardening.test.mjs
git diff --check
```

涉及出网改动时额外运行：
```bash
node --test --test-concurrency=1 server/onvif.test.mjs server/notify-redact.test.mjs server/proxy.test.mjs
```

涉及 UI 改动时额外运行：
```bash
npm run build && npm run e2e && node scripts/contrast-scan.mjs
```

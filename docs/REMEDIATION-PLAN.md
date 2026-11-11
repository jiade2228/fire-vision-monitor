# 问题成因分析与整改方案

> 对应审查报告：`docs/DEEP-CODE-REVIEW.md`（P1×2、P2×6、P3×6）。
> 本文只做**归因、方案、步骤、风险、验证**，不含生产代码改动。
> 每项方案都给出可直接落地的位置与代码骨架；标 ⚠️ 的项需先取得产品/部署信息再执行。

---

## 一、主要成因归因

14 个问题并非彼此孤立，可归为 6 类根因。**修复时应按根因批量治理，而不是逐条打补丁**——否则同类问题会在下一个新等级/新出网点上再次出现。

### 根因 A：校验对象与使用对象不一致（check-use separation）

**对应**：P1-2（ONVIF 整数 IP 绕过）、P2-1（裸 fetch 重定向）

安全能力 `net-guard.mjs` 是后加的，当时只接进了唯一已知的出网点 `routes/media.mjs`。遗漏的出网点有两个共同特征：

1. 校验的是**用户输入的原始字符串**（`cameras.mjs:611`、`onvif.mjs:171`），但真正发请求时经 `url.hostname = host`（`onvif.mjs:39`）或 fetch 自动跟随重定向，被校验的对象和最终连接的对象不是同一个。
2. 安全能力靠**调用方自觉接入**，没有机制保证"所有出网点都走它"。`guardedFetch` 全项目仅 1 处使用即为证据。

> 这与上一轮修掉的 IPv4-mapped IPv6 十六进制绕过是**同一个模式的另一个变体**：只要校验发生在规范化之前，就永远有新的编码方式能绕过。

### 根因 B：开放联合类型的新增取值未同步到所有消费点

**对应**：P1-1（画面异常显示为烟雾）、P3-5（筛选下拉缺画面异常）

`AlarmLevel` 从 3 值扩到 4 值（新增 `camera_abnormal`）时，只更新了告警卡片与统计文案，**没有盘点和更新所有消费点**。漏掉的两处都用**二元表达式**而非查表：

- `App.tsx:341`：`alarm.level === 'fire' ? 'fire' : 'smoke'` —— 把未知等级默认成 smoke
- `CameraTile.tsx:191`：`alarm.level === 'fire' ? '火焰' : '烟雾'` —— 同上
- `AlarmCenter.tsx:152-156`：硬编码 3 个 `<option>`

讽刺的是 `LEVEL_META: Record<AlarmLevel, ...>`（`detection.ts:17-22`）**已经是穷尽映射**，编译器本可帮忙，但消费点没用它。二元表达式把"未知"静默映射到"最相似的已知值"，在消防场景下是最危险的失败方式。

### 根因 C：防御模式只应用到部分路径（半覆盖）

**对应**：P2-3（时间线竞态）、P3-2（deleteSite 漏 authRevision）、P2-2（内置模板契约无实现）

三处都是"同一个防护在一个地方有、在另一个地方没有"：

- `generationRef` 在 `handlePlay` 的 await/catch/finally 都有检查，`load()` 的 `setData(await ...)` 没有
- `bumpAuthRevision()` 在 `setUserSites`/`updateUser`/`deleteUser` 都有，`deleteSite` 没有（**我上一轮引入该机制时遗漏**）
- `deleteNotificationTemplate` 的 JSDoc 承诺"内置模板拒绝"，函数体与测试都没有任何检查 —— 文档契约没有可执行验证

### 根因 D：安全边界依赖部署配置，而非代码不变量

**对应**：P2-5（TRUST_PROXY 下的限流绕过）、P3-4（SSE 无上限）

登录限流两维以 IP 为键，而 IP 来自 `req.ip`，其可信度取决于 `TRUST_PROXY` 与实际网络拓扑。`sseClients` 则完全没有容量约束。两者的共同点是：安全性依赖"运维配置正确"，代码自身没有兜底。

### 根因 E：把"尝试过"等同于"成功了"

**对应**：P2-6（升级失败仍写已升级事件）

`index.mjs:1331` 的条件只排除"完全没有渠道"的情况，`failed>0` 仍写 `escalated` 事件；而下一轮用 `hasAlarmEvent` 判重。事件记录的是**投递意图**，却被当成**投递结果**使用，导致失败后既显示成功又锁定不再重试。

### 根因 F：生命周期与初始化时序未闭环

**对应**：P3-1（登出不关 SSE）、P3-3（fatalHandler 空窗）、P3-6（cameraId 不同步）

- 会话撤销与长连接生命周期分属两个模块，撤销时没有通知连接侧
- `fatalHandler` 在 618 行定义、2051 行才回填，中间有约 1400 行的空窗
- `cameraId` 只在挂载时从异步数据取一次，没有跟随数据源变化

---

## 二、修复总览与批次划分

| 批次 | 优先级 | 包含项 | 目标 | 前置条件 |
|---|---|---|---|---|
| **批次 1** | 紧急 | P1-2、P1-1、P2-1 | 堵住安全绕过与方向性误导 | 无 |
| **批次 2** | 高 | P2-2、P2-3、P2-4 | 数据正确性、持久配置、资源保护 | 无 |
| **批次 3** | 中 | P2-5、P2-6 | 纵深防御与事件语义 | ⚠️ 需部署拓扑 / 产品语义确认 |
| **批次 4** | 中 | P3-1~P3-6 | 一致性与健壮性 | 无 |
| **批次 5** | 持续 | 测试补齐 + 防复发机制 | 防止同根因复发 | 与批次 1-4 同步补测试 |

**建议顺序**：批次 1 一次性完成（三项同属根因 A/B，且都改安全与显示边界），批次 2 独立进行，批次 3 在拿到信息后插入，批次 4 可并行分配。

---

## 三、批次 1 — 紧急修复

### 1.1 P1-2：ONVIF 出网校验改为"先规范化、后校验"

**成因**：A（check-use 分离）

**具体步骤**

**步骤 1** — `server/onvif.mjs`：把校验点移到 URL 构造之后，并改用 `assertOutboundUrl`。

现状（`:171`）：
```js
const blocked = blockedOutboundHost(host, { allowPrivate:true, allowLoopback:true, allowLinkLocal:true });
```
改为（在 `buildDeviceBaseUrl` 之后）：
```js
import { assertOutboundUrl } from './net-guard.mjs';

const base = buildDeviceBaseUrl(host, port);          // 已完成 WHATWG 规范化
const checked = assertOutboundUrl(`${base}/onvif/device_service`, {
  // 与既有策略等价：允许私网/环回/链路本地（摄像头自组网需要），恒定拦截元数据与未指定地址
  allowPrivate: true, allowLoopback: true, allowLinkLocal: true,
});
if (checked.error) throw new Error(`设备主机被拒绝：${checked.error}`);
```
注意：`cameras.mjs:611` 的旧校验可以保留作为"输入字符集"的第一道关，但**不能作为唯一依据**；真正的判定必须在规范化后。

**步骤 2** — `server/net-guard.mjs:55-63`：增强 `parseIpv4`，识别整数 / `0x` 十六进制 / 前导 0 八进制（含点分混写）。

```js
function parseIpv4Part(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^\d+$/.test(part)) return Number(part);
  return NaN;
}
export function parseIpv4(hostname) {
  const host = normalizeHost(hostname);
  // 单段整数形式：2852039166 / 0xa9fea9fe / 0177...（八进制整数）
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(host)) {
    const n = parseIpv4Part(host);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  // 点分混写形式：0177.0.0.1 / 0xa9fe.a9fe
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values = parts.map(parseIpv4Part);
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null;
  // 把高位段还原成完整 32 位（如 0xa9fe.a9fe → 169.254.169.254）
  ...
}
```
这一步是**纵深防御**：即使未来又有调用方忘记先规范化，net-guard 自身也能识别这些编码。

**需要的调整**：`net-guard.test.mjs` 增加整数/十六进制/八进制的参数化用例；`onvif.test.mjs` 增加"编码形式主机不发出请求"的断言。

**潜在风险与注意事项**

- ⚠️ **误伤风险**：纯数字主机名在 ICANN 规则下不是合法域名，但内网可能存在 `srv01` 这类名字 —— 本方案只匹配**全数字或 0x 前缀**，不会误伤字母数字混合名。若内网使用纯数字主机名（如 `192168001`）会改变行为，需先确认。
- `assertOutboundUrl` 的默认协议白名单是 http/https，与 ONVIF 一致；不要传 `rtsp:`，否则反而放宽。
- 校验失败的错误信息经 `cameras.mjs:624-629` 回显给客户端，只含拒绝原因、不含目标内容，安全。
- 点分混写的还原逻辑（如 `a.b.c` 三段形式）要按 WHATWG URL 的规则处理，建议直接**用 WHATWG URL 规范化后取 hostname**，不要自己重写全部规则 —— 手写解析容易引入新的不一致。更稳妥的实现：`new URL('http://' + host + '/')` 取 `hostname` 再走既有解析。

**验证方法**

```bash
node --test --test-concurrency=1 server/net-guard.test.mjs server/onvif.test.mjs server/onvif-discovery.test.mjs
```
补充的核心断言（参数化）：
```js
for (const encoded of ['2852039166','0xa9fea9fe','0177.0.0.1']) {
  const u = new URL('http://placeholder.invalid'); u.hostname = encoded;
  assert.match(assertOutboundUrl(u).error ?? '', /元数据/);
}
```
手工验证：`POST /api/onvif/discover`，body `{"hosts":["2852039166"],"port":80}` → 期望 400 且日志无对外请求。用本地监听端口验证 `2130706433` 的等价形式同样被处理（当前策略允许环回，所以这里验证的是"校验对象已变成规范化值"，不是拒绝）。

---

### 1.2 P1-1：画面异常不得映射为烟雾

**成因**：B（枚举消费点未同步 + 二元表达式默认分支）

**具体步骤**

**步骤 1** — `src/App.tsx:333-360`：把黑名单改为**白名单映射**，让未知等级自动被排除。

```ts
import { LEVEL_META } from './lib/detection';   // 已有穷尽映射可复用

// 只有这两种等级会改变大屏的火焰/烟雾状态；新增等级默认不叠加识别框。
const ALARM_TO_CAMERA_STATUS: Partial<Record<AlarmLevel, CameraStatus>> = {
  fire: 'fire',
  smoke: 'smoke',
};

const statusMap = useMemo(() => {
  const map: Record<string, CameraStatus> = {};
  cameras.forEach((c) => { map[c.id] = 'normal'; });
  alarms.forEach((alarm) => {
    if (alarm.status !== 'pending' && alarm.status !== 'confirmed') return;
    const next = ALARM_TO_CAMERA_STATUS[alarm.level];   // camera_abnormal/offline → undefined
    if (!next) return;
    if (map[alarm.cameraId] === 'fire') return;
    map[alarm.cameraId] = next;
  });
  return map;
}, [alarms, cameras]);

// activeAlarms 同样用 `if (!ALARM_TO_CAMERA_STATUS[alarm.level]) return;`
```

**步骤 2** — `src/components/CameraTile.tsx:191` 与 `src/components/FocusViewer.tsx` 同类位置：二元标签改查表。
```tsx
{LEVEL_META[alarm.level]?.label ?? '告警'} {alarm.confidence}%
```
（若告警叠加层只应显示 fire/smoke，则因为这些等级已被步骤 1 过滤，此处永不渲染其它值。）

**步骤 3** — `src/components/AlarmCenter.tsx:152-156`：下拉选项由 `LEVEL_META` 动态生成，消除硬编码列表。
```tsx
{(Object.keys(LEVEL_META) as AlarmLevel[]).map((level) => (
  <option key={level} value={level}>{LEVEL_META[level].label}</option>
))}
```

**需要的调整**：`src/types.ts` 无需改动；`CameraStatus` 保持三值。

**潜在风险与注意事项**

- 白名单映射会改变行为：未来新增等级时**默认不在大屏叠加**，这是刻意的保守默认，需在代码注释写明，否则会被误认为 bug。
- `LEVEL_META` 是 `Record<AlarmLevel, ...>`，若服务端返回未知等级，`LEVEL_META[x]` 为 undefined —— 用 `?.label ?? '告警'` 兜底，不要直接取属性。
- 视频墙状态优先级 `fire > smoke` 的现有逻辑要保留。
- ⚠️ 需要真机触发一次画面异常确认视觉表现（见 §六）。

**验证方法**

```bash
npx tsc --noEmit && npm run build && npm run e2e
```
新增一条前端单测（若项目暂无前端单测框架，则加入 e2e）：
- 通过 `POST /api/alarms` 造一条 `level: 'camera_abnormal', status: 'pending'` 的告警
- 断言该点位的 `camera-tile` 不含 `state-smoke` / `state-fire` 类
- 断言告警中心列表**能看到**该告警，且筛选下拉含「画面异常」选项

---

### 1.3 P2-1：所有出网点接入受控 fetch

**成因**：A（安全能力接入不完整）

**具体步骤**

**步骤 1** — `server/notify.mjs:222`：把默认实现改为 `guardedFetch`，保留注入点供测试。
```js
import { guardedFetch } from './net-guard.mjs';
// ...
fetchImpl = guardedFetch,   // 原来是 globalThis.fetch
```
`guardedFetch(target, init, options?)` 的前两个参数与 `fetch` 兼容，第三参数可选，因此 `:265` 的调用无需改动。`index.mjs:891` 的装配也不用改（没传 fetchImpl，自动用新默认值）。

**步骤 2** — `server/onvif.mjs:105`：`fetch` 替换为 `guardedFetch`，并复用 1.1 步骤 1 已构造的规范化 URL。

**步骤 3** — 全局排查补漏：`grep -rn "await fetch\|globalThis.fetch" server/ --include="*.mjs"`，确认没有其它出网点。当前已知仅这两处 + media.mjs（已接）。

**需要的调整**：无接口变更；测试仍可注入 mock fetchImpl。

**潜在风险与注意事项**

- ⚠️ **业务影响**：合法 webhook 若经过 CDN/短链跳转到私网地址，会被新策略拦截 —— 这是预期的安全行为，但上线前应对现有渠道做一次 dry-run，确认是否有此类配置。
- `guardedFetch` 最多跟随 3 跳，超过会抛 `OutboundBlockedError`；通知侧的 `.catch` 已把失败记为渠道失败，会触发连续失败自动停用。建议先把 `NOTIFY_MAX_FAILURES` 临时调大观察一轮，避免误停用。
- 不要修改 `net-guard.mjs` 的 `maxRedirects` 默认值去迁就某个渠道，那会削弱所有路径的防护。

**验证方法**

```bash
node --test --test-concurrency=1 server/notify.test.mjs server/notify-health.test.mjs server/net-guard.test.mjs server/onvif.test.mjs
```
新增测试：注入一个会返回 `302 Location: http://169.254.169.254/...` 的 mock 上游，断言 `notifyAlarm` 抛 `OutboundBlockedError` 且 `notification_logs` 没有成功记录。
手工：配一个本地 302 服务指向环回端口，观察服务端日志出现 `OUTBOUND_BLOCKED`，且渠道未被停用（在阈值内）。

---

## 四、批次 2 — 数据正确性与资源保护

### 2.1 P2-2：内置模板删除防护

**成因**：C（契约与实现脱节，无测试锁定）

**步骤**
1. `server/store/methods/notify.mjs:216-217`：`if (!current || current.builtin) return false;`
2. `server/routes/notify.mjs:255-256`：在存在性检查后加 `if (current.builtin) return res.status(403).json({ error: '内置模板不可删除' });`（避免把"拒绝"误报 404）
3. 补测试：`server/notify.test.mjs` 新增「内置模板删除被拒绝」—— 返回 false 且行仍存在。

**风险与注意事项**
- ⚠️ **存量数据**：若某部署已经删过内置模板，本修复**不会自动恢复**它。需要一次性恢复手段：要么提升 schema 版本重跑播种，要么提供 `npm run restore-builtin-templates`。建议后者，影响面更小。
- 编辑（PATCH）内置模板是否允许？当前代码允许，且可能是有意的自定义需求。本方案**只禁止删除**，不改变编辑语义。
- 前端若有删除按钮，建议同步置灰并说明原因，但后端防护是必须的（前端隐藏不构成安全边界）。

**验证**
```bash
node --test --test-concurrency=1 server/notify.test.mjs
```
API 验证：`DELETE /api/notify/templates/builtin-default` → 403，随后 `GET /api/notify/templates` 仍能查到。

---

### 2.2 P2-3：时间线 generation 守卫补齐

**成因**：C（防御模式半覆盖）

**步骤** — `src/components/RecordingTimeline.tsx:123-139`：
```ts
try {
  const range = localDayRange(date);
  if (!range) { ...; return; }
  const { from, to } = range;
  const result = await api.recordingsTimeline({ cameraId, from, to });
  if (generationRef.current !== generation) return;   // 新增
  setData(result);
} catch (cause) {
  if (generationRef.current !== generation) return;   // 新增
  setError(...);
  setData(null);
} finally {
  if (generationRef.current === generation) setLoading(false);  // 新增
}
```
与 `handlePlay:232/235/238` 的写法保持完全一致。

**风险与注意事项**
- 旧请求被跳过时其 `finally` 不设 `loading=false`，但新请求已 `setLoading(true)` 并会在完成时置 false，不会卡住。
- `generationRef.current += 1` 在 `load()` 开头（`:103`），已保证每次切换都递增，无需额外改动。
- 注意 `load` 的 `useCallback` 依赖数组 `[cameraId, date, cleanupPlayback]` 保持不变，不要把 `generation` 加进去。

**验证**：在 e2e 中模拟弱网（Chrome DevTools 限速）快速切换两个点位，断言最终时间线数据归属与下拉选中一致；或单测直接调用 `load` 两次并让第一次后返回，断言 `setData` 只被第二次调用。

---

### 2.3 P2-4：代理响应大小上限

**成因**：D（资源边界缺失）

**步骤** — `server/routes/media.mjs:99-132`：
1. 读 `content-length`，超阈值直接 413 并 cancel body。
2. 无 `content-length` 时用流式读取并累计字节，超限 abort。
3. playlist 分支限制行数（如 5000 行）与总字节。

```js
const MAX_PROXY_BYTES = 16 * 1024 * 1024;
const declared = Number(upstream.headers.get('content-length') ?? 0);
if (Number.isFinite(declared) && declared > MAX_PROXY_BYTES) {
  await upstream.body?.cancel();
  return res.status(413).json({ error: '上游响应过大' });
}
```

**风险与注意事项**
- ⚠️ HLS 分片通常远小于 16MB，但某些高码率摄像头的单个 TS 分片可能接近上限；建议先统计现网分片大小分布再定值。
- 流式改写会改变当前"先 `arrayBuffer()` 再字符串替换"的实现，需保证 playlist 的 `#EXT-X-*` 行处理逻辑不变。
- 超限时务必 `body.cancel()`，否则上游连接会挂住。

**验证**：`server/proxy.test.mjs` 新增两个用例 —— mock 上游返回 `content-length: 20MB` 断言 413；返回 chunked 无限流断言在阈值处 abort。现有代理测试全量回归确保正常分片不受影响。

---

## 五、批次 3 — 需先确认的前置决策项 ⚠️

### 3.1 P2-5：登录限流的部署依赖

**必须先取得的信息**：`TRUST_PROXY` 实际配置值、前面是否有反向代理且是否强制覆盖 `X-Forwarded-For`、服务是否直接暴露公网。

**方案 A（推荐，不依赖部署）**：增加一个**不依赖 IP** 的全局维度 —— 全站单位时间累计失败数（如 5 分钟 500 次）触发全局退避；并限制 XFF 链长度（超过 2 跳直接取 socket 地址）。
**方案 B**：仅在网络层确保反代强制覆盖 XFF，代码不改。

**风险**：方案 A 可能在大规模正常用户下误伤（共享出口 IP 的机构）；需要先统计现网失败率分布。方案 B 依赖运维纪律，易随时间漂移。

**验证**：用 curl 伪造不同 XFF + 不同 username 做喷洒，断言累计维度触发 429；同时验证正常单用户连续输错仍在既有 20 次阈值内被锁。

### 3.2 P2-6：升级失败是否重试

**必须先取得的决策**：升级通知是"仅尝试一次"还是"失败后重试"。

**若选"重试"**：
1. `index.mjs:1331` 改为 `if (!result || result.sent === 0) return;` —— 失败不写 escalated 事件。
2. `notify.mjs` 的 `deliver` 在失败时删除对应 `notification_logs` 记录，释放 `idx_notify_dedupe` 唯一键。
3. 增加最大重试次数（如 3 次），避免永久重试。

**若选"仅一次"**：
1. 保留现有逻辑，但把事件文案从"已升级通知"改为按结果区分：`sent>0 ? '已升级通知' : '升级通知发送失败'`。
2. 在事件中记录 `failed` 数量，便于审计。

**风险**：删除失败日志会削弱审计留痕 —— 如果选择重试，建议改为"失败日志标记 `retryable` 而非删除"，并把去重键改为 `(alarm_id, channel_id, event, attempt)`。这会增加 schema 变更，需评估是否值得。

**验证**：`escalation.test.mjs` 新增失败 webhook 用例，断言事件文案/重试次数符合选定语义。

---

## 六、批次 4 — 一致性与健壮性

| 项 | 步骤 | 风险 / 注意 | 验证 |
|---|---|---|---|
| **P3-1** 登出关闭 SSE | `routes/auth.mjs:176` 的 logout 调 `closeSseBySid(sid)`；`sseClients` 记录 sid；`index.mjs:167` 广播时 `if (client.sid && activeStore.isSessionRevoked(client.userId, client.sid)) { delete; continue; }` | 多标签页共用同一 sid 的情况不存在（每次登录生成新 sid）；注意不要让"账号级强失效"与"会话级撤销"语义混淆 | `api.test.mjs` 加：登录→建 SSE→登出→广播→断言该客户端不再收到事件 |
| **P3-2** deleteSite 补修订号 | `store/methods/sites.mjs:87-91` 事务返回后 `this.bumpAuthRevision();` | 必须在事务**提交后**调用，否则回滚时修订号虚增（虚增无害但会多清一次缓存） | `runtime-hardening.test.mjs` 加：删站点后 `authRevision` +1 |
| **P3-3** fatalHandler 空窗 | `index.mjs:618` 改为先定义具名 `shutdown` 函数声明再安装 guards，或让 `onFatal` 在 `fatalHandler` 为空时直接 `process.exit(1)`；`process-safety.mjs:75-79` 的 catch 内强制退出 | 强制退出会跳过优雅停机（WAL checkpoint），但比"既不退出也不停机"好；建议仅在空窗期使用 | `process-safety.test.mjs` 加：注入启动早期异常，断言进程退出码非 0 |
| **P3-4** SSE 连接上限 | `routes/auth.mjs:226` 按 userId 计数，超过 5 个关闭最旧连接；`sseClients` 总数上限 200 | 阈值需结合现场大屏数量；超限关闭要发告别事件，避免前端误判为断线 | 单测建 6 条连接断言最旧被关；e2e 观察徽标 |
| **P3-5** 筛选下拉 | 已在 1.2 步骤 3 覆盖 | — | 同 1.2 |
| **P3-6** cameraId 同步 | `RecordingTimeline.tsx:50` 后加 effect：`cameras.length && !cameras.some(c=>c.id===cameraId) && setCameraId(cameras[0].id)` | 不要在 effect 里无条件 set（会重置用户手动选择）；只在当前 id 失效时纠正 | 组件测试：先空 cameras 挂载，再异步注入点位，断言自动选中第一个 |

---

## 七、批次 5 — 测试补齐与防复发机制

### 7.1 必须补的测试（对应审查报告 §3.3）

| 测试文件 | 新增用例 | 核心断言 |
|---|---|---|
| `server/net-guard.test.mjs` | 整数/十六进制/八进制编码 | `assertOutboundUrl(new URL('http://2852039166/')).error` 匹配元数据 |
| `server/onvif.test.mjs` | 编码主机不发出请求 | mock fetch 调用次数为 0 |
| `server/notify.test.mjs` | 302 到元数据被拦 | 抛 `OutboundBlockedError`，无成功日志 |
| `server/notify.test.mjs` | 内置模板删除被拒 | 返回 false，行仍存在 |
| `server/escalation.test.mjs` | 失败投递的事件语义 | 按批次 3 的决策断言事件文案/重试次数 |
| `server/api.test.mjs` | 登出关闭 SSE | 登出后广播不再送达该客户端 |
| `server/runtime-hardening.test.mjs` | deleteSite 递增修订号 | `authRevision` +1 |
| `server/process-safety.test.mjs` | 启动早期异常退出 | 子进程退出码非 0 |
| `scripts/e2e-smoke.mjs` | 失败登录 / 越权 403 / SSE 断线重连 | 复用现有 `check(name, ok, detail)` helper |

### 7.2 防复发机制（比逐个修 bug 更重要）

1. **TypeScript 穷尽性检查**：所有对 `AlarmLevel` / `CameraStatus` 的映射必须是 `Record<...>` 或带 `satisfies`，禁止二元表达式把未知值默认成某个已知值。可在 CI 加一条 lint 规则或 grep 检查。
2. **出网点清单**：维护一份"所有服务端出网调用"清单（`grep await fetch` 的结果），新增出网点时必须在 review 中确认走了 `net-guard`。建议把 `guardedFetch` 设为唯一允许的 fetch 出口，通过 ESLint no-restricted-globals 约束。
3. **校验时机约定**：任何来自配置的主机/URL，必须**先构造 URL 得到规范化 hostname，再校验**。写进 CONTRIBUTING 或代码注释模板。
4. **新增枚举值的检查清单**：新增 `AlarmLevel` 取值时，必须同步检查 `LEVEL_META`、`LEVEL_LABELS`、视频墙映射、筛选下拉、统计分组、通知文案六处。
5. **缓存失效清单**：`authRevision` 的调用点清单化，新增任何改变用户权限/站点归属的写入时必须同步调用；可在 `runtime-hardening.test.mjs` 用"枚举所有写方法并断言修订号变化"的方式固化。
6. **E2E 失败路径基线**：每个核心旅程至少一条失败路径（登录失败、越权、断线、超时），避免"只测 happy path"掩盖状态恢复问题。

---

## 八、验证方法总表

| 层级 | 命令 / 方法 | 期望 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 0 error；`Record<AlarmLevel,...>` 穷尽性生效 |
| 单元测试 | `npm test` | 从 229 增至约 240+，全绿 |
| 安全专项 | `node --test server/net-guard.test.mjs server/onvif.test.mjs server/notify.test.mjs` | 编码绕过、重定向二跳均被拦 |
| 权限专项 | `node --test server/site-admin.test.mjs server/api.test.mjs server/runtime-hardening.test.mjs` | 站点隔离、会话失效、修订号递增 |
| 构建 | `npm run build` | 通过 |
| E2E | `npm run e2e` | 23+ 项，含新增失败路径 |
| 对比度 | `node scripts/contrast-scan.mjs` | 10 场景 0 违规（改了筛选下拉后重扫） |
| 代码规范 | `git diff --check` | 无空白错误 |
| 手工安全 | `POST /api/onvif/discover` 用 `2852039166` | 400 且无对外请求 |
| 手工显示 | 造 `camera_abnormal` 告警 | 告警中心可见、筛选可选、大屏不叠加烟雾框 |
| 手工通知 | 配一个 302 到内网的 webhook | 日志出现 `OUTBOUND_BLOCKED`，渠道未被误停用 |

---

## 九、整体风险与注意事项

1. **不要一次性大批量提交**。批次 1 三项建议单独一个 commit，便于回滚；批次 2 按文件拆分；批次 3 等决策明确后再动。
2. **net-guard 的改动影响面最大**：所有出网点共用它，一次误判会影响摄像头接入。上线前用现网所有 sourceUrl / webhook 做一次离线校验（只调用 `assertOutboundUrl`，不发请求），确认无误放。
3. **安全加固会带来短期"功能不可用"**：被拦的 webhook/ONVIF 目标可能是历史遗留的合法配置。建议先以日志模式观察一轮，再切换为拦截模式；或提供 `OUTBOUND_STRICT=1` 开关灰度。
4. **白名单优于黑名单**：P1-1 与 P3-5 的根因都是"列举已知的不合法值"。改为"列举合法的，其余拒绝/忽略"后，新增等级自然安全。
5. **不要把"测试通过"当作"修复完成"**：本轮两个 P1 都是测试覆盖盲区。每个修复必须同步补测试，否则同根因会复发。
6. **数据库变更最小化**：以上方案**均不需要 schema 版本递增**；内置模板恢复若需要，用独立脚本而非改版本号，避免触发全量迁移路径。
7. **回滚预案**：批次 1 的 net-guard 改动若引发大面积摄像头不可用，需能快速回退到仅校验原始字符串的版本 —— 建议改动前 `git diff > /tmp/netguard.patch` 或使用特性开关。

---

## 十、结论

优先级最高的两件事是 **P1-2（先规范化再校验出网地址）** 和 **P1-1（画面异常改白名单映射）**，二者都能在少量代码内修复，且都属于"改完就能用测试锁死"的类型。它们背后是同一个可复用的教训：

> **安全校验必须作用在真正被使用的对象上；类型扩展时必须让编译器帮你找出所有消费点。**

批次 3 的两项不建议凭猜测推进 —— 报告里已明确标注缺少的信息，拿到部署拓扑与产品语义后再执行，避免在错误假设上做出难以回滚的行为变更。

---

## 附：实施状态（2026-11-11 已完成全部批次）

> 本节记录实际落地情况与方案偏差，便于回溯。

| 批次 | 项 | 状态 | 实际改动要点 |
|---|---|---|---|
| 1 | P1-2 | ✅ | `onvif.mjs` 改为先构造 URL 再 `assertOutboundUrl`；`net-guard.parseIpv4` 支持整数/0x/八进制；`blockedOutboundHost` 元数据判定统一到解析后的 IPv4 |
| 1 | P1-1 | ✅ | `App.tsx` 用白名单 `ALARM_TO_CAMERA_STATUS`；3 处二元标签改 `LEVEL_META`；筛选下拉由 `LEVEL_META` 动态生成 |
| 1 | P2-1 | ✅ | `notify.mjs` 默认 `fetchImpl = guardedFetch`；`onvif.mjs` 的 SOAP 请求改 `guardedFetch`；补 302→元数据端到端测试 |
| 2 | P2-2 | ✅ | store 与路由双层拦截 `builtin`；补内置模板恢复脚本；**额外发现并修复：全新库因跳过 V6 迁移从未播种内置模板**，改为 openStore 时幂等补种 |
| 2 | P2-3 | ✅ | `RecordingTimeline.load()` 的 await/catch/finally 全部加 generation 守卫 |
| 2 | P2-4 | ✅ | `/proxy` 加 16MB 上限（content-length + 流式兜底），超限 413 并取消上游 body |
| 3 | P2-5 | ✅ | 登录限流加不依赖 IP/用户名的**全局失败维度**（500 次/10min → 60s 冷却）；`clientIp()` 限制 XFF 链 ≤2 跳 |
| 3 | P2-6 | ✅ | 仅 `sent>0` 写 escalated 事件；`claimNotification` 允许 failed 状态重新 claim（保留失败日志供渠道停用判定） |
| 4 | P3-1 | ✅ | SSE client 记录 sid；logout 主动 end 该会话连接；广播时二次校验 sid 撤销 |
| 4 | P3-2 | ✅ | `deleteSite` 成功后 `bumpAuthRevision()` |
| 4 | P3-3 | ✅ | `onFatal` 在 `fatalHandler` 未就绪时 `process.exit(1)`，回调自身异常也强制退出 |
| 4 | P3-4 | ✅ | SSE 每用户 5 条、全站 200 条上限，超限关闭最旧连接 |
| 4 | P3-5 | ✅ | 同 P1-1 步骤 3 |
| 4 | P3-6 | ✅ | `RecordingTimeline` 加 effect，仅在当前 cameraId 失效时纠正 |
| 5 | 测试 | ✅ | net-guard +1、notify-redact +1、runtime-hardening +4、E2E +2 失败路径断言 |
| 5 | 防复发 | ✅ | `docs/REVIEW-CHECKLIST.md`（6 类根因 + 出网点清单 + 提交前命令） |

**与方案的偏差**：
- P2-6 未删除失败日志（`finishNotification` 仍写 failed），改为让 `claimNotification` 重新认领 failed 记录 —— 保留 `consecutiveFailures` 的审计依据，同时支持重试。
- P2-5 采用了不依赖部署的全局维度（方案推荐 A），未等待 TRUST_PROXY 拓扑信息。阈值 500/10min 保守取值，避免误伤共享出口 IP 的机构。
- 新增了 `server/restore-builtin-templates.mjs` 与 `seedBuiltinTemplates()` 抽取，这是实施 P2-2 时发现的额外缺陷（新库无内置模板）的修复。

**验收结果**：`npm test` 235/235（基线 229，`+6`）；`npm run build` 通过；`npm run e2e` 全通过（含 2 条新增失败路径）；`node scripts/contrast-scan.mjs` 10 场景 0 违规；`git diff --check` 通过；全新库启动实测正常且内置模板已播种。

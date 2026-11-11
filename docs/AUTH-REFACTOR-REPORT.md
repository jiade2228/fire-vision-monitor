# 账号管理 / 登录认证 / 权限控制 —— 系统性分析与重构报告

> 第三轮重构。基线：`npm test` 184/184 → 重构后 **213/213**（+29 条新测试）。
> 生产实例实测通过（V10 迁移、双会话登出隔离、账号级强失效、密码轮换）。

---

## 一、现状梳理：改造前的模块结构与职责划分

### 1.1 改造前的实际结构

```
server/index.mjs  (1977 行)  ← 认证/授权逻辑的「真身」
├── normalizeText()          文本归一化
├── publicUser()             用户脱敏投影（安全边界）
├── passwordHash()           scrypt 哈希
├── verifyPassword()         密码校验（含 dummyVerify 时序防护）
├── dummyVerify()            空跑 KDF
├── validUsername()          用户名规则
├── validatePassword()       密码规则
├── allowedSiteIdsFor()      站点可见范围
├── canAccessCameraSite()    相机站点鉴权
├── canAccessAlarmSite()     告警站点鉴权
└── clientIp()               客户端 IP
     │
     ├── 通过 deps 注入 → server/routes/auth.mjs    （认证接口）
     ├── 通过 deps 注入 → server/routes/users.mjs   （账号接口）
     └── 通过 deps 注入 → 其余 7 个路由模块

server/http/guards.mjs   (115 行)  requireAuth / requireRole / requireManager
server/http/session.mjs  (227 行)  令牌签发校验 + 登录限流
server/store/methods/users.mjs       账号持久化
server/schema.mjs        users 表 + site_members 表
```

### 1.2 职责划分的问题（重构前的 8 个结构性问题）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| S1 | **安全边界函数混在巨型模块里** | `publicUser` 定义在 `index.mjs`，是「哪些字段能离开服务端」的唯一闸门，却与 FFmpeg、录制、SSE 等完全无关的逻辑同居一个 1977 行文件 | 新增路由只要忘记调 `publicUser`，就会把 `salt`/`passwordHash` 直接吐给前端。闸门离危险代码太远 |
| S2 | **角色枚举 6 份副本** | `routes/users.mjs` 两处硬编码数组、`schema.mjs` 的 CHECK 约束与迁移兜底、`http/guards.mjs` 的 JSDoc、`types.mjs`、`src/lib/api.ts` | 加一个角色要改 6 个文件，漏改一处就出现「接口接受但 schema 拒绝」。更糟：`guards.mjs` 的 JSDoc 写的是 `'admin' \| 'manager' \| 'operator' \| 'viewer'` —— **`manager` 角色根本不存在**（`requireManager` 是守卫名，不是角色） |
| S3 | **权限判定有三种表达、无统一语义** | `requireRole('admin')`（仅全局管理员）、`requireRole('operator','admin')`（操作员+管理员）、`requireManager`（管理员**或站点管理员**） | 三者散落在 9 个路由文件共 40+ 处。「站点管理员到底能做什么」只能靠通读代码推断，无法回答 |
| S4 | **密码哈希有两份独立实现** | `index.mjs` 用 `promisify(crypto.scrypt)`，`reset-password.mjs` 用 `crypto.scryptSync(password, salt, 64)` | 任何一侧改 KDF 参数，另一侧就静默地让「刚重置的密码无法登录」。是定时炸弹 |
| S5 | **登出是「全端下线」而非「登出」** | `routes/auth.mjs` 的 logout 调 `store.bumpTokenVersion(user.id)`，而 `token_version` 写在 `users` 表上，是**账号级**的 | 用户在一个标签页登出，该账号在**所有设备、所有标签页**的令牌同时失效。监控大屏场景下等于「值守终端集体掉线」 |
| S6 | **令牌无服务端记录** | 令牌载荷只有 `{uid, v, exp}` | 无法「列出我的登录设备」、无法「踢掉某台设备」、泄露后无法精确撤销单个令牌 |
| S7 | **错误处理各写各的** | 每个路由自己 `res.status(4xx).json({ error: '...' })` | 登录失败文案口径不一（有的说「用户名或密码错误」，有的精确说「账号不存在」）；改一次文案要全局搜索 |
| S8 | **口令策略偏弱且无版本** | `validatePassword` 只要求 `length >= 8`；哈希串是裸 hex，**不记录算法与参数** | 无法升级 KDF 参数（改了参数老用户全体掉线）；弱口令（8 位纯数字）可通过 |

---

## 二、重构方案与实施

### 2.1 新的分层职责

```
server/auth/                    ← 新增：认证域独立层（不依赖 express）
├── roles.mjs       (275 行)   角色与能力矩阵（单一来源）
├── password.mjs    (273 行)   密码哈希/校验/格式版本/弱口令策略
├── identity.mjs     (80 行)   用户脱敏投影 + 文本归一化（安全边界）
└── errors.mjs      (128 行)   统一错误类型（对外文案 vs 内部原因）

server/http/                    ← 中间件层（依赖 express）
├── guards.mjs      (168 行)   requireAuth / requireCapability / 兼容层
└── session.mjs     (310 行)   令牌签发校验 + 会话登记 + 登录限流

server/routes/                  ← 接口层（只做参数校验与编排）
├── auth.mjs        (266 行)   认证接口
└── users.mjs       (245 行)   账号接口

server/store/methods/users.mjs  ← 持久化层
```

**依赖方向严格单向**：`auth/` 不依赖 express、不依赖 store；`http/` 依赖 `auth/`；`routes/` 依赖 `http/` 与 `auth/`；`store/` 不依赖任何上层。

### 2.2 统一的角色与权限模型

引入**能力（capability）**模型取代硬编码角色字符串。

**能力常量**（`server/auth/roles.mjs`）：

```
alarm:read  alarm:create  alarm:update  alarm:delete
camera:read camera:manage
site:read   site:manage
user:manage
notify:read notify:manage
system:read system:manage system:global_admin
audit:read  metric:read
```

**能力矩阵**（唯一来源）：

| 能力 | admin | operator | viewer | 站点管理员附加 |
|---|:---:|:---:|:---:|:---:|
| alarm:read / camera:read / site:read | ✓ | ✓ | ✓ | — |
| alarm:create / alarm:update | ✓ | ✓ | — | — |
| camera:manage / site:manage / notify:manage | ✓ | — | — | ✓ |
| user:manage / audit:read / metric:read / system:global_admin | ✓ | — | — | — |

**关键设计**：`system:global_admin` 独立于 `site:manage` —— 前者对应改造前 `requireRole('admin')` 的严格语义（仅全局管理员），后者对应 `requireManager`（管理员**或**站点管理员）。两者混为一谈会导致站点管理员越权删除站点。

**向后兼容**：`requireRole(...)` 与 `requireManager` **原样保留**，语义与改造前完全一致。新代码用 `requireCapability(CAPABILITIES.X)`。

**降级机制**（`resolveCapabilityGuard`）：`requireCapability` 是**可选** deps 项。旧调用方（既有测试、潜在集成方）只提供 `requireRole`/`requireManager` 时，按 `CAPABILITY_LEGACY_GUARD` 还原改造前的守卫语义 —— `manager` 类能力回落到 `requireManager`（保住站点管理员），`role` 类回落到 `requireRole(...)`。两者都缺失时一律 403，**绝不静默放行**。

### 2.3 会话与令牌管理策略（两层撤销）

```
令牌载荷：{ uid, v, exp, sid }     ← 新增 sid（会话 ID）
```

| 层级 | 机制 | 触发场景 | 影响范围 |
|---|---|---|---|
| **会话级** | `auth_sessions` 表按 `sid` 撤销 | 用户登出当前标签页 | **仅当前会话** |
| **账号级** | `users.token_version` 递增 | 改密码 / 停用账号 / 改角色 | 该账号全部令牌 |

改造前只有账号级，所以「登出」= 全端下线。现在两层并存，且**语义与直觉一致**：登出=退出当前设备；改密码=全端下线。

**兼容**：
- `sid` 是可选字段，升级前的旧令牌（无 sid）仍然可用 → **升级不强制任何人重新登录**
- 未登记过的 `sid` 视为有效（同样为旧令牌兜底）
- `POST /api/auth/logout` 的响应体（`{ ok: true }`）与状态码（200）**完全不变**

**新增接口**：`GET /api/auth/sessions` —— 列出当前用户的活跃会话（为「我的登录设备」与精确踢设备打底）。

### 2.4 密码处理强化

**格式版本化**：`scrypt$N$r$p$salt$hash`

```
旧格式（裸 hex，无参数记录）  →  解析时回退到历史参数 N=2^14（改造前的 Node 默认值）
新格式（内含参数）            →  解析时用记录的参数
```

**这是本次重构最危险的陷阱**：改造前用 Node 默认参数（N=16384）算哈希，若校验时改用新参数（N=32768），**全部存量用户会集体无法登录**。已用专项测试锁定（`server/auth/auth.test.mjs` 的「存量密码（旧格式裸 hex）仍可校验」）。

**统一实现**：`reset-password.mjs` 原本自己调 `scryptSync`，与服务端是两份代码。现在复用 `auth/password.mjs` 的唯一实现，参数升级自动同步。

**弱口令策略**：保留 8 位下限（兼容既有契约），追加拒绝纯空白与单一字符重复。

### 2.5 统一错误处理

`server/auth/errors.mjs` 提供 `AuthError` 与工厂函数，把「状态码 + 对外文案 + 内部原因」三者绑定：

- **对外文案严格控制信息量**：登录失败恒为「用户名或密码错误」，账号不存在与密码错误**不可区分**（`internalReason` 只进日志）
- 鉴权失败恒为「当前账号没有此操作权限」，不透露被访问资源信息
- 响应体格式仍是 `{ error: string }`（**兼容旧客户端**），仅在提供 `code` 时额外附带 `code` 字段（纯新增）

---

## 三、修复的缺陷清单

| # | 严重度 | 缺陷 | 位置 | 修法 |
|---|---|---|---|---|
| D1 | **高** | 登出杀掉该账号所有设备/标签页的会话 | `routes/auth.mjs` logout | 改为按 `sid` 精确撤销当前会话；账号级强失效保留在改密码/停用/改角色 |
| D2 | **高** | 存量密码在 KDF 参数升级后集体失效 | `auth/password.mjs` | 旧格式哈希解析时回退到历史参数 N=2^14；新格式内含参数 |
| D3 | **高** | 密码哈希两份独立实现，参数可能漂移 | `reset-password.mjs` | 复用 `auth/password.mjs` 唯一实现 |
| D4 | **中** | 角色枚举 6 份副本，`guards.mjs` 的 JSDoc 甚至写了不存在的 `manager` 角色 | 全仓 | 收敛到 `auth/roles.mjs` 的 `ROLE_NAMES` |
| D5 | **中** | 权限判定三种表达并存，语义只能靠通读代码推断 | 9 个路由文件 | 能力矩阵 + `requireCapability`，兼容层保留旧 API |
| D6 | **中** | 安全边界函数 `publicUser` 与 FFmpeg/录制逻辑同居 1977 行文件 | `server/index.mjs` | 抽到 `auth/identity.mjs`，并提供 `isSensitiveUserObject()` 供测试审计 |
| D7 | **中** | 登录失败错误文案口径不一，存在账号枚举风险 | 各路由 | 统一 `auth/errors.mjs`，对外文案不区分失败原因 |
| D8 | **低** | 令牌无服务端记录，无法列出/撤销单个会话 | `http/session.mjs` | 新增 `auth_sessions` 表（V10 迁移）+ `GET /api/auth/sessions` |
| D9 | **低** | 密码策略仅要求 8 位，纯空白/单字符重复可通过 | `index.mjs` | 追加弱口令拒绝规则 |
| D10 | **低** | 账号删除后会话未失效 | `store/methods/users.mjs` | `deleteUser` 内一并撤销该账号会话 |

---

## 四、数据模型与配置变更

### 4.1 数据模型（V9 → V10）

**新增表**（纯新增，不改任何既有表结构，升级无需停机、不丢数据）：

```sql
CREATE TABLE IF NOT EXISTS auth_sessions (
  sid         TEXT PRIMARY KEY,      -- 会话 ID，与令牌载荷 sid 对应
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,              -- 非空即已撤销
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_auth_session_user    ON auth_sessions(user_id, created_at DESC);
CREATE INDEX idx_auth_session_expires ON auth_sessions(expires_at);
```

**`users` 表**：**无变更**。`token_version` 语义保持不变（账号级强失效）。

### 4.2 配置项

**无新增环境变量**。所有行为通过代码默认生效。

---

## 五、向后兼容性说明

| 方面 | 状态 |
|---|---|
| HTTP 接口路径 | **全部不变**（`/api/auth/login`、`/api/auth/logout`、`/api/auth/me`、`/api/auth/status`、`/api/users*` 等） |
| HTTP 方法与状态码 | **全部不变** |
| 响应体格式 | **不变**（仍是 `{ error }`；仅新错误类型额外带 `code` 字段，纯新增） |
| `requireRole` / `requireManager` | **保留**，语义与改造前逐用户等价（13 条等价性测试锁定） |
| `registerXxxRoutes(app, deps)` 调用约定 | **向后兼容**：`requireCapability` 为可选 deps，缺失时自动降级到旧守卫语义 |
| 数据库 | **纯新增表**，不改既有表结构与列；存量数据零风险 |
| 存量密码 | **继续可用**（旧格式哈希按历史参数校验），登录后可自动升级为新格式 |
| 存量会话 | **继续有效**（旧令牌无 `sid`，视为未撤销） |
| 前端 | **无改动**（本轮未触碰 `src/`，除 `api.ts` 的可选字段扩展） |

---

## 六、分阶段实施步骤与风险点

### 已完成（本轮）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 建立 `server/auth/` 领域模块（roles / password / identity / errors） | ✅ |
| P2 | 引入能力模型与 `requireCapability`，迁移 9 个路由文件 | ✅ |
| P3 | 会话登记表（V10 迁移）+ 登出语义修正 | ✅ |
| P4 | 密码格式版本化 + 统一实现 + 弱口令策略 | ✅ |
| P5 | 统一错误类型与错误码 | ✅ |
| P6 | 补测试（能力等价性 13 条 + 认证域 16 条）并全量验证 | ✅ |

### 后续建议（未执行，需产品决策）

| 阶段 | 内容 | 风险点 |
|---|---|---|
| P7 | **自定义角色**：`roles` 表 + `role_permissions` 表，取代硬编码枚举 | 需要定义「内置角色 vs 自定义角色」的升级路径；现有 3 个角色迁移为内置角色；`users.role` 从枚举改为外键 |
| P8 | **MFA（TOTP）**：`users` 加 `mfa_secret`/`mfa_enabled`；`/api/auth/login` 加二次验证分支 | 需要密钥加密存储（可复用 `secrets.mjs` 的 SecretBox）；需要前端扫码绑定流程；恢复码机制 |
| P9 | **登录限流持久化**：把三维限流从进程内 Map 移到 SQLite | 单实例下 Map 已够用；持久化会带来写放大，需评估 |
| P10 | **权限审计增强**：记录每次权限判定（谁访问了什么资源） | 审计表体积增长，需配套保留策略 |
| P11 | **前端权限模型同步**：`src/lib/api.ts` 的 `UserRole` 改为从后端能力列表派生 | 当前前端硬编码 `role === 'admin'` 判断（约 8 处），引入自定义角色后需改为能力判断 |

### 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **KDF 参数升级** | 参数变更瞬间，所有用旧格式且未登录的用户将无法登录 | 已实现：旧格式按历史参数校验；登录成功后自动重哈希为新格式。若未来再改参数，必须保留 LEGACY_SCRYPT_PARAMS |
| **能力矩阵调整** | 误改矩阵会静默放宽/收紧权限 | `roles.test.mjs` 的等价性测试锁定与改造前一致；任何矩阵调整必须同步更新该测试 |
| **站点管理员权限漂移** | `site:manage` 与 `system:global_admin` 混淆会导致越权删站点 | 两者在矩阵中严格分离，并有专项测试 |
| **多实例部署** | `auth_sessions` 是服务端状态，多实例需共享存储；登录限流仍是进程内 Map | 当前架构本就要求单实例（`data/instance.lock`）；水平扩展前需一并处理 |

---

## 七、验证结果

| 项目 | 结果 |
|---|---|
| `npm test` | **213/213 通过**（基线 184 → +29） |
| `npm run build` | 通过（tsc --noEmit + vite build，79 modules） |
| `npm run e2e` | **23/23 通过** |
| `git diff --check` | 无空白错误 |
| 生产实例实测 | V10 迁移执行成功（schema 9→10，`auth_sessions` 就位）；双会话登出隔离（A 401 / B 200）；账号级强失效（改密后 401）；密码轮换（旧密码 401，新密码 200）；`reset-password` 复用统一实现后登录正常 |

### 新增测试

- `server/auth/roles.test.mjs`（13 条）—— 能力矩阵与改造前 `requireRole`/`requireManager` 的**逐用户等价性**
- `server/auth/auth.test.mjs`（16 条）—— 密码格式版本化、**存量密码兼容**、弱口令策略、脱敏投影、错误文案统一、会话登记与两级撤销、V10 迁移可重入

# ADR-0022：账号停用即时吊销采用 users.tokenVersion 版本戳（而非会话表/Refresh Token）

**状态（Status）**：Accepted（M2 落地，S2 机制 / S6 闭环，2026-09-14）
**作者**：后端（mvp-dev-expert-team-backend）
**编号说明**：0011-0020 由企业版架构 §10.4 分配、0021 已用于 esbuild 扁平构建；M2 三份组织决策顺延使用 0022/0023/0024。
**上游依据**：`docs/_archive/originals/planning-phase2-M2-implementation-plan.md` §5-D（鉴权收口）、§7-S2/S6、§9 DoD-1
**关联**：ADR-0003（裸机单实例拓扑）、ADR-0008（容量与多实例升级阈值）；M6 个人访问令牌（PAT）为独立凭据，不归属本机制

---

## 1. 背景（Context）

M2 之前，`/api/*` 的鉴权是「无状态 JWT 仅验签」：`getUserId` 只校验 HS256 签名与
`userId`，不查库。这意味着 JWT 在 7 天有效期内无法被服务端主动作废——停用或删除一个账号后，
其已签发的 token 仍可继续访问，直到自然过期。企业版组织通讯录引入「停用成员」「一次性邀请
激活」后，必须满足 AC-M2-1：**停用成员后，其浏览器/嵌入页的下一次请求即被拒（401）**，且
重新激活要强制重登。

约束：
- 单实例 SQLite 部署（ADR-0003），无 Redis 等外部状态组件，不能引入会话存储基础设施；
- 存量用户持有的是「无状态 7 天 JWT」，升级不能把他们全部踢下线（平滑兼容）；
- 邀请账号（INVITED）持随机占位密码，不能靠改密码实现吊销；
- M2 规模 <=500 用户，管理面操作低频，吊销路径的写放大可忽略。

## 2. 候选方案

- **a) 服务端会话表（session/refresh token）**：每次登录落一行会话，停用即删/标失效。
  否决原因：要新增表与刷新端点、把现网「自包含 JWT」改成有状态会话，M2 改动面与回归风险最大；
  refresh token 轮换、多设备会话管理在单实例 500 人规模是过度设计。
- **b) 黑名单（jti 吊销列表）**：停用即把该用户在途 JWT 的 jti 加入黑名单。
  否决原因：现有 token 无 jti，且要为每个在途 token 维护条目、每请求查列表；无法表达
  「该用户此后签发的所有 token 一律失效」，重放/多设备语义繁琐。
- **c) 用户行版本戳 `tokenVersion`（采用）**：JWT payload 带 `tv`，鉴权时按主键点查
  users 一行比对版本；停用/重激活在写事务内 `tokenVersion += 1`，旧 `tv` 立即不等。

## 3. 决策（Decision）

采用 **c) 账号级版本戳**：

- `users.tokenVersion INTEGER NOT NULL DEFAULT 0`（M2/S1 只增加列）；签发的 JWT payload
  增加 `tv` claim，取值为签发时刻的用户行版本（`issueToken(userId, tokenVersion)`）。
- 鉴权共享核心 `resolveActiveAuth`（旧 `/api` 的 `getUserId` 与新 `/api/v1` 的
  `requireActiveUser` 复用同一实现）：验签 -> 按 PK 查 users 一行 ->
  `status='ACTIVE'` 且 `tokenVersion === payload.tv` 才放行；用户不存在 / 非 ACTIVE
  （DISABLED、INVITED）/ tv 不符 -> 解析为 null，端点统一 401。
- **平滑兼容**：存量无 `tv` claim 的旧 token 一律按 `tv=0` 处理；存量用户回填
  `tokenVersion=0`，故升级瞬间全部继续可用，零强制下线。
- 停用（`disableUserTx`）：单写事务内置 `status=DISABLED`、`disabledAt`、
  `tokenVersion += 1`；重新激活（`reactivateUserTx`）：`status=ACTIVE`、
  `disabledAt=NULL`、**再 `tokenVersion += 1`**——使停用期间的旧 token 在重激活后依然
  失效，强制用户用密码重新登录拿新 tv 的 token。
- 事务提交后调用 `invalidateAuthState(userId)` 主动失效同进程缓存（见下）。
- 登录状态分支先于密码比对：INVITED -> 403、DISABLED -> 401，再 bcrypt；否则邀请账号的
  随机占位密码会使任何登录恒 401，无法表达「未激活」。

### 3.1 默认零缓存与 TTL 口子

默认 `GX_AUTH_STATE_TTL_MS=0`：鉴权完全旁路进程内缓存，每请求一次主键点查，严格保证
「写库后下一次请求即生效」，无 TTL 延迟窗口。>0 时启用有界缓存，但所有吊销写路径
（停用/重激活）在事务后主动 `invalidateAuthState`，因此**同进程**即使开了短缓存仍是
下一次请求即 401。在拿到性能证据前保持默认 0。

### 3.2 与其他凭据的边界

- 本机制只管「用户 JWT 登录态」。M6 的个人访问令牌（PAT）/MCP 接入凭据是**独立凭据**，
  其吊销走各自的凭据表，不复用 `tokenVersion`；bump tv 不影响 PAT，反之亦然。
- 匿名公开外链（`/api/public/s/:token`）不绑定用户、不查 users 表，停用其创建者不影响
  外链可用性（由 public-share 特征测试锁定）。

## 4. 后果（Consequences）

正面：
- 实现极小：一列、一个 claim、鉴权多一次 PK 点查；无新表、无外部组件、无状态会话。
- 吊销即时且语义统一：停用、改密后强制失效（如需要）、重激活强制重登都收敛为「bump tv」。
- 旧 token 平滑兼容，升级不踢在线用户。

代价/边界：
- **多实例下不成立「跨进程即时」**：版本戳在共享库里是权威的，但 `invalidateAuthState`
  只能失效本进程缓存。默认 TTL=0 时每请求查库，多实例也正确；一旦某实例把 TTL 调到 >0，
  它会在 TTL 窗口内保留旧 tv。因此「开缓存 + 多实例」需要引入跨实例失效信号
  （如 workspace.policyVersion 订阅/发布），列入 ADR-0008 的多实例升级前置，M2 单实例不实现。
- 每请求一次 users 点查：主键索引、<=500 用户规模开销可忽略；S8 实测含该点查在内的
  管理面三接口并行仍为毫秒级（见 gate 基线）。

## 5. 验证证据

- `routes/v1/__tests__/auth-state.test.ts`：无 tv 旧 token 平滑通过；DISABLED 旧 token
  下次请求 getUserId=null、`/me` 401、`/v1/meta` 401；tv+1 旧 token 立即 401、新 tv 恢复；
  INVITED 持合法 token 也被拒。
- `routes/v1/org/__tests__/lifecycle.test.ts` 与 `ac-m2-1.adversarial.test.ts`：停用后旧
  token 对 `/api/auth/me` 与 `/api/v1/org/members` 的下一次请求（含第二次，模拟 iframe
  刷新）均 401 且带 `code=UNAUTHORIZED`；重激活后旧 token 仍 401、新登录 200。
- 代码锚点：`domain/org/authState.ts`（resolveActiveAuth/issueToken/invalidateAuthState）、
  `domain/org/lifecycle.ts`（事务内 bump）、`auth.ts`（状态分支与 401/403 机器码）。

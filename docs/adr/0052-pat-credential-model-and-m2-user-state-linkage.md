# ADR-0052：PAT 凭证模型与 M2 用户态联动

**状态（Status）**：Accepted（M6 计划 §10 第 2 条、§4.3（数据模型/校验顺序）、§5.1/§5.2 定稿；C-3/C-4 终审批准；S1 已过 PAT 基座门、S8 已过吊销即时门；2026-09-18 M6 出口归档）
**作者**：架构师 高见远（M6-S9 归档；实现由后端 贝洛奇 落地）
**上游依据**：M6-implementation-plan.md §4.3（:172-196）、§5.1（:281-286）、§5.2（:288-299）、§11 C-3/C-4（:443-444）、§10（:427）；SPEC-enterprise §6（:88 `personal_access_tokens`）、§5（:74 `/api/v1/pats`）
**关联**：ADR-0022（org tokenVersion 吊销——PAT 是独立凭据，不比对 tv）；ADR-0051（无状态 => 吊销即时生效）；ADR-0053（PAT scope 是闸门一粗筛，资源授权归 M4）；ADR-0037（authz 三态门）

---

## 1. 背景（Context）

M6 首版唯一凭证是 PAT（OAuth 只留扩展点、不实现）。作为一个"可长期持有的不透明令牌"，
必须回答四组问题：明文与库存形态（怎么存才不泄密）、scope 粒度（授权放在 token 里还是引擎里）、
有效期（是否允许永不过期）、以及**与 M2 用户态的联动**（用户被停用/删除后其 PAT 怎样即时失效，
重新激活是否恢复）。约束基线：令牌泄漏面最小、吊销即时性优先于查询性能、授权模型单一真源。

## 2. 决策（Decision）

### 2.1 形态：`gxpat_` + 32 字符随机，一次明文、库存 hash、常量时间比对

- 明文 = `gxpat_` 前缀 + `crypto.randomBytes(24).toString("base64url")`（随机段 **32 字符**，
  熵 192 bit；`pat/tokens.ts:12-14`）。前缀便于代码扫描/泄漏检测/客户端识别。
- **明文只在创建响应返回一次**；库存 `sha256(明文)` hex（`tokenHash @unique` 等值索引）。
  `GET /api/v1/pats` 永不回 `token` 或 `tokenHash`。
- 查不到 token 行时，对一个进程内固定的 dummy 摘要做一次等长 `timingSafeEqual`，抹平时序侧信道
  （`tokens.ts:79-89`）。

### 2.2 scope 六位粗档；资源级授权归 M4 引擎

- scope 常量**六位**：`record:read / record:write / doc:read / doc:write / canvas:read / canvas:write`
  （`tokens.ts:19-23`，C-2 定稿追加 `canvas:write`），与 M4 的 `RESOURCE_ACTIONS` 命名空间刻意分离、不混用。
  映射：`:read -> r`；`:write -> c,u,d`（引擎逐动作判定，写后回读仍需 `r`）。
- **PAT 不携带 ACL**：能访问哪些库/表/文档一律由 M4 权限引擎按 `userId` 现算。PAT 只表"这个人 +
  读写档位"，避免把授权模型复制一份进 token、且保证授权变更后令牌无法绕过引擎。

### 2.3 C-3 有效期：默认 90 天，可选 30/90/365 天与 null 永不过期

- 默认 **90 天**；可选 **30 / 90 / 365 天** 与 **null（永不过期）**；非法值 -> `PAT_EXPIRY_INVALID`（400）
  （`tokens.ts:26-29, 120-139`）。UI 对"永不过期"给强警示二次确认（M6-FE）。
- **`tokenPrefix` 仅存/展明文前 14 字符**（`gxpat_` 6 + 8 随机字符；`PAT_PREFIX_DISPLAY_LEN = 14`，
  `tokens.ts:16`），供列表辨识，**不可认证**——暴露 8 个随机字符不足以猜中 32 字符随机段。

### 2.4 C-4 用户停用同事务批量吊销；重新激活不恢复

- `lifecycle.disableUser` 的 `withWriteTx` 内**同事务批量**吊销该用户全部未吊销 PAT：
  `personalAccessToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })`
  （`lifecycle.ts:134-139`）。吊销**是终态**，可查询、可审计。
- **重新激活不自动恢复任何 PAT**（`lifecycle.ts:153-157`）：安全优先，需重新签发。
- 边缘再有**纵深防御**：认证通过后仍查 `users.status = ACTIVE`，非 ACTIVE（DISABLED/INVITED）一律拒
  （`authenticate.ts:69-70`）——即便某条 PAT 行未置 `revokedAt` 也拒。
- 用户**物理删除**：FK `onDelete: Cascade` 带走其 PAT（cascade 声明随迁移落 schema，与既有关系一致）。

### 2.5 lastUsedAt 进程内节流；JWT/OAuth 仅留扩展点

- `lastUsedAt` 走进程内 Map 按 patId 节流 **60s**，距上次落库 >60s 才 UPDATE（走 M1 `runSerialized`
  写队列），fire-and-forget 不阻塞认证（`patService.touchLastUsed`）。进程崩溃最多丢 60s 的显示精度，无安全影响。
- **JWT/OAuth 只留扩展点**：仅 `authenticate.ts` 保留"Bearer PAT 或 Bearer JWT"的分支注释；
  不预埋端点/表，`oauth` 表不建（ARCH §13-4 客户驱动）。
- **改密码 / tokenVersion 变化不杀 PAT**：PAT 是独立凭据，不比对 `tokenVersion`，与 ADR-0022 的
  会话吊销正交——要停用某枚 PAT 须走吊销动作，不是改密码。

## 3. 被否决的备选

1. **明文落库 / 回显全文**：库文件、备份、日志任一泄漏即等同凭据泄漏。定稿只存 hash、明文一次。
2. **把资源白名单放进 scope（per-base allowlist）**：等于把授权模型复制一份到 token，授权变更后
   token 无法即时反映；归 M4 引擎（spike §3.4）。
3. **`revoked` boolean**：用 `revokedAt` 时间戳，吊销时间本身有审计价值（`revoked = revokedAt != null`）。
4. **停用时不联动 PAT、只靠边缘 status 复核**：单点兜底不如"同事务落终态（可查可审计）+ 边缘复核"
   的双保险；定稿两者并存。
5. **重新激活恢复 PAT**：与被吊销的语义冲突；安全优先不恢复。
6. **每请求写真 `lastUsedAt`**：NAS 上写放大、占写队列；定稿 60s 进程内节流。

## 4. 后果（Consequences）

- 泄漏面收敛：库/日志/审计/列表只出现 `name / tokenPrefix（14 字符）/ 时间戳`；明文只出现在创建响应一次。
- 停用即时失效双保险（同事务 `revokedAt` + 边缘 status 复核），下一请求即 401（AC-M6-4）。
- 重新激活必须重签 PAT——运维文档须明示此姿态（runbook）。
- 吊销与授权正交：PAT 吊销 ≠ 用户改密码；改密码不牵连已发 PAT。
- 为 OAuth 留了最小扩展面（唯一一处分支注释），将来加 JWT 分支不扩散改动。
- 列表查询走 `tokenHash @unique` 等值索引 + `@@index([userId])`，量级小、无需额外缓存（首版不缓存
  认证结论，即时性优先）。

## 5. 验证证据

- 原语：`apps/api/src/mcp/pat/__tests__/tokens.test.ts`（生成/hash/常量时间/scope/有效期）、
  `pat/__tests__/patService.test.ts`（创建明文一次、列表只回元数据、非本人 404、节流）。
- 停用联动：`domain/org/lifecycle.ts:134-139`（同事务批量吊销）、`:153-157`（重激活不恢复）；
  S8 AC-M6-4（docs/baseline/m6-connectivity.md §4.4 吊销即时 401）。
- 401 口径（"查不到"三态响应体逐字节一致；revoked/expired/disabled 各自可辨识）：
  `transport/authenticate.ts:20-31`、`transport/mcpApp.ts:24-31`、m6-connectivity.md §6。
- 明文零泄漏：m6-connectivity.md §4.4（审计全文不含任一 PAT 明文及随机段）。
- REST 契约：`routes/v1/pats.ts`（§5.2 三端点）；C-3 错误码 `PAT_SCOPE_INVALID / PAT_NAME_INVALID /
  PAT_EXPIRY_INVALID`。

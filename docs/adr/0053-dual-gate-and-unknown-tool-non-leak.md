# ADR-0053：双闸门与 UNKNOWN_TOOL 不泄漏口径

**状态（Status）**：Accepted（M6 计划 §10 第 3 条、§4.4 定稿；R-MCP-1 强制架构；S3 已过双闸门门、S8 已过 AC-M6-1/2 与 IDOR 对抗；UNKNOWN_TOOL 措辞按 S8 实测修正；2026-09-18 M6 出口归档）
**作者**：架构师 高见远（M6-S9 归档；实现由后端 贝洛奇 落地）
**上游依据**：M6-implementation-plan.md §4.4（:198-218）、§3-3/§3-5（:114,116）、§10（:428）；spike-mcp-transport.md §4（:261-325，实测）；ARCH-enterprise §8.2（:779）；PRD-enterprise MC2/MC6
**关联**：ADR-0019（总纲：tools/list 按账号动态过滤 + 执行期强制鉴权双闸门）；ADR-0037（authz 三态门）；ADR-0038/ADR-0046（先收敛后召回，record.search 复用）；ADR-0052（PAT scope 粗筛）；ADR-0054（401 语义）

---

## 1. 背景（Context）

`tools/list` 只解决"UI 可发现性"，**不是安全边界**。以下越权场景只有执行期判定挡得住（spike §4.2）：
客户端的 IDOR / 直传无权资源 id、绕过 list 直调被裁工具、list 之后权限被收回、字段级越权。
同时，"工具对该主体不可见"与"工具真的不存在"的响应必须不可区分，否则会泄漏工具存在性
（AC-M6-1）。此外有一条授权模型单一真源的约束：MCP 不得复制授权逻辑、不得接 M4 之前的旧守卫。

## 2. 决策（Decision）

### 2.1 闸门一 = 按权限动态注册（tools/list 的物理边界）

- `buildServer(subject)` 时，对每个工具按"该工具所需动作"求一次可访问集：
  `port.listAccessibleResources(family, meta.actions)`；**PAT scope 粗筛 + M4 族可见集非空**，
  二者皆过才 `server.registerTool(...)`（`tools/registry.ts:192-217`）。
- **动作敏感**：读工具查 `["r"]`、写工具查 `["c"|"u"|"d"]`；`record.search` 在 M5 off 时因运行期
  可用性门（`meta.available`）缺席，即为"可发现性随环境/权限变化"的实证。
- 工具的 schema 枚举/字段随权限收窄（`fieldCapability`）；无任何可访问资源 => 该工具对客户端**不存在**。
- **引擎故障不得让 /mcp 500**：某族可见集求解抛错时该族工具缺席 + 记 metric，其余族不受影响
  （`registry.ts:43-61`）。

### 2.2 闸门二 = 执行期逐资源裁决（service 层强制点）

- 每个 tool handler 只编排，**service 首行**强制鉴权：`port.can(subject, action, {kind, id})` 或
  scope 接口判定（如 `tools/table.tools.ts:29-32`、`tools/record.tools.ts:23-25`）。强制点在 service
  层，REST 与 MCP 物理上无法绕过。
- **MCP 只走 M4 新引擎、不接 M4 之前的旧 `guards.ts`**：handler/service 一律不 import
  `requireCan*`、不裸查 `prisma` 做资源判定（`registry.ts:12` 铁律）。代码评审 grep `mcp/**` 内
  `requireCan|from "../../guards"|prisma\.` 命中即打回（仅 PAT 自身存储与审计例外，且不涉资源授权）。

### 2.3 UNKNOWN_TOOL 口径（S8 实测修正后的精确措辞）

- 闸门一未注册的工具被直调时，SDK 在调用回调前即拒，返回**同文案模板 + 同错误码**（`-32602`，
  HTTP 200），形如 `MCP error -32602: Tool <name> not found`。
- **精确措辞纪律**：工具名占位**由客户端传入决定**，故"字面逐字节相等"在构造上不可能。本 ADR 与后续
  文档一律写"**同文案模板 + 同错误码，工具名占位归一化后逐字节相等**"，**不再写"逐字节一致"**。
- **安全性结论不变：存在性零泄漏**（同模板、同码、同 HTTP 200）。S3 以 golden 把"因无权限而未注册"
  与"真不存在的工具名"两条响应锁死，永不互换。
- 该路径不经过 registry 信封，**UNKNOWN_TOOL 审计在 transport 层补记**（`streamableHttp.ts:79-91`
  预读 `tools/call` 的 tool 名，与"实际注册集"比对后补审计）——保证"工具未知时也能记下客户端传来的
  tool 名与 patId"（计划 §409）。

### 2.4 拒绝码二分：UNKNOWN_TOOL 与 FORBIDDEN_*

- ① 工具**不可见**却直调 -> `UNKNOWN_TOOL`（-32602，不泄漏存在性，见 2.3）。
- ② 工具**可见**但本次资源/字段无权 -> `isError:true` + `{ code: "FORBIDDEN_RESOURCE" | "FORBIDDEN_FIELD", ... }`
  （可解释，供 AI 排障）。其中：
  - `FORBIDDEN_RESOURCE` 覆盖"**无权 / 不存在不可区分**"（防 IDOR 枚举），文案如
    "无权访问该表（或该表不存在）"（`record.tools.ts:25`）；
  - `FORBIDDEN_FIELD` 是**参数越权二次拦截**——工具与资源都有权，但参数触碰了不可见/不可写字段
    （`record.tools.ts:158,190`），绝不静默丢弃。

## 3. 被否决的备选

1. **只靠 `tools/list` 过滤、不做执行期 enforce**：list 是快照不是边界；IDOR、绕过 list 直调、权限收回
   都挡不住（spike §4.2 逐条演示）。否决。
2. **MCP handler 直接复用旧 `guards.ts`（requireCanView / requireCanEditData…）**：旧五角色模型与新引擎
   语义不同，会形成双源授权；MCP 物理隔离只认 M4 引擎。否决。
3. **对"工具不可见"与"无权资源"返回同一文案**：会让有权用户无法排障，也不必要——存在性零泄漏已由
   UNKNOWN_TOOL 口径独立保证。定稿二分。
4. **继续用"逐字节一致"描述 UNKNOWN_TOOL**：S8 实测证伪（工具名内嵌），措辞改为"同模板 + 同码、
   名字占位归一化"。否决旧措辞。

## 4. 后果（Consequences）

- 只读凭证的 `tools/list` 物理上没有写/删/admin 工具；直调被裁工具零存在性泄漏（AC-M6-1）。
- 授权模型单一真源（M4）；MCP 不复制授权、不读旧表、不改旧路由。
- 无权的资源 id 直传与"不存在"不可区分（IDOR 零泄漏，四族 base/doc/canvas-read/canvas-write 各一）。
- 措辞纪律落到团队文档：涉及 UNKNOWN_TOOL 的说明统一写"同文案模板 + 同错误码"。
- 引擎故障时工具缺席而非 500，故障被隔离在该族，MCP 端点整体可用性不被单族故障拖垮。

## 5. 验证证据

- 闸门一实现：`tools/registry.ts:192-217`；只读集快照 docs/baseline/m6-connectivity.md §4.1（精确 7 件）、
  §3.2（M5 off 时 `record.search` 缺席）。
- 闸门二/拒绝码：`tools/record.tools.ts`、`tools/doc.tools.ts`、`tools/canvas.tools.ts`；
  m6-connectivity.md §4.2（参数越权 -> `FORBIDDEN_FIELD` 二次拦截）。
- UNKNOWN_TOOL 措辞：m6-connectivity.md §4.1 口径澄清、§8-3（"逐字节一致"只能在工具名归一化后成立）。
- IDOR：m6-connectivity.md §5（隐藏 vs 不存在逐字节一致，四族各一 + 同族补证 + 反例护栏）。
- golden 测试：`apps/api/src/mcp/transport/__tests__/m6-s3-gate.test.ts`、`tools/__tests__/registry-gate.test.ts`。
- 不接旧守卫：代码评审 grep 规则（§3-3）。

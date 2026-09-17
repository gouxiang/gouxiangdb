# ADR-0054：/mcp 11MB 豁免与 patId 独立限流内聚 mcpApp

**状态（Status）**：Accepted（M6 计划 §10 第 4 条、§0-2、§5.2/§5.3 定稿；C-1 终审批准三档默认值；S2 已过传输门、S8 已过 §460 三项与 401 六态；401 语义由项目负责人于 2026-09-17 M6 出口前拍定，保持现状；2026-09-18 M6 出口归档）
**作者**：架构师 高见远（M6-S9 归档；实现由后端 贝洛奇 落地）
**上游依据**：M6-implementation-plan.md §0-2（:18）、§5.2（:288-299）、§5.3（:301-304）、§11 C-1（:441）、§6（:315-317）、§10（:429）；spike-mcp-transport.md §0-5（:20-22，实测复现 413）；docs/baseline/m6-connectivity.md §6/§7/§8-4
**关联**：ADR-0051（/mcp 直桥）；ADR-0052（PAT 与认证顺序）；ADR-0053（双闸门）；ADR-0003（裸机部署与反代）

---

## 1. 背景（Context）

spike 实测复现两处部署坑，M6 必须处理，但不得扰动既有路径行为：

1. **全局 1MB body 上限会 413 杀掉合法 MCP 大 payload**：当前 `bodyLimitDispatch` 只分
   json 1MB / avatar 6MB 两档，2MB 的画布整板 `tools/call` 在 1MB 下返回 `413 PAYLOAD_TOO_LARGE`。
2. **/mcp 现状天然零限流**：`selectRule` 的 `DEFAULT_RULE` 只认 `/api/` 前缀，`/mcp` 不匹配任何规则
   => 既不被豁免也不受限（裸奔）。AI 的调用模式与人类点 UI 不同，需要独立、可观测的配额。

约束基线：既有 `/api` 两档与 413 行为字节不变；MCP 不开第二端口；401 的响应体不得泄漏 token 存在性。

## 2. 决策（Decision）

### 2.1 body 上限只新增第三档，专给 /mcp（默认 11MB）

- `bodyLimitDispatch` 用 `isMcpPath(c)` **精确判定**（去 basePath 后 `effectivePath === "/mcp"`，
  不做前缀放宽以免误伤 `/api`），命中走独立 `GX_MCP_BODY_LIMIT`，**默认 11MB**（对齐文档/画布 10MB
  契约 + JSON 开销）。其余请求维持既有两档（json 1MB / avatar 6MB）语义（`middleware/bodyLimit.ts:27-59`；
  `config.ts:295` = `parseBodyLimit(env.GX_MCP_BODY_LIMIT, 11 * 1024 * 1024)`）。
- 既有 `/api` 两档与 413 行为**逐字节不变**（S8 已用真监听端口复证：2MB payload 打 `/mcp` 得 200、
  打 `/api/records` 得 413 `PAYLOAD_TOO_LARGE`）。
- MCP 超限时机器码用 `MCP_PAYLOAD_TOO_LARGE`（§6），与 `/api` 的 `PAYLOAD_TOO_LARGE` 区分；
  HTTP 状态同为 413。

### 2.2 限流不进全局规则表，由 mcp 子应用两段式内聚

- 全局 `selectRule` 对 `/mcp` 继续返回 `null`（维持现状），**/mcp 限流整体内聚在 `mcpApp` 子应用**，
  复用 `FixedWindowCounter` 实例（`transport/mcpApp.ts:77-103`）：
  1. **认证前 IP 预桶：300 次/60s**（`sourceIp` 计，防未认证打爆）；
  2. **认证后 patId 桶：120 次/60s**（按 `pat:<patId>` 计正式配额）。
- **PAT 管理 REST（`/api/v1/pats`）另立 30 次/60s/人**（敏感档）；**GET 不占额度**。
- 全部可经 `GX_MCP_RATE_*` 配置：`GX_MCP_RATE_WINDOW_SEC` 默认 60、`GX_MCP_RATE_PAT_MAX` 默认 120、
  `GX_MCP_RATE_IP_MAX` 默认 300、`GX_MCP_RATE_PAT_REST_*` 默认 60/30（`config.ts:296-300`），S2 落 config
  并补配置闸门校验。
- 超限 **HTTP 429 + `Retry-After` + `X-RateLimit-Limit/Remaining`**，信封 `-32029 RATE_LIMITED`
  （JSON-RPC 外信封）。
- initialize/notifications 与 tools/call **同档**（不做免认证探活宽免，防滥用）。

### 2.3 401 语义裁决（2026-09-17 出口前拍定，保持现状、不改生产码）

- 拿不出有效令牌的**三种情况**——无令牌 / 非本系统形态（无 `gxpat_` 前缀）/ 伪造查不到——
  **响应体逐字节一致**（`{"error":{"code":-32001,"message":"Unauthorized"},"id":null}`，防枚举）。
- 已过期 / 已吊销 / 账号停用**各自可辨识**：`Token expired` / `Token revoked` / `Account disabled`
  （`transport/mcpApp.ts:24-31`）。
- **依据**：计划 §4.3 明文设计如此、S2 已冻结文案快照；能进入后三种分支需先猜中 32 字符随机段
  （"查不到"三态已不可区分、外部无法枚举），且状态可辨识便于**持令人**自行排障。
- 认证失败审计：六态 `reason` 全落 `mcp_auth_failure`；`patPrefix` **只对 `gxpat_` 形态**截前 14 字符
  （非 PAT 形态与无 Bearer **不带** `patPrefix`，不截断任意 Authorization 值）；绝不记完整 token。

## 3. 被否决的备选

1. **为 /mcp 全局放宽 1MB（改既有档）**：会同时放宽 `/api`，违反"既有路径字节不变"；定稿"只增第三档"。
2. **用前缀匹配 `/mcp`**：会误伤 `/mcpx` 之类；定稿精确路径判定。
3. **把 /mcp 规则塞进全局 `selectRule`**：全局中间件在认证**之前**运行、拿不到 patId，无法做认证后
   patId 桶；且会污染全局规则表。定稿内聚子应用、两段式。
4. **401 五态响应体全部一致（原派工单要求）**：与计划 §4.3 冲突（现网 revoked/expired/disabled 可辨识、
   S2 已冻结文案快照）；改为"查不到三态一致 + 状态三态可辨识"（见 2.3 裁决）。
5. **为 MCP 开第二端口 / 独立 nodeListener**：会重复安全头、限流、IP 提取实现，且 WebStandard 与 Hono
   同栈无收益；定稿复用既有 mount 与 unix socket。

## 4. 后果（Consequences）

- 画布/文档大 payload 经 `/mcp` 放行，`/api` 仍守 1MB（S0 golden 保证旧行为零变化）。
- `/mcp` 从"天然零限流"变为**可观测双桶**；全局规则表零污染，全局中间件语义不变。
- **401 语义裁决的后果**：持令人可据 `Token expired/revoked/Account disabled` 直接排障；伪造者无法借此
  枚举令牌——"查不到"三态已一致，且到达状态分支需先猜中 32 字符随机段。**该裁决保持现状、未改生产码**，
  后续如需收紧为"状态也不可辨识"，须另立裁决并同步改 S2 冻结的文案快照。
- 反代需同步 11MB 上限（本仓 Caddy 写法为 `request_body { max_size 12MB }`，见 `deploy/caddy/Caddyfile`；12MB 是给 11MB 业务上限留的余量。另需核查飞牛网关上载上限），列为部署物核查项与 runbook 章节。
- 运维可经 `GX_MCP_RATE_*` 调档：NAS 上若实测 AI 调用更陡（单 token 连续 agent 循环）再调，不阻塞 M6。

## 5. 验证证据

- 11MB 只对 /mcp：docs/baseline/m6-connectivity.md §7.1（2MB -> `/mcp` 200、`/api` 413
  `PAYLOAD_TOO_LARGE`，真监听端口复证）；`transport/__tests__/m6-s2-mcp-app.test.ts`（`app.request` 形态）。
- 独立限流：m6-connectivity.md §7.2（patId 桶调 3 后第 4 次 429 + `Retry-After: 60` +
  `X-RateLimit-Limit: 3` + `-32029 RATE_LIMITED`）；`transport/__tests__/m6-s2-mcp-rate-limit.test.ts`；
  默认值 `config.ts:296-300`（60/120/300/30）。
- 401 六态：m6-connectivity.md §6（三态一致 + 三态可辨识）；§8-4（口径差异登记与本次裁决）。
- 旧路由零 diff：计划 §S0 golden；m6-connectivity.md §9（常规门收集总数恒等）。
- bodyLimit 实现：`middleware/bodyLimit.ts:37-59`（第三档 mcpLimit 与 `isMcpPath` 精确判定）。

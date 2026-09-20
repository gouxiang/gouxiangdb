# ADR-0051：官方 SDK WebStandard 直桥 + 每请求无状态 transport

**状态（Status）**：Accepted（M6 计划 §10 第 1 条、§0-1、§4.1/§4.2 定稿；docs/_archive/originals/planning-phase2-spike-mcp-transport.md §0/§1 实测通过；S2 已过传输骨架门、S8 已过三客户端连通门；2026-09-18 M6 出口归档）
**作者**：架构师 高见远（M6-S9 归档；实现由后端 贝洛奇 落地）
**上游依据**：docs/_archive/originals/planning-phase2-M6-implementation-plan.md §0-1、§4.1（:129-163）、§4.2（:165-170）、§4.7、§10（:426）；docs/_archive/originals/planning-phase2-spike-mcp-transport.md §0（TL;DR）、§1（传输选型与实测陷阱）、§2（子路径/unix socket/反代）；ARCH-enterprise §8.1（:749）
**关联**：ADR-0019（协议无关标准 MCP server 总纲，ARCH-enterprise :941——本 ADR 是其实施细化，不重复立项）；ADR-0052（PAT 无会话缓存 => 吊销即时）；ADR-0053（双闸门）；ADR-0054（/mcp body 豁免与独立限流）

---

## 1. 背景（Context）

M6 要交付一个标准 MCP server，让任意第三方 MCP 客户端（curl 裸 JSON-RPC、官方 SDK client、
MCP Inspector、Claude Desktop-stdio）都能接入。落地前有两处必须拍板的选型：

1. **协议栈自建 vs 用官方 SDK**：MCP 协议（Streamable HTTP 的会话头、SSE 帧、DELETE、
   协议版本协商、错误码、zod schema->JSON Schema 转换、`listChanged`）是一份对外契约，
   自建要长期跟进规范演进。
2. **接入形态**：Hono 4 应用要不要为了接 MCP 引入 node http/express 桥；以及会话是有状态
   （Session-Id + SSE 长连接）还是无状态（每请求自验）。

约束基线：单实例部署、同端口同 unix socket、不为 MCP 开第二端口，且必须提供"吊销即时生效"
的架构前提（AC-M6-4）。

## 2. 决策（Decision）

### 2.1 采用官方 `@modelcontextprotocol/sdk`，精确 pin `1.30.0`

- 新增运行时依赖 `@modelcontextprotocol/sdk`，**精确 pin `"1.30.0"`**（`apps/api/package.json:32`），
  不用 `^1.30`。理由：协议库行为随版本变化，静默升 minor 可能破坏无状态形态；升级须先跑
  S8 连通门才允许。
- 依赖为纯 JS 传递依赖（ajv / zod4 / eventsource），**无原生模块**，不增加 better-sqlite3 /
  sqlite-vec 之外的部署风险。`scripts/build.mjs` external 白名单增 `"@modelcontextprotocol/sdk"`
  （`--packages=external` 形态下产物增量约 8.4KB；全内联 1.4MB 不采用）。

### 2.2 WebStandard transport 与 Hono `c.req.raw` 直桥

- 用 1.30.0 新增的 **`WebStandardStreamableHTTPServerTransport`**：`transport.handleRequest(c.req.raw)`
  直接吃 WHATWG `Request`、返回标准 `Response`。该类的 `.d.ts` 注释内即给 Hono 用法，是一等公民；
  **不需要** `@hono/node-server` 的 `getRequestListener/nodeListener` 去接 SDK 的 express/node 版 transport。
- Accept / Content-Type 的协议校验**交给 SDK**（415/406 由 SDK 出），不自造。

### 2.3 每请求 new server + new transport，无状态 JSON

- 首版形态 = **无状态 JSON**：每请求
  `new McpServer(...)` + `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`。
  - `sessionIdGenerator: undefined` => 不生成/不校验 `Mcp-Session-Id`；
  - `enableJsonResponse: true` => 协议请求以单条完整 `application/json` 响应返回，**不开 SSE 流**。
- **必须 `await server.connect(transport)`**：漏掉 connect，transport 的 `onmessage` 无人消费、
  `handleRequest` 返回的 Promise 永不 resolve，请求永久挂起（spike §1.2 实测踩坑）。
- `handleRequest` **返回前不得 close**（会截断响应）。本实现拿到完整 Response 后，用
  `queueMicrotask(() => { transport.close(); server.close(); })` 清理——JSON 模式响应此刻已完整生成，
  微任务确保先把 Response 交回 Hono 再清理，不截断。
- **transport 实例严禁跨请求复用**（SDK 源码硬校验 "Stateless transport cannot be reused across requests"），
  故每请求全新实例、处理完即弃。工具集在构建时按该请求身份裁剪，天然实现闸门一（ADR-0053）。
- SSE / 有状态会话**列二期**（需要服务端推送、如长任务 jobId 进度时再开）。

## 3. 被否决的备选

1. **手写 MCP server（约 300 行）**：spike §1.4 已证手写也能跑通并与官方客户端互操作，但会话表 /
   SSE 帧 / DELETE / 版本协商 / 错误码 / schema 转换 / `listChanged` 全自担，且协议升级
   （2025-11-25 无状态化、resumable streams）要自己跟。协议合规价值 > 体积；否决。
2. **node http / express 版 transport + `@hono/node-server` 桥**：1.30.0 已有 WebStandard 版，
   桥接是多余的 hack（更早版本只有 node 版时才需要），且会绕开 Hono 中间件链；否决。
3. **有状态会话 / SSE 先行**：反代需关 response buffering（虽 SDK 自带 `X-Accel-Buffering: no`），
   清理复杂度高，而首版无长任务推送需求；无状态 JSON 对反代零要求。否决。
4. **全内联 bundle**：1.4MB 产物增量；external 后仅 8.4KB。否决。
5. **`^1.30` 浮动版本**：minor 升级可能静默改变无状态 API 行为。定稿精确 pin。

## 4. 后果（Consequences）

- 协议合规随官方，升级路径明确：改 pin + 跑 S8 连通门（docs/baseline/m6-connectivity.md §3）。
- 无状态带来两处代价，均可接受：每请求构造 McpServer/transport 的轻微开销（工具数十个可忽略）；
  无会话内存堆积，契合单实例部署。
- **无会话缓存是 AC-M6-4 的架构前提**：认证结论不跨请求复用，PAT 一经吊销，下一请求立即 401
  （S8 实测）。这也是 SSE 二期必须保持的纪律——即使将来开 SSE 会话，认证结论也不得跨请求缓存。
- zod4 隔离纪律：SDK 内部用 zod4，业务层用 zod3；只允许 `src/mcp/tools/schemas.ts` 内 import
  SDK 自带 zod4（pnpm 隔离，实测可共存），S2 起有 grep/lint 守卫防 zod4 扩散出 `mcp/`。
- 反代与部署形态不变：MCP 挂进既有 mount，自动获得 `/mcp` 与 `{basePath}/mcp` 双路径，路径不参与
  协议（spike §2.1），unix socket 同端口复用，不开第二端口。

## 5. 验证证据

- 传输选型实测：docs/_archive/originals/planning-phase2-spike-mcp-transport.md §0/§1（initialize -> notifications/initialized -> tools/list ->
  tools/call 全通；curl / 官方 SDK client / Inspector 三客户端；JSON 与 SSE 两模式）。
- 实测踩坑留证：spike §1.2（漏 connect 挂死；handleRequest 后立即 close 截断；无状态 transport 不可复用）。
- 实现：`apps/api/src/mcp/transport/streamableHttp.ts`（每请求 new + `await connect` + `queueMicrotask` 清理）、
  `apps/api/src/mcp/server.ts`（buildServer 按身份注册工具）、`apps/api/src/mcp/transport/mcpApp.ts`。
- 版本 pin：`apps/api/package.json:32` = `"@modelcontextprotocol/sdk": "1.30.0"`；`scripts/build.mjs` external 白名单。
- 连通门：docs/baseline/m6-connectivity.md §3（三客户端 + 三形态 + stdio 双入口；14 工具下发带 inputSchema）。
- zod4 隔离：`apps/api/src/mcp/transport/__tests__/zod4-isolation.test.ts`。

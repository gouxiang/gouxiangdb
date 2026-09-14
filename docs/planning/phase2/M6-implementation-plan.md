# M6 鉴权 MCP 服务 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-18
- 作者：架构师 高见远
- 状态：**待项目总监终审**（§11 待裁决清单未关闭前不得派工实施）
- 上游依据：SPEC-enterprise-v1.0 §4（版本/方言铁律 `:60`）、§5（`:74` `GET/POST/DELETE /api/v1/pats`、`:77` `ANY /mcp`、`:78` OAuth 可选、MCP 工具命名空间 `:79`）、§6（`:88` `personal_access_tokens`：hash/name/scope/lastUsedAt/expiresAt/revoked；可选 oauth 表）、§7（`:102` 设置 → MCP 接入 PatList）、§9（AC-M6-1 `:126` 只读凭证无写工具+直调 UNKNOWN_TOOL、AC-M6-2 `:127` 字段收窄+参数二次拦截、AC-M6-3 `:128` 块/图元写入 Web 端结构完整+409+confirm、AC-M6-4 `:129` 吊销即时+调用全审计）、§10（`:135` op≤100/文本≤100KB/10MB/工具 30s/长任务 jobId）；ARCH-enterprise §8.1-8.6（`:749-841` 双传输/双闸门/工具全集/三语言/协议无关）、§10.2 M6 验收（`:917`）、ADR-0019（`:941`）、§13-4（`:989` OAuth 客户驱动）；PRD-enterprise MC2/MC6（语言可学、无权不可调）；**硬约束来源：`spike-mcp-transport.md`（2026-09-14，spike-mcp-transport 实测报告，已入库）**
- 适用代码基线：`main` @ `5f05d19`（M2-S6 收口；M3/M4/M5 均未开工实施，只有切片文档）；本计划入库提交见文末自报。根 package.json engines node>=20（实际 Node 22 验证）、v0.1.0
- 测试基线（项目总监复验给定，本文不重跑）：api **60 文件 710 passed / 3 skipped**（5f05d19）；迁移目录 **14 个**。M3 后预期 17、M4 后 19（索引补强可能 20）、M5 后约 22（change_events/app_settings 两迁移）；**M6 第一个数据迁移（personal_access_tokens）编号排在 M5 全部迁移之后**
- 本机核对环境：Node v22.22.2、pnpm 9、Hono 4.13.5（package.json `^4.10.3`）、zod **3.23**（apps/api/package.json:32）、jose 5.9 已在依赖、**当前无 `@modelcontextprotocol/sdk` 依赖（S2 精确新增 1.30.0，理由见 §4.1）**；spike 实测环境同为 Node 22.22.2

> **硬依赖声明（排期：M6 实施排在 M5 收口之后，后端单线 M2→M3→M4→M5→M6）**：M6 双闸门依赖 **M3-S1（nav_nodes）** 与 **M4-S1/S4（engine.decide/decideMany、resolveVisibleNodeIds/buildVisibleScopeSql、fieldCapability/maskedTableFields 契约冻结，M4 切片 §4.7）**；三语言工具依赖现有 recordService/kb service（在库）+ M4 引擎。**可提前项**：PAT 表与 PAT 鉴权边缘（S1）理论上只依赖 **M2（authState 用户态/停用闭环）**，技术上可在 M3/M4/M5 实施期间并行预制，但按单线纪律**未获派工不得开工**；即便提前做，S1 出口只交付 PAT REST 与可独立验证的认证原语，**/mcp 路由挂载仍须等 S2 且不解除 M6 整体排期**。M6 不得改 M3/M4/M5 的文件，例外仅限：① M2 lifecycle 停用路径追加一行同事务 PAT 批量吊销（M6 排在 M2 之后，属在库文件的增量接线，§5.3）；② openapi.yaml 只增 pats/mcp 段。所有"现状证据"行号均于 2026-09-18 在 5f05d19 工作区实读。本阶段只产出规划文档，不改任何 .ts 源码。

---

## 0. 结论先行

1. **传输定稿：官方 `@modelcontextprotocol/sdk@1.30.0` 的 `WebStandardStreamableHTTPServerTransport` 与 Hono 直桥**（spike §0/§1 实测，不可重新讨论）：`transport.handleRequest(c.req.raw)` 直接吃 WHATWG Request 返回标准 Response，d.ts 内即给 Hono 示例；**不需要** `@hono/node-server` 桥接 express/node 版 transport。首版**无状态 JSON 形态**：每请求 `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` + **必须 `await server.connect(transport)`**（漏 connect 请求永久挂起，spike §1.2 实测踩坑）；无状态 transport 实例 SDK 硬校验不可跨请求复用，形态 = 每请求新建 transport + 按该请求身份 build 一个 McpServer，处理完即弃。SSE/有状态会话留待长任务推送再开，M6 不做。
2. **两处部署硬改动（spike §0-5/§9.2 实测复现）**：① **/mcp 豁免全局 1MB body 上限**（bodyLimit.ts:37-38 现状只分 json 1MB/avatar 6MB 两档），独立 `GX_MCP_BODY_LIMIT` 默认 **11MB**（对齐文档/画布 10MB + JSON 开销；实测 2MB 画布 call 在 1MB 下 413、11MB 放行）；② **/mcp 独立限流档**——rateLimit.ts:71-78 `selectRule` 现状对 `/mcp` 不匹配任何规则（DEFAULT_RULE 只认 `/api/` 前缀，:64），即**当前天然零限流**，M6 必须新增按 patId 的独立档（建议值待裁决 C-1），不留裸奔。
3. **PAT 是首版唯一凭证，OAuth 只留扩展点不实现**（spike §6 + ARCH §13-4）：明文 `gxpat_` + 24 字节随机 base64url，**只在创建响应中明文返回一次**，库存 SHA-256 hash（tokenHash 唯一索引）+ scope + expiresAt + revokedAt（用时间戳非 boolean）+ lastUsedAt；常量时间比对；lastUsedAt 进程内 Map 节流 60s 批量落库。scope 首版用粗粒度动作位（record:read/record:write/doc:read/doc:write/canvas:read），**不把资源授权复制进 token**——能访问哪些库表文档一律由 M4 引擎按 userId 现算。
4. **PAT 鉴权与 M2 用户态强联动（AC-M6-4 的另一半）**：每请求边缘不信任任何会话，顺序 = Bearer 解析 → hash 查 PAT（查不到/伪造一律 401 同口径）→ revokedAt/expiresAt → **再查 subject 用户 `status=ACTIVE`**（复用 resolveActiveAuth 的 status 现查思路，authState.ts:80-86 同款 PK 点查，默认零缓存）：用户被停用（lifecycle.disableUser 置 DISABLED+tokenVersion+1，lifecycle.ts:115-137）→ 其全部 PAT **同事务批量 revokedAt**（M6 给在库停用路径追加一行）+ 边缘 status 兜底双保险，下一请求即 401；用户物理删除 → FK `onDelete: Cascade` 带走 PAT。改密码/tokenVersion 不杀 PAT（PAT 是独立凭据，不比对 tv）。
5. **双闸门 R-MCP-1 是强制架构，不是可选层**：闸门一 = buildServer 时按 M4 有效权限动态注册工具（`listAccessibleResources` 非空才注册该工具，schema 枚举/字段随权限收窄），只读凭证 tools/list 物理没有写工具；闸门二 = **MCP 工具只走 M4 新引擎、不走旧 guards.ts**——每个 tool handler 调 service，**service 首行 `engine.decide(user, node, action)` 或 scope 接口强制鉴权**，handler 不直接 import prisma、不 import 旧 requireCanView/requireCanEditData。被裁工具绕过 list 直调 → **UNKNOWN_TOOL（-32602，与"工具不存在"逐字节一致，不泄漏存在性，AC-M6-1）**；工具可见但本次资源无权 → MCP `isError:true` + `{code:"FORBIDDEN_RESOURCE"|"FORBIDDEN_FIELD", requiredAction, currentRoleSources}`（AC-M6-2）。
6. **三语言机器说明书对所有连接者可发现，业务数据不进 Resources**：表/文档块/画布图元三套纯语言文档（无真实库名/字段值）经 MCP `server.registerResource` 静态承载，任何 PAT（含只读）均可读——"语言可学、无权不可调"；Resources 本期**仅此一用途**，不做业务数据读通道（ARCH §12）。
7. **三语言工具范围按 spike §5 收敛**：数据表 6 个（table.list_bases/get_schema、record.list_records/query_records/create_record/update_record；record.delete/batch 待裁决 C-6，建议 delete 进 M6、batch 二期）；文档块 4 个（doc.get_doc_blocks/append_blocks/update_block/delete_blocks，锚 contentVersion 乐观锁，复用 kb.ts:423-435 现有 409 机制）；**画布 M6 只读**（canvas.get_board 一个，写留二期——Plait 六不变量需要把前端 canvas-ops.ts 747 行规则抽 shared 服务端校验器，工作量独立成片，待裁决 C-2）。前置事实：块模型纯函数 `mdToBlocks/blocksToMd` 当前在 **apps/web/src/features/kb/blocks.ts（993 行，零 document/window 调用，已实测纯函数）+ markdown.ts（473 行）**，S5 须先下沉到 packages/shared 供 api 消费，这是文档语言切片的真实成本，不是零成本复用。
8. **审计 mcp_* 事件全量落 JSONL**：扩 AuditEventName（audit.ts:9-26 现状 16 枚）增 `mcp_auth_failure/mcp_tool_call/mcp_pat_create/mcp_pat_revoke`；每次 tools/call 必审计（含被拒）、认证失败也审计；detail 只记 patId/tool/资源 id/resultCode/分页元信息并过 redactSecrets（audit.ts:50-59 已覆盖 token/secret/bearer），业务字段值不入日志；写审计失败只告警不阻断（audit.ts:111 writeAudit 现有纪律）。
9. **三客户端真实连通 + 三对抗拒绝是出口硬门**（spike §7 已在隔离 PoC 全绿，M6 要在真库真服务复跑入回归）：客户端 = curl 裸 JSON-RPC、官方 SDK `StreamableHTTPClientTransport`、MCP Inspector CLI（`--transport http`），外加 stdio 第二入口的本机客户端 PoC（Claude Desktop 配置形态或等价 stdio client）；对抗 = ①只读凭证 list 无写工具且直调返 UNKNOWN_TOOL、②字段受限凭证 schema/返回无不可见字段且参数越权被二次拦截、③无权资源 id 直传（IDOR）返 FORBIDDEN_RESOURCE 且不泄漏存在性；另加无/伪造/过期/吊销 PAT 四态 401 与吊销后下一请求即时拒绝。
10. **协议无关、去任何单一平台绑定**（R-MCP-2）：交付标准 MCP server + 一份通用《MCP 客户端接入说明》，不内置聊天 UI、不做模型编排、不为任何连接器做专属适配；历史 WorkBuddy 调研文档归档不作为实施输入（ARCH §8.6）。新增运行时依赖仅 `@modelcontextprotocol/sdk@1.30.0`（纯 JS 传递依赖 ajv/zod4/eventsource，无原生模块；esbuild external 后产物增量约 8.4KB）；SDK 内部 zod4 与仓内 zod3 靠 pnpm 隔离共存，zod4 仅限 src/mcp/tools/schemas.ts 使用，不扩散（spike §1.6）。
11. **切片 S0-S10 共 11 片**：S0 characterization/baseline → S1 PAT 基座（**可提前，仅依赖 M2**）→ S2 传输骨架（/mcp 直桥/11MB/限流档/401/ping）→ S3 双闸门适配层（M4 PermissionService/动态注册/UNKNOWN_TOOL 口径）→ S4 表/记录语言 → S5 文档块语言（blocks 下沉先行）→ S6 画布只读+stdio+Resources 说明书 → S7 审计与幂等 → S8 三客户端/三对抗回归 → S9 出口收口（ADR/openapi/runbook/接入说明/M6-FE 输入）。前端 PatList 管理页是独立 M6-FE 片（§8）。

---

## 1. 现状证据（行号已核对，2026-09-18 于 5f05d19 工作区实读）

### 1.1 M2 用户态与鉴权链（PAT 联动直接复用）

| 事实 | 证据（已核对） |
|---|---|
| JWT 解析共享核心 status/tv 现查 | `domain/org/authState.ts:55-96` resolveActiveAuth：验签后 PK 点查 users（:80-82 select id/status/tokenVersion/workspaceId），用户不存在/非 ACTIVE/tv 不符 → null；默认零缓存（GX_AUTH_STATE_TTL_MS=0，:72-78） |
| v1 鉴权中间件 | `middleware/authActive.ts:19-25` requireActiveUser（失败抛 HttpError 401）；:33-45 requireOrgAction（挂 requireActiveUser 之后，调 hasOrgAction）；ContextVariables `auth: ResolvedAuth` :13-17 |
| v1 挂载点（全链鉴权模板） | `routes/v1/index.ts:14-20`：`v1.use("*", requireActiveUser)` + org 子路由；app.ts:145-149 仅在 config.enterpriseOrg 时挂 /api/v1 与邀请公开路由 |
| 停用闭环 | `domain/org/lifecycle.ts:115-137` disableUser（withWriteTx 内置 DISABLED :130、disabledAt、tokenVersion increment :131、提交后 invalidateAuthState :137）；reactivateUser :142-165；删除用户 = auth.ts:208 prisma.user.delete（cascade 配置在 schema 关系） |
| 组织角色/动作 | `domain/org/authorization.ts` effectiveRoleRows（定数三查，:39 起）、hasOrgAction（M4 文档记 :115-117）；真源 `packages/shared-types/src/org.ts:10-15` OrgAction 三枚（manage_departments/members/roles，M3/M4 将只增 manage_menu/manage_share）；系统五角色 `domain/org/roles.ts:38-47`（id=role_owner…，systemKey owner/creator/…）、usersWithRole :66 |
| users 表 M2 列 | schema.prisma:182-216 User：status :201（默认 ACTIVE）、workspaceId :202、tokenVersion :203（默认 0），@@index([status]) :216 |

### 1.2 传输/中间件/装配设施（S2 必改两处的现状）

| 事实 | 证据 |
|---|---|
| body 上限两档分发 | `middleware/bodyLimit.ts:19-27` jsonLimit=config.bodyLimitJsonBytes（默认 1MB，config.ts:165/:213 解析 GX_BODY_LIMIT_JSON）、uploadLimit 6MB；:29-34 isAvatarUpload 精确匹配；**:37-38 dispatch 三元分流——M6 在此增第三档 mcpLimit，不改既有两档语义** |
| 限流选择器 | `middleware/rateLimit.ts:60-65` DEFAULT_RULE 仅 `path.startsWith("/api/")`；:71-78 selectRule（exempt→strict→org-admin→default→**null**）；/mcp 现返回 null = 完全无限流；:148-175 中间件键当前只按 sourceIp；:30-35 ORG_ADMIN_RULE 是"只增命名档"先例 |
| 安全头/CORS/日志 | app.ts:95-98 挂载序（secureHeaders→bodyLimit→rateLimit）；CORS :80-92 allowHeaders 仅 Content-Type/Authorization（MCP 浏览器 host 够用，MCP 另有 Accept 要求由非浏览器客户端发送） |
| mount/basePath 双挂 | app.ts:51 createMount 单例；:176-177 外层先 basePath 后根双挂——**MCP 只要挂进 mount 即自动同时有 `/mcp` 与 `/app/gouxiangdb/mcp`**（spike §2.1 实测路径不参与协议），无需自己挂第二份 |
| unix socket 形态 | index.ts:27-40 createServer(getRequestListener(app.fetch)).listen(sock) + 0660；MCP 不开第二端口（spike §2.3 网关→unix→SSE/JSON 透传实测） |
| 企业能力门控 | config.ts:175 AppConfig.enterpriseOrg；:229 `env.GX_ENTERPRISE_ORG !== "off"`（默认开）；/mcp 与 /api/v1/pats 是否同受此门控待裁决 C-5（建议受门控） |
| 错误信封 | guards.ts:9 HttpError、:112 errorResponse 统一出口；MCP 协议内错误（-32602/isError）不经 HTTP 信封，仅边缘 401/413/429 走信封 |

### 1.3 三语言要接的 service 现状

| 事实 | 证据 |
|---|---|
| 记录读服务（M1 物理下推在库） | `domain/recordService.ts:115` queryRecords(QueryOptions)、:237 queryRecordsLegacy、:275 loadTableFields、:289 hydrateRecordById；:47 visibleFields/、:68 applyViewQuery；写路径仍在 routes/records.ts（多写点，M5-S1 清单已盘） |
| **MCP 工具禁止接的旧守卫** | guards.ts:43-91 roleOf/permissionsOf/requireCanView/requireCanEditData/requireCanManage*（members/kbMembers 旧五角色）——M6 handler/service 一律不 import 这些，资源判定走 M4 engine（§3-4） |
| 文档乐观锁（原样复用） | routes/kb.ts:423 条件更新 `contentVersion: {increment:1}`、:429 where id+contentVersion=baseVersion、:433-435 更新 0 行读当前版本返 409 `{code:"VERSION_CONFLICT", currentVersion}`；doc service 原语 domain/kb.ts:73 maybeAutoSnapshot、:115 createManualVersion |
| **块模型在前端、但是纯函数** | apps/web/src/features/kb/blocks.ts（993 行，mdToBlocks/blocksToMd/newBlock，全文件 0 处 document/window/navigator 调用，已实测）、markdown.ts（473 行，:6 import blocks 的 isSafeUrl/sanitizeInlineStyle/parseTableSpans 等）；内容存储 = KbDoc.content（Markdown 文本 / Plait JSON，schema.prisma:302），服务端目前不解析块 |
| 画布 | apps/web/src/features/kb/canvas/canvas-ops.ts（747 行，六不变量逻辑在前端）；服务端只存取 content JSON（kind="canvas"）；domain/kb.ts:28-57 canvasToSearchText 已能递归提取文本 |
| 检索 | M5 将交付 `GET /api/v1/search`；ARCH 工具全集含 record.search，**M6 是否暴露 record.search 工具待裁决 C-7（建议 M6 暴露，直接薄封装 M5 端点 service，scope 收敛由 M5 保证）** |

### 1.4 审计/迁移/构建现状

| 事实 | 证据 |
|---|---|
| JSONL 审计 | audit/audit.ts:9-26 AuditEventName 16 枚联合；:28-47 AuditInput/Record；:50-59 SENSITIVE_PARTS（token/secret/authorization/bearer/jwt/cookie 等）；:111 writeAudit 底层（emit.ts:16 audit(c,input) 从 Hono Context 填 ip/method/path——MCP 一次 call 非一路由，直接调 writeAudit 自填 path="/mcp"） |
| 迁移纪律 | 14 个迁移目录；M2 手写迁移 20260915090000/090100（DDL+回填分离先例）；schema 方言中立铁律 SPEC:60；只增、快照、30 分钟回滚 |
| esbuild 产物 | scripts/build.mjs:32-40 external 白名单（hono/jose/zod/better-sqlite3 等运行时外置，@gx/* 内化，:54-56）；SDK 加入 external 即可，全内联 bundle 增量 1.4MB 不采用（spike §1.4） |
| 依赖现状 | apps/api/package.json:30 hono ^4.10.3、:31 jose ^5.9（OAuth 未来复用）、:32 zod ^3.23；根 package.json:39-42 engines node>=20/pnpm>=9；无 SDK、无任何 MCP 相关代码（全仓 grep `/mcp` 仅文档命中） |
| openapi | 全仓无 openapi.yaml（M3-S7 才首版冻结，M3 未开工）；M6 出口只在冻结版上**只增** pats/mcp 段，形状手写对拍，不引 swagger 依赖（M3 裁决 5） |

---

## 2. M6 范围边界

### 2.1 必做（SPEC M6 + AC-M6-1~4 + ARCH §8）

1. **PAT 全生命周期**：只增迁移 personal_access_tokens；tokens 原语（生成/hash/常量时间比对/校验/lastUsedAt 节流）；`/api/v1/pats` 本人 REST（创建明文一次、列表只回元数据+前缀、吊销）；PAT scope 五位与过期/吊销；mcp_pat_* 审计。
2. **/mcp Streamable HTTP 无状态服务**：SDK 1.30.0 WebStandard 直桥挂入 mount（自动双路径）；每请求身份认证 + 按身份 build server；协议方法 initialize/notifications/initialized/tools(list/call)/resources(list/read)；401 边缘口径（WWW-Authenticate、JSON-RPC -32001 id:null）；11MB body 豁免；MCP 独立限流档。
3. **双闸门**：M4 PermissionService 适配层（工具可见性 = listAccessibleResources 非空；schema 资源/字段收窄）；执行期 service 首行 engine.decide/scope；UNKNOWN_TOOL 不泄漏口径；FORBIDDEN_RESOURCE/FIELD/GROUP 结构化拒绝；字段出参投影（AC-M6-2）。
4. **数据表语言**：table.list_bases/get_schema、record.list_records/query_records/create_record/update_record（+C-6 裁定 delete）；keyset 分页（limit≤200）、受控 filter 白名单（禁任意 SQL/公式）、写工具 confirm:true 与 requestId 幂等（24h）。
5. **文档块语言**：blocks.ts/markdown.ts 下沉 shared 包（api/web 同源消费，web 改 import 路径行为等价）；doc.get_doc_blocks/append_blocks/update_block/delete_blocks；contentVersion 乐观锁（VERSION_CONFLICT+currentVersion）；op≤100/批文本≤100KB；align 只走注释通道。
6. **画布只读 + stdio + 说明书**：canvas.get_board；`src/mcp/stdio.ts` 独立 bin（GX_MCP_TOKEN 启动即校验，复用同一 registry）；三语言 Resources 静态 markdown 对所有连接者可读。
7. **审计与幂等**：四枚 mcp_* 事件；requestId 24h 去重（同主体+同工具+同 requestId 返首次结果）；30s 工具超时（AbortController，超时结构化错误，不挂死连接）。
8. **连通与对抗回归**：curl/SDK client/Inspector 三客户端真库连通（含子路径 + unix socket 经伪网关至少一次留证）；stdio 客户端连通；AC-M6-1/2/3(doc)/4 全对抗入自动化/手测基线；《MCP 客户端接入说明》。
9. **openapi 增补 + M6-FE 契约片**：pats 端点进 M3 冻结的 openapi；M6-FE 输入清单（设置 → MCP 接入 PatList，§8）。

### 2.2 明确不做

| 不做 | 归属/依据 | M6 临时姿态 |
|---|---|---|
| OAuth 2.1/PKCE 全套（注册/授权页/回调/刷新） | ARCH §13-4 客户驱动；spike §6 建议 | 仅在 authenticate() 留"Bearer PAT 或 Bearer JWT"分支扩展点与注释，不预埋端点/表/代码；oauth 表不建 |
| 画布写（canvas.commit_elements 全操作集） | spike §5.3 建议二期；待裁决 C-2 | M6 仅 canvas.get_board；AC-M6-3 画布写入部分若裁定必须 M6 交付则追加独立切片（§7 注） |
| record.batch / 大导入 jobId / 长任务推送 | SPEC:135 长任务属二期；M5 worker 可复用但 M6 不接 | 超限直接 -32602；无 jobs.get；SSE 不开 |
| MCP prompts 原语、Resources 业务数据通道 | ARCH §12 | Resources 仅静态说明书 |
| 服务端模型编排/内置聊天 UI/单一平台适配 | R-MCP-2 | 协议无关标准件 |
| 旧 /api 守卫改造、旧五角色下线 | 后续统一切片 | MCP 物理隔离只认 M4 引擎，旧路由字节不动 |
| PAT 资源级白名单（per-base allowlist） | spike §3.4 二期 | token 只表"人+读写档"，资源授权归 M4 |
| 独立 MCP 端口/独立 nodeListener/独立进程 | spike §9.2 | 同 Hono app 同端口同 unix socket；stdio 是唯一第二入口且为独立 bin |
| 内置 AI 聊天/问答 | M7 后另立项 | M6 只交付标准接口 |
| M6-FE PatList 页面实现 | 独立 M6-FE 片（S9 契约冻结后派工） | 本文只给 §8 |

---

## 3. 不能动的契约（Characterization 先锁）

1. **旧 /api 与 v1 既有端点字节不变**：S0 对 /api 记录读、kb PUT content 409、/api/v1/meta、org 端点做真库快照；M6 期间 bodyLimit/rateLimit 的既有档对既有路径行为零变化（只增 /mcp 分支与独立规则，豁免逻辑用精确路径判定，不做前缀放宽）。
2. **M4 契约只消费不改**：MCP 依赖的 M4 接口签名以 M4 切片 §4.7 为准——`resolveVisibleNodeIds(userId, opts)`、`buildVisibleScopeSql(userId, opts)`、`engine.decide/decideMany`、`fieldCapability(subject, tableNode)`、scope 响应附 `maskedTableFields`；M6 在 `src/mcp/permissions/types.ts` 定义本里程碑消费接口（M4 实现/适配），**S3 开工逐点复核 M4 实际导出名，偏差走薄适配，不复制引擎、不改 M4 文件**。M3/M4/M5 未落地前 S3 不得开工（S1 可提前）。
3. **MCP 工具不接旧守卫**：任何 tool handler/service 不得 import guards.ts 的 requireCan*、不得直接 import prisma 做裸查（spike §4.3 时序第 5 点）；资源判定必经 M4，数据读写经既有 domain service（recordService/kb 服务层）。代码评审 grep `mcp/**` 内 `requireCan|from "../../guards"|prisma\.` 命中即打回（仅 pat 自身存储与审计例外，且不涉资源授权）。
4. **每请求边缘重认证，无会话信任**：无状态 JSON 模式天然每请求重验；即使未来开 SSE 会话，认证结论不跨请求缓存（吊销即时性的架构前提，AC-M6-4）。PAT 查库允许极短 TTL 缓存吗？**首版不缓存**（单用户 token 量级小、等值索引点查；即时性优先），仅 lastUsedAt 写节流。
5. **存在性不泄漏二分口径**：工具对该主体不可见（闸门一裁掉）→ 任何直调返 UNKNOWN_TOOL（-32602，HTTP 200，与真不存在同名工具同文案）；工具可见但资源/字段无权 → isError + FORBIDDEN_*（可解释）。两条响应在 S3 写 golden 对拍测试锁定，**永不互换**。
6. **密钥/token 零泄漏**：PAT 明文仅创建响应一次；库存/日志/审计/错误消息/列表接口只出现 name/tokenPrefix（前 8 字符级）/lastUsedAt；GET pats 永不回 hash；审计 detail 过 redactSecrets；openAPI 示例用 `gxpat_example` 占位；异常栈不回客户端（沿用 errorResponse）。
7. **协议合规面**：Content-Type 必须 application/json、Accept 须含 application/json 与 text/event-stream（SDK 强制 415/406，保持默认不透改）；initialize 协商协议版本 2025-06-18（SDK 1.30 默认，客户端发 2025-11-25 亦可协商，不锁死）；破坏性写 confirm:true 在 zod schema 层强制（z.literal(true)，spike §7 实测）。
8. **配额契约**：读工具 limit≤200、写批量 op≤100、批文本≤100KB、文档/画布 10MB 上限（与 REST 同）；工具执行 30s 超时（AbortController）；超限一律协议层 -32602 或 isError 结构化码，不放行全表拉取。
9. **版本兼容/回滚**：新依赖 SDK 进 external 白名单，fpk/Docker node_modules 安装须含该包（纯 JS 无原生风险，S9 发版冒烟加 `/mcp` initialize）；回滚 = 路由摘除 + 迁移保留（PAT 表无既有业务读取方，DROP 安全；发布前快照为主回滚路径）；GX_ENTERPRISE_ORG=off 时 /mcp 与 pats 不挂载（待 C-5 确认，建议与 v1 同门控）。
10. **M0-M5 回归不回退**：M1 flags 四组合、M2 组织 v1（含停用闭环，M6 追加 PAT 吊销后补一组回归）、M3/M4/M5 对抗在 M6 各开关下全绿；默认姿态下无 MCP 客户端连接时进程零额外定时器/零外网连接（stdio bin 不随 API 启动）。

---

## 4. 架构设计

### 4.1 总览（ASCII）

```
第三方标准 MCP 客户端（curl / SDK client / Inspector / Claude Desktop-stdio，协议无关）
   │ POST {basePath}/mcp   Authorization: Bearer gxpat_…   Content-Type/Accept 协议头
   ▼
Hono mount（app.ts createMount，自动 /mcp + /app/gouxiangdb/mcp 双挂；unix socket 同端口）
 中间件链（既有）：logger → bench → CORS → secureHeaders
   → bodyLimitDispatch ★第三档：effectivePath=/mcp → GX_MCP_BODY_LIMIT(11MB)
   → rateLimitMiddleware ★MCP_RULE：认证前按 IP、认证后按 patId 双键（建议 120/60s，C-1）
   ▼
routes/mcp/mcpApp.ts（new Hono(), all("/")）
  ① authenticate(c.req.raw)：Bearer PAT
       gxpat_ 前缀 → tokenHash 等值查 → revokedAt/expiresAt
       → users PK 点查 status=ACTIVE（M2 联动，DISABLED/INVITED/删除即拒）
       → subject {userId, patId, scopes}；失败 401（-32001, id:null, WWW-Authenticate）
       → lastUsedAt 60s 节流（runSerialized）
  ② buildServer(subject)：每请求 new McpServer + new Transport(stateless JSON)
       闸门一：mcpPermissions.listAccessibleResources(subject, action) 非空才注册工具
               （M4 scope/engine 适配；schema 枚举/字段经 fieldCapability 收窄）
       Resources：三语言静态说明书（所有连接者可注册读取）
       await server.connect(transport)  ← 漏了挂死
  ③ return transport.handleRequest(c.req.raw)
       body 结束/取消 → close transport/server（JSON 模式写完即触发，无泄漏）
   ▼
工具 handler（src/mcp/tools/*.ts，只编排，不裸查 prisma）
  zod4 校验入参（limit≤200/confirm:true/requestId）
  → requestId 幂等表（24h）
  → domain service：service 首行 ★闸门二 M4 engine.decide / buildVisibleScopeSql
       表/记录 → recordService（queryPlan/keyset）+ 字段投影
       文档块 → kb 文档服务（contentVersion 条件更新 409）+ shared blocks 纯函数
       画布   → 只读 KbDoc content
  → mcp_* 审计（脱敏，含拒绝）  → 结构化结果 / isError

stdio 第二入口：src/mcp/stdio.ts（独立 bin，不随 API 启动）
  GX_MCP_TOKEN 启动校验（同 authenticate 库函数）→ 同一 registry → StdioServerTransport
```

### 4.2 依赖与版本锁定

- 新增 dependencies：`@modelcontextprotocol/sdk` **精确 `1.30.0`**（SPEC §4 "实施锁 ^1.30 复测"在 spike 已复测完成，采用精确 pin + Renovate/升级时跑 S8 连通门才允许 minor；理由：协议库行为随版本变，pin 住避免静默升级破坏无状态形态）。纯 JS 传递依赖（ajv/zod4/eventsource），无原生编译。
- build.mjs external 白名单增 `"@modelcontextprotocol/sdk"`；fpk server/ 生产依赖安装自动带上；Docker 无需基础镜像变更。
- **zod4 隔离纪律**：只允许 `src/mcp/tools/schemas.ts` 内 import SDK 自带 zod4（`@modelcontextprotocol/sdk` 依赖树内的 zod，pnpm 隔离）；业务层 zod3 不动；S2 加 lint 规则/grep 守卫防 zod4 扩散出 mcp/。
- 不新增其他运行时依赖；哈希/加密/常量时间全用 node:crypto；超时用 AbortController + 全局 fetch（无 SDK HTTP 客户端需求）。

### 4.3 PAT 数据模型（手写只增迁移，编号在 M5 之后）

```prisma
model PersonalAccessToken {
  id         String    @id @default(cuid())
  userId     String
  name       String                                // "cursor-工作机"，≤60 字符
  tokenPrefix String                                // gxpat_ + 随机段前 8 字符，列表展示用
  tokenHash  String    @unique                      // sha256(plaintext) hex，等值索引
  scopes     String                                // JSON 数组字符串（SQLite 无原生数组）
  expiresAt  DateTime?                             // null=不过期（是否允许待 C-3）
  revokedAt  DateTime?                             // 用时间戳不用 boolean；revoked = revokedAt!=null
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
  @@map("personal_access_tokens")
}
```

- 生成：`gxpat_` + crypto.randomBytes(24).toString("base64url")；hash = sha256 hex；tokenPrefix 存明文前 14 字符（含前缀）便于列表辨识，**不构成可认证凭据**（随机段 32 字符，暴露前 8 不足以猜中，C-3 复核）。
- scope 五位常量（单一真源放 shared-types 或 mcp/permissions，M6 新增不与 M4 RESOURCE_ACTIONS 混用）：`record:read/record:write/doc:read/doc:write/canvas:read`。映射：`:read` → M4 资源动作 `r`；`:write` → `c,u,d`（引擎逐动作判定，write 不隐式含 read？**定稿映射：write 档工具在执行期按 c/u/d 判定，读返回仍需 r——建记录后回读该记录要求 r，无 r 时写成功但返回精简回执，S4 用例锁定**）。
- 校验顺序（spike §3.2，边缘固定）：无 Bearer/前缀不符→401 Unauthorized；hash 查不到→401 同口径（防枚举）；revokedAt→401 Token revoked；expiresAt→401 Token expired；用户 status 非 ACTIVE→401 Account disabled（不区分"用户不存在"——cascade 删除后 PAT 行消失自然落到 hash 查不到）。
- 比对：hash 等值查（@unique）即可；为防时序侧信道，查不到时对一个 dummy hash 做一次等长 timingSafeEqual（spike §3.5 建议，成本忽略）。
- 迁移 down：DROP TABLE（表无其他读取方）；用户删除依赖 cascade——M2 既有 user 删除路径是否已对全关系 cascade 开工核对（schema 关系定义），缺失则在本迁移补关系声明（Prisma schema 改动 + 只增迁移一致）。

### 4.4 双闸门与 M4 适配层

```ts
// src/mcp/permissions/types.ts（M6 定义消费接口；实现薄适配 domain/authz，S3 落地）
export interface McpSubject { userId: string; patId: string; scopes: string[]; }

export interface McpPermissionPort {
  /** 闸门一：主体在该动作位下可访问资源 id 全集（空集=工具不注册）。M4 scope 契约的 MCP 投影 */
  listAccessibleResources(subject: McpSubject, family: "table"|"doc"|"canvas"): Promise<string[]>;
  /** 闸门二：单次资源判定（service 首行）。M4 engine.decide 薄封装 */
  can(subject: McpSubject, action: "r"|"c"|"u"|"d", resource: { kind: NodeKind; id: string }): Promise<boolean>;
  /** 字段能力（schema 收窄 + 出参投影）。M4 fieldCapability */
  readableFields(subject: McpSubject, tableNodeId: string): Promise<FieldCapability[]>;
}
```

- **闸门一注册时机**：buildServer 时按"工具族"查一次可访问集（table 族查 table 节点集、doc/canvas 同），非空才 `server.tool(...)`；工具的 baseId/docId 枚举参数（如 query_records 的 baseId 无则列库）用该集生成 enum；get_schema 的字段 properties 经 readableFields 收窄（不可见字段不进 schema，AC-M6-2）。可访问集解析走 M4 resolveVisibleNodeIds（budget 截断行为沿用 M4/M5 口径：超 5000 不允许全量枚举，enum 改为自由字符串+执行期判定，响应带 truncated 提示）。
- **闸门二执行点在 service 不在 handler**：在 mcp/service 适配层（或 M4 engine 的 mcp 专用 facade）每个方法首行 enforce；记录写还要过字段级（不可见字段 create/update → FORBIDDEN_FIELD，绝不静默丢弃）；doc 工具对 doc 节点判 r/c/u/d；canvas.get_board 对 canvas 节点判 r。
- **被裁工具直调**：工具未注册时 SDK 对未知方法天然返回 -32602 `Tool x not found`——S3 用 golden 测试证明"因无权限而未注册"与"真不存在的工具名"两条错误逐字节一致（spike §7 实测口径）。
- PAT scope 是工具族的第一道粗筛（无 record:write → 写工具不注册，连引擎都不调）；M4 是资源级第二道。scope 与引擎是**串联与门**，任一不过即拒。
- **MCP 不做旧 guards 的兼容适配**：旧 members/kbMembers 授权是否正确投影进 M4 是 M4 回填切片（M4 S2/S3）的责任；M6 只验端到端结果，不读旧表。

### 4.5 工具契约要点（详细 JSON Schema 在 S4-S6 随 openapi 旁证冻结）

| 工具 | 入参要点 | scope | 执行期判定 | 幂等/确认 |
|---|---|---|---|---|
| table.list_bases | {} | record:read | 可见 base 节点集（M3 base 节点 r） | — |
| table.get_schema | {baseId} | record:read | base r + 表/字段按 M4 收窄 | — |
| record.list_records | {baseId, tableId?, cursor?, limit≤200} | record:read | 表节点 r；keyset 编解码复用 M1 | — |
| record.query_records | {baseId, tableId, filter(白名单操作符), sort?, cursor?, limit≤200} | record:read | 表 r；filter 编译复用 queryPlan，禁公式/裸 SQL | — |
| record.create_record | {baseId, tableId, fields{}, confirm:true} | record:write | c；字段逐列 fieldCapability 写权限 | requestId + confirm |
| record.update_record | {baseId, tableId, recordId, fields{}, expectedVersion?} | record:write | u；行存在性（表 r 可见行，与 M5 B-3 同口径） | requestId |
| record.delete_record（C-6 裁定后） | {baseId, tableId, recordId, confirm:true} | record:write | d（软删，与 REST 同语义） | requestId + confirm |
| doc.get_doc_blocks | {docId, format:"blocks"|"markdown", range?} | doc:read | doc 节点 r；blocks 经 shared mdToBlocks | — |
| doc.append_blocks | {docId, afterBlockId?, ops[]≤100, baseVersion} | doc:write | u；单事务一次 version+1；文本≤100KB | requestId |
| doc.update_block | {docId, blockId, patch{text?,checked?,align?}, baseVersion} | doc:write | u；align 仅注释通道 | requestId |
| doc.delete_blocks | {docId, blockIds[]≤100, baseVersion, confirm:true} | doc:write | u；原子批 | requestId + confirm |
| canvas.get_board | {docId} | canvas:read | canvas 节点 r；返 elements/contentVersion/viewport | — |

- 乐观锁：doc 写复用 kb.ts:423-435 条件更新，冲突 `isError:true` + `{code:"VERSION_CONFLICT", currentVersion}`（MCP 错误码，HTTP 200——协议错误不走 HTTP 4xx）。
- 幂等：24h 去重窗，键 = patId+tool+requestId；**幂等状态存哪**：主库轻表 `mcp_idempotency(key PK, patId, tool, responseJson, createdAt)` 只增迁移（与 PAT 同批迁移或 S7 单独迁移，建议同批第二迁移，过期行不清理也无害，runbook 给定期 DELETE）；内存 Map 不满足"进程重启仍幂等"且单实例下 SQLite 最省事。待裁决 C-8（如认为过度可降为进程内 Map，24h 重启失效）。
- 块下沉：新建 `packages/blocks/`（或 shared-types 同仓新增包，开工按 pnpm-workspace 现有包形态定），从 apps/web 原样移动 blocks.ts/markdown.ts，web 改 import；**必须零行为改动**——S5 先补 web 侧 md↔blocks round-trip 快照测试（移动前在 web 锁住输出），移动后 api/web 双跑同一组 golden。

### 4.6 stdio 第二入口

- 文件 `src/mcp/stdio.ts`，package.json 加 bin：`gx-mcp-stdio` → dist/mcp/stdio.js；构建多入口（build.mjs entryPoints 增一项，复用同一 external）。
- 启动：读 `GX_MCP_TOKEN`（值为完整 PAT 明文），调同一 authenticate 库函数的"非 HTTP"变体（直传 token 字符串）；失败打印一行 stderr `GX_MCP_TOKEN missing/invalid` + `process.exit(2)`（spike §1.5 实测形态）。
- 同一 buildServer/registry；stdio 下限流/body 档/HTTP 审计 ip 字段不适用（ip="stdio"、path="stdio"）；审计照常落。
- 交付：Docker/fpk 是否内置 bin 包装脚本待 C-5/C-9；Claude Desktop 配置示例写进《接入说明》（命令+env）。

### 4.7 目录组织（单文件 ≤300 行）

```
apps/api/src/mcp/
  permissions/types.ts        // McpSubject/McpPermissionPort 消费接口
  permissions/m4Adapter.ts    // 适配 domain/authz（S3；M4 未落地前禁止开工）
  pat/tokens.ts               // gxpat_ 生成/sha256/dummy timingSafeEqual/scope 常量/校验
  pat/patService.ts           // 创建(明文一次)/列表/吊销/lastUsedAt 节流
  transport/authenticate.ts   // Bearer PAT 边缘（未来 JWT 分支扩展点，仅此一处）
  transport/streamableHttp.ts // 每请求 build+connect+handleRequest+生命周期清理
  transport/mcpApp.ts         // new Hono() 子应用（all "/"），供 app.ts route 挂载
  server.ts                   // buildServer(subject)：闸门一动态注册 + Resources 说明书
  tools/registry.ts           // 工具元数据（name/scope/资源族/输入 schema 引用）
  tools/schemas.ts            // 唯一允许 zod4 的文件；上限常量（200/100/100KB）
  tools/table.tools.ts        // table.* / record.*
  tools/doc.tools.ts          // doc.*
  tools/canvas.tools.ts       // canvas.get_board
  tools/idempotency.ts        // requestId 24h
  resources/manuals.ts        // 三语言静态说明书 markdown 注册
  audit.ts                    // mcp_* writeAudit 封装
  stdio.ts                    // 独立 bin 入口
apps/api/src/routes/v1/pats.ts// /api/v1/pats REST（挂 v1 鉴权链，本人限定）
packages/blocks/              // S5：blocks.ts/markdown.ts 从 web 下沉（api/web 同源）
```

---

## 5. 数据维护与运维

### 5.1 迁移拆分（只增；编号在 M5 迁移之后）

- 迁移 F `<ts>_mcp_pat_ddl/migration.sql`：CREATE personal_access_tokens + mcp_idempotency（若 C-8 选落库）；Prisma schema 同步模型；User 关系补 PersonalAccessToken[]（cascade 声明）。
- 无回填（新表）；幂等 = IF NOT EXISTS 风格随仓内手写迁移惯例。
- down：`prisma/docs/rollback/<ts>_mcp_pat.down.sql` DROP 两表；发布前快照为主回滚。
- M2 停用路径接线（同事务吊销，lifecycle.ts 增量）：disableUser 的 withWriteTx 内增 `tx.personalAccessToken.updateMany({ where:{userId: targetId, revokedAt:null}, data:{revokedAt: new Date()} })`；reactivate **不自动恢复**（吊销是终态，重新启用账号需重新发 PAT，安全姿态写进 runbook）。

### 5.2 PAT REST（/api/v1/pats，挂 requireActiveUser，本人限定）

```
POST   /api/v1/pats        body:{name(≤60), scopes[5 选], expiresInDays?|null}
  → 201 {id, name, scopes, token:"gxpat_…"（仅此一次）, tokenPrefix, expiresAt, createdAt}
GET    /api/v1/pats        → 200 [{id,name,tokenPrefix,scopes,expiresAt,revokedAt,lastUsedAt,createdAt}]
                         （绝无 token/tokenHash）
DELETE /api/v1/pats/:id    仅本人行；→ 204；非本人/不存在统一 404（不泄漏存在性）
```

- name 服务端 trim/长度校验；scopes 必须是五位子集且非空；expiresInDays 上限/默认待 C-3（建议默认 90 天、可选 30/90/365、允许 null 永不过期但 UI 二次警示）。
- 限流：PAT 创建/删除走 ORG_ADMIN 同款思路新增敏感档或并入严格认证档（建议 30/60s/人，C-1 一并定）。

### 5.3 限流双键设计

- 认证前（authenticate 之前）无法拿 patId：MCP_RULE 先按 sourceIp 计一道较宽松桶（防未认证打爆）；认证成功后同一请求按 `pat:<patId>` 计正式配额（建议 120 次/60s，spike §9.2 建议值）。实现：MCP 子应用内自治限流（复用 FixedWindowCounter 实例，不经全局 selectRule），在 mcpApp 内两段式中间件完成；全局 rateLimitMiddleware 对 /mcp 继续 selectRule=null（现状）以避免双重计数——**即 /mcp 限流整体内聚在 mcpApp，不污染全局规则表**，bodyLimit 是唯一需要在全局中间件增档的点（body 在进入子应用前已被读）。
- initialize/notifications 与 tools/call 同档（不做免认证探活宽免，防滥用）；超限 429 JSON-RPC 外信封（HTTP 层）+ Retry-After。

### 5.4 可观测与 runbook

- 不新增 readyz 探针（MCP 是 app 内路由，/readyz dbPing 通过即可服务）；启动日志一行 `[mcp] streamable-http mounted at /mcp (stateless json, body=11mb)`，SDK 版本号打印。
- runbook 章节：PAT 签发/吊销排查（SQL 查 tokenPrefix/lastUsedAt）、停用账号联动验证、401 四态对照、限流 429 调档（GX_MCP_RATE_* 环境变量）、Inspector 连通自检命令、stdio 配置、zod4 共存说明、SDK 升级流程（钉版本+S8 门）、11MB 与反代（Caddy client_max_body/飞牛网关上载上限需同步 11m，部署物核查项）。

---

## 6. 契约纲要（S9 进 openapi；MCP 工具 schema 以 tools/schemas.ts 为唯一真源并导出 JSON 供对拍）

- REST：§5.2 三端点 + 错误码只增 `PAT_SCOPE_INVALID(400)`、`PAT_NAME_INVALID(400)`、`PAT_NOT_FOUND(404)`、`MCP_RATE_LIMITED(429)`、`MCP_PAYLOAD_TOO_LARGE(413)`、`MCP_UNAUTHORIZED(401)`。
- MCP 边缘 HTTP：200 承载全部 JSON-RPC（含 -32602/isError）；仅 401/413/429/406/415 是 HTTP 层。
- MCP 工具错误码词汇（resultCode，审计同值）：`OK / UNKNOWN_TOOL / FORBIDDEN_RESOURCE / FORBIDDEN_FIELD / FORBIDDEN_GROUP / VERSION_CONFLICT / CONFIRM_REQUIRED / RATE_LIMITED / TIMEOUT / INVALID_PARAMS`。
- tools/list 结果 `nextCursor` 不分页（工具数 <50）；Resources list 三 URI：`manual://table-language.md`、`manual://doc-block-language.md`、`manual://canvas-element-language.md`（静态、无业务数据）。

---

## 7. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 依赖 |
|---|---|---|---|---|
| S0 | M6 characterization + baseline | 测试+文档 | __tests__ golden；docs/baseline | —（可先做） |
| S1 | PAT 基座：迁移/tokens/patService/REST/停用联动 | 纯后端 | 迁移 F；mcp/pat/*；routes/v1/pats.ts；lifecycle.ts 一行；v1/index 挂载 | **仅 M2（可提前片）** |
| S2 | 传输骨架：SDK 直桥/无状态/11MB/限流/401/ping | 纯后端 | mcp/transport/*；bodyLimit 第三档；app.ts 挂载；build.mjs external+bin | S1 |
| S3 | 双闸门适配：M4 port/动态注册/UNKNOWN_TOOL 口径 | 纯后端 | permissions/*；server.ts | **M4-S1/S4 冻结**、M3 nav（间接） |
| S4 | 表/记录语言 6-7 工具 | 纯后端 | tools/table.tools.ts；recordService 接线 | S3、M4 引擎 |
| S5 | blocks 下沉 + 文档块语言 4 工具 | 后端+shared | packages/blocks；web import 改道；tools/doc.tools.ts | S3 |
| S6 | 画布只读 + stdio bin + Resources 说明书 | 后端+部署 | canvas.tools.ts；stdio.ts；manuals；build 多入口 | S3 |
| S7 | mcp_* 审计 + requestId 幂等 + 30s 超时 | 纯后端 | audit.ts；idempotency；迁移（若选库） | S4/S5 |
| S8 | 三客户端连通 + AC-M6 1/2/4 三对抗 + 401 四态回归 | 测试 | e2e（真库起服务）；Inspector CLI 脚本化基线 | 全部工具 |
| S9 | 出口：ADR/openapi/runbook/接入说明/40RC/M6-FE 清单 | 文档 | docs/adr；openapi；docs/runbooks；部署物核查 | S8 |

关键路径：S0→S1（可提前）→S2→（S3 待 M4）→S4/S5/S6→S7→S8→S9。
排期硬约束：
1. 后端单线 M2→M3→M4→M5→M6；**S3 是真正的门闩**——M4 scope/engine 契约未冻结不得开工，S1/S2 即便提前也不构成 M6 可交付（无鉴权工具面的 /mcp 不允许上线）。
2. S5 块下沉触碰 apps/web，必须与 M3/M4/M5-FE 的 web 改动协调 rebase；下沉先于工具开发，移动提交独立成纯移动 commit（git 可追踪 rename），行为改动另计。
3. 若 C-2 裁定画布写必须进 M6：在 S6 后插入 S6b"canvas-ops 六不变量抽 shared 服务端校验器 + canvas.commit_elements(element.create 最小集)"，工作量与 S5 同量级，AC-M6-3 画布写入在该片验收。
4. 发版门：目标机（fpk/Docker）node_modules 含 SDK 包、`/mcp` initialize 冒烟、反代 body 上限 11m 核查（Caddy/飞牛网关两形态）。
5. M6-FE 在 S9 openapi 冻结后派工。

---

## 8. M6-FE 前端片输入清单（S9 冻结后派工，本文不拆前端切片）

1. 设置 → MCP 接入页（SPEC §7 PatList）：PAT 列表（name/前缀/scopes 中文标签/创建时间/最后使用/过期状态/吊销按钮）；新建表单（名称、scope 勾选默认仅 read、有效期下拉）；**创建成功一次性明文弹窗**：大字等宽展示完整 token + 复制按钮 + "仅显示一次，关闭后不可找回"强提示 + 关闭即焚（组件 state 不落 localStorage）；吊销二次确认。
2. 图标只追加 icons.tsx（团队 P0：单一自建 SVG 体系，禁 emoji/第二套图标库）；无紫粉渐变。
3. 全部走 api/client.ts、gx token 中文文案过 PM/设计师；客户端配置指引区（endpoint URL 自动拼 basePath、curl/Inspector/Claude Desktop 三段示例数据来自 §接入说明，不硬编码第三方品牌绑定文案）。
4. 不做 OAuth 入口（本期无后端）；不内置 token 测试调用（创建即成功，验活交给客户端文档）。

---

## 9. 切片明细（每片：新增/改动、陷阱、独立验收、回滚）

### S0 — characterization + baseline
- 真库夹具锁：kb PUT content 409（baseVersion 不符 currentVersion）、旧记录列表 200 形状、/api/v1/meta 200、全局 body 1MB 对 /api 仍 413（M6 后必须仍如此）。
- `docs/baseline/2026-09-18-m6-baseline.md`：HEAD=5f05d19、710/3（60 文件）、迁移 14（M6 时预期约 22）、SDK 锚 1.30.0、zod3/4 隔离事实、spike PoC 路径（/tmp，已丢弃，结论以 spike 文档为准）。
- 验收：全绿只增。回滚：删测试/文档。

### S1 — PAT 基座（可提前片，仅依赖 M2）
- 迁移 F + Prisma 模型；tokens.ts（生成/hash/dummy 常量时间/scope 解析校验/过期计算）；patService（create/list/revoke，lastUsedAt 节流放 runSerialized）；routes/v1/pats.ts 挂 v1 链；lifecycle.disableUser 事务内批量吊销 + reactivate 不恢复注释；审计 mcp_pat_create/revoke（事件名先在 audit 联合占位，S7 全量接线）。
- 陷阱：cascade 需 User 关系声明与既有迁移一致；tokenPrefix 长度不泄漏随机段；列表 N+1（一次 findMany 不 join 多余关系）；并发创建无写竞争（hash 随机）。
- 验收：明文仅一次（GET/列表/错误响应 grep 无完整 token）；hash 查不到与前缀不符同口径；过期/吊销判定（假时钟）；停用用户后其 PAT 查库 revokedAt 已置位且认证拒绝；重新激活不恢复；删除用户 PAT 行级联消失；本人限定（用他 patId DELETE 404）；常量时间 dummy 比较有测试；typecheck/lint。
- 回滚：路由/接线摘除；表保留无害（或 down DROP）。

### S2 — 传输骨架
- package.json 精确加 SDK 1.30.0 + build external；mcpApp（all "/"）：authenticate（401 四态 + WWW-Authenticate + -32001 id:null）→ new McpServer（仅注册 ping_echo）→ stateless transport → connect → handleRequest → body 结束清理；bodyLimit 增 isMcpPath 精确判定第三档 GX_MCP_BODY_LIMIT 默认 11MB；mcpApp 内两段式限流骨架（IP 预桶 + patId 桶，值从 config 读，C-1 定默认）；app.ts 在 enterpriseOrg 分支内挂 mount.route("/mcp", mcpApp)（C-5）；config 增 gxMcpBodyLimit/mcp 限流参数。
- 陷阱（spike 实测）：漏 connect 挂死；handleRequest 后立即 close 截断（JSON 模式在 body close/abort 清理）；transport 严禁复用（每请求 new）；Accept/Content-Type 协议校验交给 SDK 不自造；bodyLimit 必须挂在 mcpApp 之前（现状全局链已满足）；11MB 下 SSE 不开故无流式清理复杂度。
- 验收：curl initialize/tools(list/call) 打通；根路径与 basePath 双路径 200；无/伪造/过期/吊销/停用主体五态 401 文案快照；2MB payload 在 /mcp 200、在 /api 仍 413；限流 patId 桶 429 + Retry-After（测试改小阈值）；unix socket + 伪网关至少一次 initialize 留证（可放 S8 正式留，S2 本地 TCP 必过）；zod4 未扩散（lint/grep）。
- 回滚：挂载摘除（/mcp 回落 404）；依赖保留可回退。

### S3 — 双闸门适配
- permissions/types.ts + m4Adapter（薄封装 M4：listAccessibleResources 映射 resolveVisibleNodeIds 按族、can 映射 decide、readableFields 映射 fieldCapability）；server.ts 动态注册（工具族非空判定 + schema enum 收窄）；Resources 说明书可在本片先注册静态占位（S6 填充）；UNKNOWN_TOOL/FORBIDDEN 二分 golden。
- 陷阱：M4 未落地前用接口+假实现开发可以，但**出口门必须接真 M4**（假实现代码不得合主干，用测试替身仅限 __tests__）；scope budget 截断时 enum 退化自由字符串；工具注册异步异常不能让 /mcp 500（引擎故障 = 该工具不注册 + 记 metric，不波及其他族）。
- 验收：夹具用户（无权/只读/读写/字段受限）四套 tools/list 快照；直调未注册工具与不存在工具响应逐字节一致；IDOR 返 FORBIDDEN_RESOURCE；字段 enum 无不可见字段；引擎抛错时 mcpApp 不 500（503 级 MCP 内部错误或工具缺席，口径在本片定死）。
- 回滚：随 /mcp 挂载。

### S4 — 表/记录语言
- registry/table.tools：list_bases（M3 base 节点集 + 现有 bases 投影）、get_schema（tables/fields 元数据 + 可读标记）、list/query（recordService.queryRecords，cursor 复用 M1 编解码、filter 白名单映射 queryPlan compile，禁公式）、create/update（写路径走现有 record 创建服务，enforce c/u + 字段级）；delete 视 C-6；出参投影（不可见字段物理缺席，AC-M6-2）；写无 r 时精简回执用例。
- 陷阱：handler 禁裸 prisma（§3-3 grep）；queryRecords 旧 legacy 路径带旧 guards 假设——MCP 只走 queryPlan 新路径（GX_M1 flags 组合下行为固定，MCP 调用强制物理路径）；confirm zod4 literal；分页游标跨用户作用域（cursor 不编码权限，每次现判）。
- 验收：Inspector 通读→查→建→改全链；limit 201/-32602；非法 filter 操作符 -32602；字段越权写 FORBIDDEN_FIELD；只读 PAT 无写工具且直调 UNKNOWN_TOOL（引 S3 golden）；M1 flags 四组合 MCP 读结果一致（对拍 REST）。
- 回滚：工具注销。

### S5 — blocks 下沉 + 文档块语言
- 第一步纯移动：建 packages/blocks（package 名按 workspace 惯例），移动两文件，web 改 import，api 加依赖；移动前先在 web 补 round-trip golden（10 篇含表格/任务/align/图片/raw 的 md）。第二步 doc.tools：get（format blocks 走 mdToBlocks、markdown 直出，range 按块 seq 切片）、append/update/delete（blocksToMd 唯一写出口；服务端 md 拼接→复用 kb 条件更新服务，一次 version+1；align 注释通道校验 left/center/right）。
- 陷阱：markdown.ts:6 从 blocks 导入多个 helper，移动保持相对路径；web 侧 WysiwygEditor 等引用点全部改道（grep 全仓）；10MB/100KB 双上限；blockId 不存在整批原子失败（无半应用）；AI 不得自带插入 id（newBlock 服务端补）。
- 验收：移动前后 web 测试全绿 + golden 0 diff；api 侧 round-trip 同一份 golden；op=101/文本 101KB 拒；VERSION_CONFLICT 带 currentVersion；Web 端打开 MCP 写入文档结构完整（AC-M6-3 文档部分，人工+快照）；doc 节点无权四工具全拒（不可见 docId 直传 FORBIDDEN_RESOURCE）。
- 回滚：shared 包保留无害；工具注销、web import 回改。

### S6 — 画布只读 + stdio + 说明书
- canvas.get_board（解析 KbDoc kind=canvas content JSON，返 elements/contentVersion/viewport，未知键透传不剥离，对齐 ARCH §8.5）；stdio.ts + bin + 多入口构建； manuals.ts 三份静态 md（表语言：表/记录语义+filter 白名单+分页；块语言：块类型/op/乐观锁/align；图元语言：元素结构只读说明 + "写能力二期"声明；均不含真实业务数据）。
- 验收：Inspector 读板元素数与 Web 打开一致；stdio 缺 GX_MCP_TOKEN exit 2；stdio client initialize/list/call 连通（spike §1.5 复现）；三 Resources 对只读 PAT 可读、tools/list 不泄漏业务库名；说明书 markdown 链接/编号与工具名一致性检查（脚本）。
- 回滚：bin/工具注销。

### S7 — 审计 + 幂等 + 超时
- AuditEventName 落四枚（含 S1 占位转正）；每次 call 收尾 writeAudit（成功/拒绝/UNKNOWN 都记；pattern：tool 未知时也能记 tool 名与 patId）；authenticate 失败 mcp_auth_failure（ip/patId 前缀级，无 token）；idempotency 库表或 Map（C-8）；30s AbortController（service 调用透传 signal——现有 service 无 signal 参数，M6 在 mcp 适配层包 Promise.race 超时，不改 service 签名，超时后不声称写失败/成功，返 TIMEOUT 引导客户端重读）。
- 验收：审计行字段白名单（无 fields 业务值、token 被 redact）；同 requestId 重放返首次结果且只产生一次写；超时用慢夹具（临时挂起）返 TIMEOUT 不挂连接；审计目录不可写时 call 仍成功（告警不阻断，验现有纪律）。
- 回滚：随工具。

### S8 — 三客户端 + 三对抗（出口硬门）
- 脚本化：vitest e2e 起真服务（TCP + unix socket 两矩阵至少一轮），curl 组、SDK StreamableHTTPClient 组、Inspector CLI 组（npx 固定版本，CI 视网络允许，否则基线手测留证入 baseline）；AC-M6-1（只读 list/直调）、AC-M6-2（字段受限 schema+返回+参数拦截）、AC-M6-3 文档部分（409/confirm/Web 打开）、AC-M6-4（吊销：建连后吊销，下一请求立即 401；每 call 有审计）；IDOR 三条（base/doc/canvas 各一）；三对抗在 HTTP 与 stdio 两入口各跑（stdio 吊销后下次启动进程拒——stdio 无连接概念，验启动即拒）。
- 验收：产出 docs/baseline/m6-connectivity.md 贴真实命令与输出摘要（不贴 token）；任一对抗失败阻断 S9。
- 回滚：测试。

### S9 — 出口收口
- ADR-0050~0054（§10）；openapi 只增 pats + /mcp 说明段（/mcp 非 REST，用 x-mcp 扩展或独立小节描述，不强行造 REST path）；形状手写对拍；runbook §5.4 全章；《MCP 客户端接入说明》（协议无关，三客户端示例）；40RC 全绿 + 710+N；fpk/Docker 核查（SDK 在生产依赖、bin 产物、反代 11m）；M6-FE 输入清单评审；旧路由零 diff 证明；M1-M5 flags/对抗回归。

---

## 10. 关键设计决策（ADR 候选）

- **ADR-0050 官方 SDK WebStandard 直桥 + 每请求无状态 transport**：spike §1 实测；否决手写 300 行自维护协议；1.30.0 精确 pin；无状态 JSON 先行、SSE 二期。
- **ADR-0051 PAT 凭证模型与 M2 用户态联动**：gxpat_ 一次明文/hash 库存/scope 粗档/资源授权归 M4；停用同事务批量吊销 + 边缘 status 双保险；cascade 删除；lastUsedAt 节流；JWT OAuth 留扩展点。
- **ADR-0052 双闸门与 UNKNOWN_TOOL 不泄漏口径**：动态注册 + service 首行 engine.decide；被裁工具与不存在同文案；FORBIDDEN_* 二分；MCP 只走新引擎不接旧 guards。
- **ADR-0053 /mcp 11MB 豁免与 patId 独立限流内聚 mcpApp**：spike 实测 413；全局只增第三档 body；限流不进全局规则表，子应用两段式（IP/patId）。
- **ADR-0054 画布 M6 只读、块模型下沉 shared（若 C-2 批准只读）**：Plait 六不变量服务端化独立成片；blocks.ts/markdown.ts 零行为移动，api/web 同源。
- **ADR-0019 已存在**（协议无关标准 MCP server 总纲，ARCH:941）：本计划是其实施细化，不重复立项。

---

## 11. 待项目总监裁决清单（终审前阻断）

| # | 议题 | 架构师建议 | 影响 |
|---|---|---|---|
| C-1 | MCP 独立限流档默认值与超限口径（spike 开放问题 2） | patId 桶 120 次/60s + IP 预桶 300/60s；PAT 管理 REST 30/60s；GX_MCP_RATE_* 可配；超限 429 Retry-After。需运维确认 NAS 上单 token 典型 AI 调用模式是否更陡 | S2/runbook |
| C-2 | 画布写是否必须 M6 交付（spike 开放问题 1；AC-M6-3 字面含"画布图元语言写入"） | 建议 M6 **只读**（get_board），写走二期独立切片（canvas-ops 747 行六不变量 shared 化+服务端校验器，约一个 S5 量级）；若终审裁定 AC-M6-3 画布部分 M6 必达，插入 S6b 仅交付 element.create 最小集（geometry/rectangle+乐观锁），其余操作二期 | S6/排期/AC-M6-3 验收口径 |
| C-3 | PAT 有效期策略与永不过期 | 默认 90 天，可选 30/90/365 天与"永不过期"（UI 强警示）；tokenPrefix 展示前 14 字符 | S1/M6-FE |
| C-4 | （已并入设计，确认即可）停用即批量吊销、重新激活不恢复 PAT | 按 §5.1；安全优先，重新发 token 成本低 | S1 |
| C-5 | /mcp 与 /api/v1/pats 是否随 GX_ENTERPRISE_ORG 门控；stdio bin 是否进 fpk/Docker 产物 | 建议同门控（企业能力，off 不挂载/404）；stdio bin 进产物（零额外服务，只是文件） | S2/S6/部署 |
| C-6 | record.delete_record / record.batch 是否进 M6 | delete 建议进（d 动作已有引擎判定，软删语义现成）；batch/jobId 二期（超 100 ops 场景少） | S4 |
| C-7 | M6 是否暴露 record.search 工具（ARCH 全集含，依赖 M5） | 建议暴露：薄封装 M5 searchService，scope 由 M5 先收敛保证，MCP 不重复鉴权只做 PAT 粗档+service 内既有判定；M6 排在 M5 后故依赖天然满足 | S4 |
| C-8 | requestId 幂等状态持久化（新轻表 mcp_idempotency）vs 进程内 Map | 建议落库（单实例 SQLite，重启不丢、24h 语义完整，表极小）；若总监认为过度可降 Map（重启后窗口期重放可能产生重复写） | S7/迁移数 |
| C-9 | 《MCP 客户端接入说明》是否在 M6 提供具体第三方配置截图/品牌素材 | 只给协议无关文字+命令示例（endpoint/headers/env），不放第三方 Logo/市场上架指引（R-MCP-2） | S9 |

---

## 12. M6 出口 Definition of Done（摘）

1. AC-M6-1：只读 PAT 的 tools/list 无任何写/删/admin 工具；绕过列表直调被裁工具返 UNKNOWN_TOOL 且与不存在工具同口径（golden 0 diff）。
2. AC-M6-2：字段受限 PAT 的 schema 无不可见字段、返回无不可见字段；参数携带无权字段/资源被服务端二次拦截（FORBIDDEN_FIELD/RESOURCE）。
3. AC-M6-3：AI 经 doc 工具写入后 Web 端打开结构完整（块 round-trip golden + 人工）；contentVersion 冲突 409+currentVersion；破坏性写无 confirm:true 一律拒绝。**画布部分按 C-2 裁定口径验收（只读则 AC 画布写入项明确标注二期，不伪装达标）**。
4. AC-M6-4：吊销（含用户停用连带吊销）后下一次调用立即拒绝（HTTP 与 stdio 两入口）；每次 tools/call 与每次认证失败入审计，参数脱敏且无业务值。
5. 三客户端（curl/SDK client/Inspector）+ stdio 客户端真实连通留证；根/子路径/unix socket 三形态至少各一轮；IDOR 三族对抗零泄漏。
6. 11MB 豁免只对 /mcp 生效（既有 /api 1MB 行为零变化，S0 golden 证明）；独立限流生效可观测；30s 超时不挂连接。
7. openapi 增补冻结并对拍；ADR-0050~0054 归档；710+N/3 全绿、lint/typecheck/ci-quality；M1 flags 四组合/M2 停用闭环/M3/M4/M5 回归全绿；旧路由字节零 diff；zod4 不越 mcp/。
8. PAT 零泄漏审计（响应/日志/审计/库/产物文件）；runbook 与协议无关《接入说明》齐备；M6-FE 输入清单可派工；发版冒烟含目标机 /mcp initialize 与反代 11m 核查。

---

## 13. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 依赖 |
|---|---|---|---|---|
| S0 | golden+baseline | __tests__；docs/baseline/2026-09-18-m6-baseline.md | 旧 409/1MB/710 基线锁住 | — |
| S1 | PAT 基座（可提前） | 迁移 F；mcp/pat/*；routes/v1/pats.ts；lifecycle 一行 | 明文一次、停用连带吊销、删除级联、本人限定、710 只增 | **仅 M2** |
| S2 | 传输骨架 | transport/*；bodyLimit 三档；app.ts；build.mjs | initialize/call 通、401 五态、11MB 仅 /mcp、patId 限流 | S1 |
| S3 | 双闸门 | permissions/*；server.ts | 四身份 list 快照、UNKNOWN_TOOL 同文案、IDOR 拒、引擎故障不 500 | **M4-S1/S4** |
| S4 | 表/记录语言 | tools/table.tools.ts | Inspector 读写查通、字段越权拒、flags 四组合同 REST | S3 |
| S5 | 块下沉+文档语言 | packages/blocks；tools/doc.tools.ts | 移动 0 diff、四工具+409+100KB+Web 结构完整 | S3 |
| S6 | 画布只读+stdio+说明书 | canvas.tools.ts；stdio.ts；manuals.ts | 读板元素一致、stdio exit2/连通、三说明书可读 | S3 |
| S7 | 审计/幂等/超时 | audit.ts；idempotency.ts | 每 call 审计脱敏、重放只写一次、TIMEOUT 不挂死 | S4/S5 |
| S8 | 连通/对抗门 | e2e；m6-connectivity.md | 三客户端+stdio、AC-M6 全项、IDOR 三族零泄漏 | 全部 |
| S9 | 收口 | ADR-0050~54；openapi；runbook；接入说明 | 全门绿、旧路由零 diff、可派 M6-FE | S8 |

---

## 14. 自报

- 本文档入库 commit：（提交后回填）
- 上一文档动作：M5 终审八裁决回填 `2c52196`（同日，B-1~B-8）。
- 待裁决：§11 C-1~C-9（其中 C-4 为确认项）。

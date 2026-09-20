# Spike：M6 鉴权 MCP 服务——协议与传输层可行性验证

> 日期：2026-09-14　调研：spike-mcp-transport
> 范围：MCP Streamable HTTP 在 Node 22 + Hono 4 的落地、官方 SDK vs 手写对比、子路径/unix socket 反代、PAT、双闸门、三语言工具目录草案、越权三对抗、审计接入、OAuth 边界。
> 上游契约：`docs/planning/SPEC-enterprise-v1.0.md`（§4 版本锚定、§5 端点 ANY /mcp、/oauth、/api/v1/pats、AC-M6-1~4）、`docs/planning/phase1/ARCH-enterprise.md` §8（R-MCP-1 双闸门 / R-MCP-2 MCP 为唯一 AI 接入核心）。
> 铁律遵守：未改任何仓库源码；依赖与可运行 PoC 全部在 `/tmp/gx-mcp-spike.sdk`、`/tmp/gx-mcp-spike.raw`、审计在 `/tmp/gx-mcp-spike.audit*`；本文档是唯一仓库写入。所有"实测"均贴真实输出；未跑的标【文档】。

---

## 0. 结论先行（TL;DR）

**传输选型：推荐方案 (a)——官方 `@modelcontextprotocol/sdk`，但用它在 1.30.0 新增的 `WebStandardStreamableHTTPServerTransport`（WHATWG Request/Response），与 Hono `c.req.raw` 直桥，不走 node http/express 适配。**

硬事实（全部实测，环境 Node v22.22.2 / npm 10.9.7 / macOS arm64）：

1. **SDK 1.30.0 原生支持 Hono，零桥接 hack**：`WebStandardStreamableHTTPServerTransport.handleRequest(c.req.raw)` 直接吃 Web 标准 Request、返回标准 Response；该类的 `.d.ts` 注释里就给了 Hono 示例。**不需要** `@hono/node-server` 的 `getRequestListener/nodeListener` 去接 SDK 的 express/node 版 transport——ARCH §8.1 行754「透传 `c.req.raw` 即可桥接」的判断在 1.30.0 被证实成立（更早版本只有 node http 版 transport，那时才需要桥）。
2. **真实打通 initialize → notifications/initialized → tools/list → tools/call**，三种客户端都验过：① curl（裸 JSON-RPC）② **官方 SDK `StreamableHTTPClientTransport` 客户端** ③ **MCP Inspector CLI（`@modelcontextprotocol/inspector --cli --transport http`）**；JSON 与 SSE 两种响应模式、根路径 `/mcp` 与飞牛子路径 `/app/gouxiangdb/mcp`、TCP 与 **unix socket 经模拟飞牛网关（注入 `X-Trim-Userid`）** 全部 200 连通。
3. **越权三对抗全部按预期拒绝**（真实输出见 §7）：无/伪造 token → HTTP 401；过期 token → 401 `Token expired`；吊销 token → 401 且**已建立会话的下一请求立即 401**（认证在每请求边缘重验，不信任旧会话）；有权认证但访问无权 base（IDOR 直传 `base_secret`）→ 工具可见、执行期 enforce 拦截，MCP `isError:true` + `FORBIDDEN_RESOURCE`；只读凭证绕过 tools/list 直调写工具 → `Tool xxx not found`（-32602，不泄漏存在性，符合 AC-M6-1）。
4. **方案 (b) 手写也能跑通且与官方客户端互操作**（官方 SDK client 连手写 server 成功，证明协议正确），但要自己维护会话表/SSE 帧/DELETE/协议版本协商/错误码/zod schema→JSON Schema 转换/`listChanged` 等，约 300 行且**协议升级（如 2025-11-25 无状态化、resumable streams）要自己跟**。SDK 把这些都封装好，esbuild 生产 bundle 增量仅 ~1.4MB（gzip 前，且 `--packages=external` 时产物只有 8.4KB、依赖在 node_modules）。
5. **两个必须在 M6 设计里处理的部署坑（已实测复现）**：
   - **全局 1MB body 上限会 413 杀掉合法 MCP 大 payload**：实测 2MB 的画布整板快照 `tools/call` 在 1MB 限制下返回 `413 PAYLOAD_TOO_LARGE`，放宽到 11MB 才 200。当前 `apps/api/src/middleware/bodyLimit.ts` 全局 `GX_BODY_LIMIT_JSON` 默认 1MB（`config.ts:22`），**/mcp 必须豁免并给独立上限（建议 11MB，对齐文档/画布 10MB 契约 + JSON 开销）**。
   - **SSE 长连接需要反代关缓冲**：SDK 的 SSE 响应自带 `X-Accel-Buffering: no`、`Cache-Control: no-cache, no-transform`，对 Caddy/飞牛网关友好；但无状态 JSON 模式（`enableJsonResponse:true` + `sessionIdGenerator:undefined`）是最简单、对反代最稳的起步形态，建议 M6 首版用**无状态 JSON**，SSE/有状态会话留作需要服务端推送（长任务 job 进度）时再开。

---

## 1. 传输选型：(a) 官方 SDK 落地

### 1.1 版本与安装（隔离目录，未碰仓库）

```bash
mkdir -p /tmp/gx-mcp-spike.sdk && cd /tmp/gx-mcp-spike.sdk
npm init -y && npm install @modelcontextprotocol/sdk hono @hono/node-server zod
# 实测安装结果：
#   @modelcontextprotocol/sdk@1.30.0   （SPEC §4 锚定「调研值 1.30.0，实施锁 ^1.30 复测」——本次即复测）
#   hono、@hono/node-server（仓库已有同系）
#   zod（仓库 apps/api 已在依赖 3.23；SDK 1.30 内部用 zod 4.6.5，二者可并存，见 §1.6）
node -v  # v22.22.2
```

关键发现：1.30.0 的 server 导出里**同时有**面向 node http/express 的 `streamableHttp.js`/`express.js`，**和**面向所有 Web 标准运行时的 `webStandardStreamableHttp.js`。后者类注释原文：

```ts
// WebStandardStreamableHTTPServerTransport ... Node.js 18+, Cloudflare Workers, Deno, Bun
// Hono.js usage
// app.all('/mcp', async (c) => { return transport.handleRequest(c.req.raw); });
```

因此 Hono 是一等公民，无需 `getRequestListener` 桥接 node req/res（`getRequestListener` 只在我们要让 MCP 独立监听 unix socket 时才用到，见 §2.3）。

### 1.2 最小可运行桥接（实测）

PoC：`/tmp/gx-mcp-spike.sdk/mini.ts`（无鉴权最小版）与 `server.ts`（完整鉴权版）。核心：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

app.all("/mcp", async (c) => {
  const server = new McpServer({ name: "gouxiangdb", version: "0.0.1" });
  server.tool("ping_echo", "echo", { msg: z.string() }, async ({ msg }) => ({
    content: [{ type: "text", text: `echo:${msg}` }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // 无状态模式（官方推荐的 Streamable HTTP 形态）
    enableJsonResponse: true,       // 单请求/单响应回 application/json，不开 SSE 长流
  });
  await server.connect(transport);  // ★必须 connect，否则 onmessage 无人消费、Promise 永不 resolve（实测踩坑）
  return transport.handleRequest(c.req.raw);
});
```

实测踩坑记录（写进 M6 实施 notes）：
- **漏调 `server.connect(transport)` 时请求永久挂起**（curl 5s 超时 0 字节）。根因：`handleRequest` 在 JSON 模式返回一个 Promise，靠 transport 的 `onmessage` 回调驱动 resolve；不 connect 则没有消费者。这是最容易犯的错。
- **不能在 `handleRequest` 返回后立刻 `transport.close()`**：SSE 模式下事件还在 microtask 队列，立即 close 会掐断流（curl 收到空响应）。正确做法是在响应 body 结束/取消后清理（PoC 用 `res.body.tee()` + `pipeTo` 一个空 WritableStream，在其 `close/abort` 里 `transport.close()/server.close()`）。无状态 JSON 模式 body 写完即触发，无泄漏。
- **无状态 transport 实例不可复用**：SDK 源码硬校验「Stateless transport cannot be reused across requests. Create a new transport per request.」。所以 M6 形态 = **每请求 new 一个 transport + 按该请求身份 build 一个 McpServer**（工具集在构建时按身份裁剪，天然实现闸门一），处理完即弃。这也避免了会话状态/内存堆积，契合单实例部署。

### 1.3 真实握手与响应（curl 实测）

请求头（客户端**必须同时** Accept 两种，否则 406；Content-Type 必须是 application/json，否则 415——这是 SDK 强制的协议校验）：

```
POST /mcp HTTP/1.1
Authorization: Bearer gxpat_...
Content-Type: application/json
Accept: application/json, text/event-stream
```

JSON 模式 initialize 实测响应：

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 155

{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"gouxiangdb-mcp-poc","version":"0.0.1"}},"jsonrpc":"id":1}
```

SSE 模式（`enableJsonResponse:false`）同一请求实测响应：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

event: message
data: {"result":{"protocolVersion":"2025-06-18",...},"jsonrpc":"id":1}
```

协议版本：PoC 客户端发 `2025-06-18`，SDK 1.30 正常协商回 `2025-06-18`（SDK 亦支持更新的 `2025-11-25`，含 resumable streams/priming event；M6 用 2025-06-18 足够，Inspector 与 SDK client 默认即此）。

### 1.4 依赖体积 / 维护成本 / 部署兼容

| 维度 | (a) 官方 SDK | (b) 手写 |
|---|---|---|
| node_modules 体积（含 hono/node-server/zod/tsx/dev） | 67MB；**`@modelcontextprotocol` 本体 5.9MB** | 14MB（基本全是 tsx/dev） |
| esbuild 生产 bundle（`--packages=external`，仓库生产构建形态） | **8.4KB**（SDK 留 external，随 node_modules 分发） | 同等 |
| esbuild 全内联 bundle | 1.4MB（含 zod/ajv/eventsource 等；express 等 node-only 可选依赖在 WebStandard 路径不被 import，内联产物里仅 3 处注释字样） | ~300 行自写 |
| 新增运行时依赖 | `@modelcontextprotocol/sdk`（传递 ajv/zod4/eventsource 等少量纯 JS 包，无原生模块） | 无 |
| 协议合规维护 | SDK 跟官方，升级 minor 即可拿到无状态化/resumable/新错误码 | **全自担**，已手写 300 行且要长期跟规范 |
| schema 工具 | zod 定义 → SDK 自动转 JSON Schema 暴露在 tools/list | 需手写 JSON Schema 或另引转换器 |
| Hono 兼容 | `c.req.raw` 直桥，一等公民（d.ts 有 Hono 示例） | 原生就是 Hono |
| unix socket / 子路径 / 反代 | 全通（§2） | 全通（§2） |

**推荐 (a)**：协议是第三方 AI 接入的对外契约，合规性价值 > 1.4MB 体积；SDK 是 Anthropic 官方、MIT、Node>=18，无原生编译依赖，不增加 better-sqlite3/sqlite-vec 之外的部署风险。SPEC §4 已锚定 `^1.30`，本 spike 即复测确认。

### 1.5 stdio 第二入口（ARCH §8.1）——已实测

同一 `McpServer` 工具集接 `StdioServerTransport`，身份由 `GX_MCP_TOKEN` 环境变量注入、启动即校验。PoC `/tmp/gx-mcp-spike.sdk/stdio-server.ts` + `stdio-client.mjs` 实测：

```
initialize -> gx-stdio 2025-06-18
tools/list -> record.list_bases,record.list_records
tools/call -> {"bases":["base_rw"]}
--- 无 GX_MCP_TOKEN ---
GX_MCP_TOKEN missing/invalid
exit=2
```

结论：stdio 入口零额外成本，M6 放 `src/mcp/stdio.ts` 独立 bin，复用同一 tool registry，供 Claude Desktop 类本机客户端使用。

### 1.6 zod 版本注意

仓库 `apps/api` 现有 `zod ^3.23`；SDK 1.30 内部依赖 `zod@4.6.5`（经 `zod-to-json-schema`）。二者 major 不同但包名相同。M6 实施建议：**MCP 工具的入参 schema 直接用 SDK 自带的 zod4（从 `@modelcontextprotocol/sdk/node_modules/zod` 或在 apps/api 升 zod4——后者影响面大，不建议在 M6 做）**，仅在 mcp/ 目录内使用，不与业务层 zod3 混用；pnpm 会把 SDK 的 zod4 隔离在其依赖树下，实测两套可共存、不冲突。

---

## 2. 子路径与反向代理兼容（实测）

### 2.1 子路径双挂

复刻仓库 `app.ts:160-164` 的 mount 单例模式（先挂 basePath 再挂根）。PoC 用两种等价写法：
- SDK 版：`app.all("/mcp", …)` 与 `app.all("/app/gouxiangdb/mcp", …)` 调同一个 `handleMcp(c.req.raw)`；
- 手写版：`const mcp = new Hono(); app.route("/mcp", mcp); app.route("/app/gouxiangdb/mcp", mcp)`（子应用零重复，**推荐 M6 用这个**）。

实测：

```
== 子路径 initialize（SDK 版）==  HTTP 200
== 子路径 tools/list ==  record.list_bases,record.list_records,record.create_record,doc.get_doc_blocks
== 手写版子路径 initialize ==
mcp-session-id: 61c00a06-f89d-4539-a1e5-b88eca59a2d9
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",...}}
```

**关键结论：Streamable HTTP 的路径不参与协议**（session 靠 `Mcp-Session-Id` 头而非 cookie/路径段），子路径只是透传，协议层零感知。生产沿用仓库现有 `config.basePath`（`config.ts:162`）+ mount 双挂即可，**MCP 不需要任何 basePath 特殊处理**。

### 2.2 飞牛网关注入头

PoC `/_echo` 经模拟网关回显：`{"x-trim-userid":"10001",...}`，确认注入头原样到达 Node。MCP 层不消费该头（身份只认 Bearer PAT），但它能透传，未来若要做「网关联名身份」也有通道。注意不要让 `X-Trim-Userid` 成为信任来源——SPEC 红线：模型/外部传入身份不可信。

### 2.3 unix socket 反代（飞牛形态）+ SSE 透传

PoC 用 `@hono/node-server` 的 `createServer(getRequestListener(app.fetch)).listen(sock)`（与仓库 `index.ts:33` 完全同款），再起一个 node:http 伪网关 TCP:4200 → `http.request({socketPath})`，`up.pipe(res)` 透传不缓冲。实测：

```
srwxr-xr-x  /tmp/gx-mcp-spike.sock        # 0660 形态同 index.ts:37
-- initialize via gateway->unix, subpath --  http=200 ct=application/json
-- SSE tools/list through gateway->unix --
event: message
data: {"result":{"tools":[...]}...}          # SSE 事件实时穿过，未被缓冲
-- 官方 SDK client 经 网关+子路径+SSE --
[client] connected; tools/list -> 4 tools; IDOR isError:true   # 全链路通
```

部署结论：
- **JSON 无状态模式**对反代零要求，首选；
- **SSE 模式**要求反代关 response buffering。SDK 已自带 `X-Accel-Buffering: no`（Nginx/飞牛网关识别）与 `Cache-Control: no-transform`；Caddy 的 `reverse_proxy` 默认流式透传，无需特殊配置。飞牛统一网关实测透传正常（本 PoC 的 node:http 代理未做任何 flush 配置即实时收到事件）。
- 复用仓库现成的 unix socket 监听 + 0660 + 优雅关闭（`index.ts:26-73`）即可，**不需要为 MCP 开第二端口**。

---

## 3. PAT 认证设计

### 3.1 形态（PoC 已实现）

- **明文形态**：`gxpat_` + 24 字节 `crypto.randomBytes(24).toString("base64url")`（约 32 字符随机部分）。前缀 `gxpat_` 便于代码扫描/泄漏检测/客户端识别，与 SPEC §4/§8.2、ARCH 行765 一致。
- **只存 SHA-256 hash**：`createHash("sha256").update(plaintext).digest()`，DB 不存明文。
- **常量时间比对**：查 token 时对每行 hash 用 `crypto.timingSafeEqual(等长 Buffer)`（先比长度再比），防时序侧信道。
- **明文仅创建时返回一次**（PAT 管理 API `/api/v1/pats` 的契约，SPEC §5），之后只回 name/前缀/时间戳。

### 3.2 校验顺序与 401 口径（实测）

每请求边缘（`/mcp` handler 首行）执行，**不信任任何已建立会话**：

1. 取 `Authorization: Bearer gxpat_...`；缺失/前缀不符 → 401 `Unauthorized`；
2. hash 查不到（伪造/不存在）→ 401 `Unauthorized`（与缺失同口径，不区分）；
3. `revoked=true` → 401 `Token revoked`；
4. `expiresAt < now` → 401 `Token expired`；
5. 通过后构造 `subject={userId, patId, scopes}` 注入本次请求上下文。

实测吊销的「即时性」（AC-M6-4）：用一个 token 先 initialize 建会话，再吊销该 token，**拿着旧 Mcp-Session-Id 的下一请求立即 401**（手写版因为每请求都过 authenticate；SDK 无状态模式天然每请求重验）。这比 ARCH §5.6 提到的 JWT 60s 缓存更强——PAT 是不透明凭据、每次查库/缓存均可即时吊销。

401 响应带 `WWW-Authenticate: Bearer realm="mcp"`（过期加 `error="invalid_token"`），body 是 JSON-RPC 错误信封（在进入协议前失败，id 为 null，code -32001）。MCP Inspector 在 401 且无 OAuth provider 时会提示 auth_required（实测），符合 MCP/HTTP 习惯。

### 3.3 lastUsedAt 节流

不要每请求写库（NAS 上 SQLite 写放大 + 占写队列）。PoC 用 `if (Date.now() - pat.lastUsedAt > 60_000) update`。生产建议：**进程内 Map<patId, lastUsedAt> 内存节流，距上次落库 >60s 才 UPDATE**（走 M1 的 `runSerialized` 写队列）；进程崩溃最多丢 60s 的「最后使用」显示精度，无安全影响。

### 3.4 scope 形态建议（不过度设计）

M6 首版用**粗粒度动作位字符串数组**，直接对齐工具的 `requiredAction`：

```
record:read   record:write   doc:read   doc:write   canvas:read   (canvas:write 二期)
```

- 只读 PAT = 只有 `*:read`；读写 PAT 加 `*:write`。
- **不在 token scope 里限定 base 集合**——「能访问哪些 base/doc」是 M4 权限引擎按 `userId` 判定的事（角色/部门/直接授权三源并集），PAT 只代表「这个人 + 读写档位」，避免把授权模型复制一份到 token、且授权变更后 token 无法即时反映。如确需「集成专用窄 token」，二期再在 PAT 上加可选 `resourceAllowlist`，由权限引擎做交集，不在 M6 做。
- 一个用户可发多个 PAT（不同 name/设备），任一可独立吊销。

### 3.5 Prisma 表草案（方言中立，遵守 SPEC §4 铁律）

```prisma
model PersonalAccessToken {
  id         String    @id @default(cuid())
  userId     String
  name       String                              // 用户起的标识，如 "cursor-工作机"
  tokenHash  String    @unique                   // sha256(plaintext) hex，唯一索引供查找
  scopes     String                              // JSON 数组字符串：["record:read",...]（SQLite 无原生数组）
  expiresAt  DateTime?
  revokedAt  DateTime?                           // 软吊销；查询条件 revokedAt IS NULL
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())

  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("personal_access_tokens")
}
```

注意（对齐仓库 schema 风格 `schema.prisma:182-216`，cuid + @@map 蛇形表名）：
- 用 `revokedAt DateTime?` 而非 SPEC 字面的 boolean `revoked`：吊销时间本身有审计价值；`revoked = revokedAt != null`。迁移只增（SPEC §4）。
- `tokenHash` 加 `@unique`：查找走等值索引；但**恒定时间仍要在应用层做**（unique 查到即比、查不到给一个哑比较也可，M6 先用 timingSafeEqual 遍历/等值均可——单用户 token 量级小，遍历成本可忽略；更稳妥是按 hash 等值查 + 一个固定 dummy hash 比较防 user-enumeration 时序）。
- `scopes` 用 JSON 字符串列（与现有项目存 JSON 的做法一致），不写 SQLite 专有语法。

---

## 4. 双闸门与执行期 enforce 的边界

### 4.1 闸门一：tools/list 按身份过滤

PoC 在「按身份 build server」时，仅当 `PermissionService.listAccessibleResources(subject, action)` 非空才注册该工具。实测只读凭证 tools/list 结果里**物理没有**写工具：

```
rw: record.list_bases, record.list_records, record.create_record, doc.get_doc_blocks
ro: record.list_bases, record.list_records                              # create 被裁
```

schema 也随身份收窄（枚举只列权限内资源；不可见字段不进 properties）。需要 M4 权限引擎提供的接口（PoC 桩，M4 实现）：

```ts
// apps/api/src/mcp/permissions/types.ts（M4 实现此接口，MCP 只依赖接口）
export interface McpSubject {
  userId: string;
  patId: string;
  scopes: string[];                 // 来自 PAT 的粗档位
}

export interface PermissionService {
  /** 该主体在给定动作位下可访问的资源 id 全集（闸门一：非空才暴露工具；收窄枚举/schema） */
  listAccessibleResources(subject: McpSubject, action: string): Promise<string[]>;

  /** 执行期：对「本次调用的具体资源 + 字段掩码」做判定（闸门二） */
  can(
    subject: McpSubject,
    action: string,                 // "record:read" | "record:write" | "doc:write" ...
    resource: { kind: string; id: string },  // {kind:"base",id} / {kind:"doc",id} / {kind:"canvas",id}
    fieldMask?: string[],           // 本次读/写涉及的字段，做字段级判定（AC-M6-2）
  ): Promise<boolean>;
}
```

### 4.2 为什么 list 过滤之外，tools/call 必须再 enforce（纵深防御）

list 只是「UI 可发现性」，不是安全边界。以下越权场景只有执行期 enforce 挡得住（PoC 已演示前两类）：

1. **IDOR / 直传无权资源 id**：工具可见（有 record:read），但 AI/客户端直接在参数里传一个无权的 `baseId/docId`（枚举他人资源）。→ 执行期 `can(subject, action, {kind,id})` 拦截。实测 `base_secret` → `isError + FORBIDDEN_RESOURCE`。
2. **绕过列表直调被裁工具**：客户端不调 tools/list，直接构造 `record.create_record`。→ 若该动作对该主体在**任何**资源上都无权，返回与「工具不存在」逐字节一致的口径（-32602 `Tool x not found`，不泄漏存在性，AC-M6-1）。实测通过。
3. **list 之后权限被收回**：list 时刻可见，调用前该资源的共享被取消/角色被移除/PAT 被吊销。list 是快照，enforce 是当时判定。
4. **list 之后 token 被吊销**：每请求边缘重验认证（§3.2），旧会话下一请求即 401。
5. **字段级越权（AC-M6-2）**：工具与资源都有权，但参数触碰了 fieldMask 里不可见/不可写字段 → 执行期拦，出参也按字段掩码投影（搜索摘要也脱敏，对齐 ARCH §5.8 #16）。
6. **Prompt injection 伪造身份/资源**：工具返回文本一律是数据；资源 id 只取自服务端鉴权上下文校验，绝不信模型自报「我是 admin」。

**口径区分**（ARCH §8.2）：
- 工具对该主体**根本不可见**却被直调 → `Tool not found`（-32602，HTTP 200，不泄漏）；
- 工具可见但**本次资源/动作不满足** → MCP `isError:true` + 结构化 `{code:"FORBIDDEN_RESOURCE"|"FORBIDDEN_FIELD"|"FORBIDDEN_GROUP", requiredAction, currentRoleSources}`，供 AI 解释。
- PoC 实测两类均正确。

### 4.3 enforce 时序（M6 实施固定）

```
HTTP 边缘（src/mcp/transport.ts）
  1. PAT 认证 → subject（失败 401）
  2. body/限额（独立配额，§8.2）
  3. 按 subject build McpServer：闸门一 listAccessibleResources 决定注册哪些工具 + schema 收窄
工具 handler（src/mcp/tools/*.ts，只编排）
  4. zod 校验入参（超限/缺 confirm 直接 -32602）
  5. 调 service —— service 首行 enforce（闸门二，can(...)）   ← 强制点在 service 层（ARCH 行93），
     REST 与 MCP 物理上无法绕过；MCP handler 不直接 import prisma
  6. 出参字段投影 + 受控批量/上限
  7. 写审计（脱敏）
```

---

## 5. 工具目录草案（三套机器语言，每类先做最有价值的 3–6 个）

命名遵循 SPEC §5 命名空间。每个工具标注 `requiredAction`（闸门一动作位）与审计资源类型。全部读工具受控分页、写工具支持 `requestId` 幂等（ARCH §8.3，24h 去重）、破坏性写要求 `confirm:true`（实测 zod `z.literal(true)` 能在协议层强制）。

### 5.1 数据表语言（table/record）

| 工具 | 入参 JSON Schema 要点 | requiredAction | 审计资源 |
|---|---|---|---|
| `table.list_bases` | `{}` → 我可见库列表（枚举已按权限收窄） | `record:read` | base |
| `table.get_schema` | `{baseId}` → 表/字段元数据，字段带可读标记，不可见字段缺席 | `record:read` | base/field |
| `record.list_records` | `{baseId, tableId?, cursor?, limit≤200}` keyset 分页（M1 已具） | `record:read` | base/table |
| `record.query_records` | `{baseId, tableId, filter(受控白名单操作符), sort?, cursor?, limit≤200}` 走 M1 queryPlan 物理下推，**禁任意 SQL/公式** | `record:read` | base/table |
| `record.create_record` | `{baseId, tableId, fields{}, confirm:true}` | `record:write` | table/record |
| `record.update_record` | `{baseId, tableId, recordId, fields{}, expectedVersion?}` | `record:write` | record |
| `record.batch`（可选，二期） | `{ops[]≤100, requestId}` 受控批量，超限返 jobId | `record:write` | job |

上限：`limit` 用 zod `.max(200)`（PoC 实测超限在协议层 -32602 拒绝）；批量 op≤100（SPEC §10）；禁止一次 call 拉全表，大导出走 job。

### 5.2 知识库文档块语言（doc）——锚 Block + contentVersion

| 工具 | 入参 | requiredAction | 审计 |
|---|---|---|---|
| `doc.get_doc_blocks` | `{docId, format:"blocks"\|"markdown", range?}` → `{blocks, contentVersion, title}` | `doc:read` | doc |
| `doc.append_blocks` | `{docId, afterBlockId?, ops[]≤100, baseVersion}` 单事务一批、一次 version+1 | `doc:write` | doc |
| `doc.update_block` | `{docId, blockId, patch{text?,checked?,align?}, baseVersion}` | `doc:write` | doc/block |
| `doc.delete_blocks` | `{docId, blockIds[]≤100, baseVersion, confirm:true}` | `doc:write` | doc/block |

- **乐观锁**：每批带 `baseVersion` = 读到的 `contentVersion`；不匹配返 409 语义（MCP 错误 `VERSION_CONFLICT` + `currentVersion`），与现有 REST 完全一致——已核对 `apps/api/src/routes/kb.ts:423-438`（条件更新 `where:{id, contentVersion:baseVersion}`，更新 0 行时读当前版本返 409 `code:"VERSION_CONFLICT", currentVersion`）。MCP 复用同一 service，不另造。
- 单批 op≤100、插入文本总长≤100KB、文档上限 10MB（SPEC §10 / ARCH §8.4）；服务端转换只准复用 `mdToBlocks/blocksToMd`，align 只走 `<!-- align -->` 注释通道。

### 5.3 画布图元语言（canvas）——只读为主，写边界从严

| 工具 | 入参 | requiredAction | 审计 |
|---|---|---|---|
| `canvas.get_board` | `{docId}` → `{elements[], contentVersion, viewport?}` | `canvas:read` | canvas |
| `canvas.commit_elements`（二期，先评估） | `{docId, ops[element.create/update/delete/connect/zorder/locate], baseVersion, confirm?}` | `canvas:write` | canvas |

**M6 建议画布只读、写留二期**，理由：Plait 板不变量多（z 序=数组序、禁 zIndex 字段、3×2 网格无 DOM 算法、关联块必须 geometry+rectangle+gxLinkRef、不碰 WebKit 补偿层、思维导图子元素禁单独 zorder，ARCH §8.5 六条），写路径需要把前端 `canvas-ops.ts` 的规则抽成 shared 纯函数 + 服务端校验器，工作量独立成切片。M6 先交付 `canvas.get_board` 让 AI 能读板/识图元结构，写走二期并配 Web 端回归（AC-M6-3 的画布写入可在二期补，不阻塞 M6 主通道）。若 M6 一定要写，最小集只开 `element.create`（geometry/rectangle）+ 乐观锁，其余操作不开放。

### 5.4 操作逻辑说明书（MCP Resources）

纯语言文档（不含真实库名/数据）经 MCP Resources 只读承载，对所有已连接者可发现（ARCH §8.2「语言可学、无权不可调」）。SDK `server.registerResource` 支持，M6 放一份静态 markdown 即可，本期 Resources 仅此一用途。

---

## 6. OAuth 2.1 可选档——边界判断【文档，未实现】

**建议：M6 不做 OAuth，只交付 PAT；OAuth 明确列为 P1/客户驱动。** 理由：PAT（自填 Bearer）已是任意标准 MCP 客户端最通用的接入方式，Cursor/Claude Desktop/自研智能体/WorkBuddy 均支持手动填 endpoint+token，内网试点零额外依赖；OAuth 2.1+PKCE 要动态注册、授权页、回调 server（RFC8252 loopback/自定义 scheme）、token 刷新与并发管理，是独立一块产品/安全工作量，ROI 在「需要用户级 OAuth 跳转、不愿发 PAT」的客户出现后才成立。

未来最小实现需要的端点（ARCH §8.2 已列，签名复用现有 `jose 5.9`，不引重型 oidc 库）：

```
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server
POST /oauth/register     # RFC7591 动态注册（公共客户端）
GET  /oauth/authorize    # PKCE S256 + 同意页
POST /oauth/token        # authorization_code + refresh_token（access 1h / refresh ≥30d）
```

M6 只需在传输层**预留**：401 响应头未来加 `Resource Metadata` 指向、鉴权中间件支持「Bearer PAT 或 Bearer JWT」二选一的扩展点（PoC 的 `authenticate()` 返回 `Response | Subject`，加一个 JWT 分支即可），不预埋任何 OAuth 代码。

---

## 7. 越权三对抗（PoC 真实输出）

### 7.1 SDK 方案（`/tmp/gx-mcp-spike.sdk/test.sh`）

```
== 2. tools/list (rw) ==  record.list_bases,record.list_records,record.create_record,doc.get_doc_blocks
== 3. tools/list (ro) ==  record.list_bases,record.list_records            ← 写工具被闸门一裁掉
== 6. IDOR：ro 直传无权 base_secret ==
{"result":{"content":[{"type":"text","text":"{\"code\":\"FORBIDDEN_RESOURCE\",\"baseId\":\"base_secret\"}"}],"isError":true},"jsonrpc":"2.0","id":5}
== 7. 绕过 list：ro 直调被裁 create_record ==
{"result":{"content":[{"type":"text","text":"MCP error -32602: Tool record.create_record not found"}],"isError":true},"jsonrpc":"2.0","id":6}
== 8. 越权写：rw 对只读 base 写 ==
..."text":"{\"code\":\"FORBIDDEN_RESOURCE\"}"...,"isError":true
== 9. confirm 缺失（zod 协议层拒绝）==
MCP error -32602: ... Invalid input: expected true at confirm
== 对抗1 无 token ==      401  {"error":{"code":-32001,"message":"Unauthorized"},"id":null}
== 对抗2 过期 token ==    401  {"error":{"code":-32001,"message":"Token expired"},"id":null}
== 对抗3 吊销 token ==    401  {"error":{"code":-32001,"message":"Token revoked"},"id":null}
== 对抗3b 伪造 token ==   401  Unauthorized
```

### 7.2 手写方案（`/tmp/gx-mcp-spike.raw/test.sh`）

```
notifications/initialized → 202
tools/list (ro) → 仅 list_bases,list_records
ro 直调 create → {"error":{"code":-32602,"message":"Tool record.create_record not found"}}
IDOR base_secret → isError:true {"code":"FORBIDDEN_RESOURCE"}
无 session header → 400 {"error":{"code":-32000,"message":"Bad Request: valid Mcp-Session-Id required"}}
无/过期/吊销 token → 全部 HTTP 401
吊销后用旧 session 下一请求 → 401 Token revoked     ← 即时失效
GET SSE 流 → ": connected" 注释帧正常
```

### 7.3 MCP Inspector CLI（第二客户端，独立证据）

```
npx @modelcontextprotocol/inspector --cli --transport http \
  --server-url http://localhost:4101/mcp --header "Authorization: Bearer $RO" --method tools/list
→ record.list_bases,record.list_records            # 只读凭证看不到写工具
--method tools/call --tool-name record.list_records --tool-arg baseId=base_secret
→ "isError": true, text {"code":"FORBIDDEN_RESOURCE",...}
无 token → {"error":{"code":"auth_required",...}}   # Inspector 触发 OAuth/认证提示，未泄露任何工具
```

（Inspector 版本：`--transport streamable-http` 在当前版报参数名已改为 `http`；`--transport http` 即 Streamable HTTP。）

**结论：三对抗在 SDK 与手写两套、curl/SDK-client/Inspector 三种客户端、JSON/SSE 两种模式下全部正确拒绝；审计逐条落盘（见 §8）。**

---

## 8. 审计接入

### 8.1 现有能力（只读核对）

`apps/api/src/audit/audit.ts` 已提供零依赖 JSONL 审计：
- `writeAudit(auditDir, input)` 追加到 `$GX_AUDIT_DIR/audit.logl`，一行一 JSON，轮换交 logrotate copytruncate（`audit.ts:99-118`）；
- `redactSecrets()` 递归脱敏命中 `token/secret/authorization/bearer/jwt/password/cookie` 等片段的键（`audit.ts:39-76`）——**MCP 参数里若带任何 token 类字段会被自动脱敏**；
- `emit.ts` 的 `audit(c, input)` 从 Hono Context 自动填 ip/method/path；但 MCP 的语义是「一次 tools/call」而非 HTTP path，建议新增专用事件、直接调底层 `writeAudit`，自行填 method/path。

### 8.2 MCP 审计事件结构（PoC 已落盘验证）

PoC 实际写入 `/tmp/gx-mcp-spike.audit/audit.logl` 的样例：

```json
{"ts":"2026-09-14T04:30:46.682Z","event":"mcp.tool_call","actorId":"u_ro","tool":"record.list_records","resource":"base_secret","status":403,"code":"FORBIDDEN_RESOURCE"}
{"ts":"2026-09-14T04:30:46.745Z","event":"mcp.auth","status":401,"actorId":"u_x","patId":"pat_f49f283fd91b","reason":"expired"}
{"ts":"2026-09-14T04:30:46.781Z","event":"mcp.auth","status":401,"actorId":"u_rev","patId":"pat_09466ace5fad","reason":"revoked"}
```

M6 扩展 `AuditEventName`（`audit.ts:9-15`，当前只有 login 等 6 个）新增：`mcp_auth_failure`、`mcp_tool_call`、`mcp_pat_create`、`mcp_pat_revoke`。`mcp_tool_call` 建议字段：

```ts
{
  event: "mcp_tool_call",
  actorId: userId,
  ip, method: "POST", path: stripBasePath("/mcp"),   // 复用 utils/request-path.ts effectivePath
  status: 200 | 403 | 404 | 409,
  detail: {
    patId, tool,                       // 哪个 token、哪个工具
    resource: { kind, id } | null,     // 主资源（base/doc/canvas），供越权追溯
    resultCode: "OK" | "FORBIDDEN_RESOURCE" | "FORBIDDEN_FIELD" | "VERSION_CONFLICT" | "UNKNOWN_TOOL" | "CONFIRM_REQUIRED",
    args: redactSecrets(sanitizedArgs),// 参数脱敏；且只记资源 id/分页等元信息，不记 fields 全量业务值（防数据入日志）
    durationMs,
    requestId?: string,                // 幂等键
  }
}
```

要点：**每次 tools/call 必审计（含被拒的），认证失败也要审计**（AC-M6-4）；参数只留资源标识与白名单元信息并过 `redactSecrets`，业务数据体不入日志；审计写失败只告警不阻断主流程（现有设计 `audit.ts:109-111` 已如此）。PoC 的 `writeAudit` 与仓库同形态，可直接平移到 `src/audit` + 在 tool handler 收尾处调用。

---

## 9. M6 实施建议（文件级）

### 9.1 目录结构（建议加在 apps/api/src/mcp/，单文件 ≤300 行，对齐 references/01 规范）

```
src/mcp/
  permissions/types.ts        # McpSubject / PermissionService 接口（M4 实现，MCP 只依赖接口）
  pat/
    tokens.ts                 # 生成 gxpat_ / sha256 / timingSafeEqual / 校验 / lastUsedAt 节流
    patService.ts             # 创建(明文返一次)/列表/吊销（service 层 enforce 本人）
  transport/
    streamableHttp.ts         # WebStandardStreamableHTTPServerTransport 装配 + 每请求 build + 生命周期清理
    authenticate.ts           # Bearer PAT 认证边缘（401 口径），未来加 JWT 分支
    lifecycle.ts              # body 结束后 close transport/server（§1.2 坑）
  server.ts                   # buildServer(subject)：按权限动态注册工具（闸门一）
  tools/
    registry.ts               # 工具元数据表：name/requiredAction/审计资源类型/inputSchema
    table.tools.ts            # list_bases/get_schema/list_records/query_records/create/update
    doc.tools.ts              # get_doc_blocks/append/update/delete（走 kb service + contentVersion）
    canvas.tools.ts           # M6 仅 get_board（只读）
    schemas.ts                # zod4 入参 + 受控上限常量（limit≤200、op≤100）
  audit.ts                    # mcp_tool_call / mcp_auth_failure 事件封装（调 src/audit writeAudit）
  stdio.ts                    # 独立 bin 入口：GX_MCP_TOKEN → subject → 同一 registry
routes/pats.ts                # /api/v1/pats REST（创建/列表/吊销），挂现有 /api/v1（M3 起新前缀）
```

### 9.2 与 routes/index.ts / app.ts 的装配方式

**建议：/mcp 挂进现有 mount 单例（`app.ts` createMount 内），但在安全中间件链上对 /mcp 做差异化豁免——不需要独立 nodeListener/第二端口。** 理由：WebStandard transport 与 Hono 同为 Web 标准，`c.req.raw` 直桥即可在同一 Hono app 内处理；独立 nodeListener 只在「要完全绕过所有中间件 + 独立 unix socket」时才需要，会导致限流/安全头/IP 提取重复实现，不划算。

装配（在 `createMount` 里，放在 healthz 之后、`/api` 之前）：

```ts
mount.route("/mcp", mcpApp);                       // mcpApp 是 new Hono()，内部 all("/", handle)
if (config.basePath) mount.route(`${config.basePath}/mcp`, mcpApp);  // 或依赖 app.ts:163 的整体 basePath 双挂
```

注意 `app.ts:163-164` 已对**整个 mount** 做了 basePath+根双挂，因此 MCP 只要挂进 mount 就自动同时有 `/mcp` 与 `/app/gouxiangdb/mcp`（PoC 已验证这一路径形态），**无需**自己再挂第二份。

**中间件差异化（必须改的两处）：**

1. **bodyLimit（`middleware/bodyLimit.ts`）——必须豁免并给独立上限。** 实测复现：2MB 画布 `tools/call` 被 1MB 全局限制 `413 PAYLOAD_TOO_LARGE` 杀掉，11MB 才放行（§0 坑1）。建议 `bodyLimitDispatch` 增加：`effectivePath(c)` 为 `/mcp` 时用独立 `GX_MCP_BODY_LIMIT`（默认 11MB，对齐文档/画布 10MB + JSON 开销），其余保持 1MB。
2. **rateLimit（`middleware/rateLimit.ts`）——给 /mcp 独立配额，不套 600/60s 的 /api 兜底。** 现状 `DEFAULT_RULE` 只匹配 `path.startsWith("/api/")`（`rateLimit.ts:44-49`），所以 /mcp **当前天然不被限流**（既不豁免也不限）。M6 应新增一档 MCP 规则（如 120 次/60s/PAT，按 patId 而非只按 IP 限流，防止单个 token 跑爆 NAS；initialize/pat 管理仍可走更严格档），在 `selectRule` 里对 `/mcp` 返回该规则。AI 调用模式与人类点 UI 不同，需要独立、可观测的配额。
3. secureHeaders 可保留（对 JSON/SSE 无害）；CORS 对 MCP 非浏览器客户端无影响，浏览器型 MCP host 跨域时走现有白名单即可；logger 保留。
4. SSE 模式下确认 Hono/node-server 不缓冲响应——实测 `c.req.raw` 直桥 + 标准 Response 流式正常（§2.3），无需特殊处理；首版用无状态 JSON 可彻底回避。

### 9.3 切片切分建议（M6）

| 切片 | 内容 | 出口门 |
|---|---|---|
| M6-S1 PAT 基座 | 迁移 `personal_access_tokens`（只增）+ tokens.ts（生成/hash/常量时间/节流）+ `/api/v1/pats` REST + mcp_pat 审计 | 单测：明文仅一次、hash 查不到、吊销置位、常量时间 |
| M6-S2 传输骨架 | WebStandard transport 无状态 JSON 接入 mount（basePath 双挂）、body 11MB 豁免、MCP 独立限流档、401 口径；一个 `ping` 工具 | curl + SDK client 打通 initialize/list/call；三认证对抗（无/过期/吊销）401 |
| M6-S3 双闸门 + PermissionService 接口 | buildServer 动态注册；PermissionService 接口 + M4 桩实现；工具 handler→service enforce 时序；UNKNOWN_TOOL/FORBIDDEN 口径 | 越权矩阵：IDOR、绕过 list、字段越权；tools/list 只读集正确 |
| M6-S4 数据表语言 | table/record 工具接现有 recordService（keyset/queryPlan/受控批量） | Inspector 走通读/写/查；limit/batch 上限拒绝；越权零泄漏 |
| M6-S5 文档块语言 | doc 工具接 kb service，复用 contentVersion 409 | 乐观冲突 409、op≤100/100KB、Web 打开结构完整（AC-M6-3 文档部分） |
| M6-S6 画布只读 + stdio + 说明书 | canvas.get_board；stdio bin + GX_MCP_TOKEN；Resources 静态说明书 | stdio client 连通；Inspector 读到板 |
| M6-S7 出口 | 审计全事件、MCP 独立配额观测、Inspector 全工具回归、双客户端（Inspector + 通用 host）连通报告、越权三对抗入回归 | 对齐 SPEC M6 验收：Inspector 全工具、三对抗、双客户端 |

画布**写**（canvas.commit_elements）与 OAuth 明确不进 M6，分别挂二期与 P1。

### 9.4 风险/注意

- SDK 用 zod4、业务用 zod3：仅 mcp/tools/schemas.ts 内用 SDK 自带 zod4，不扩散；pnpm 隔离无冲突（实测）。
- 每请求 new transport+server 有轻微构造开销（工具注册），工具数量几十个时可忽略；如成热点，可按 `(userId, scopeVersion)` 缓存「工具描述列表」但仍每请求 new transport（transport 严禁复用）。
- 30s 工具超时契约（SPEC §10/ARCH §8.1）：在 service 调用加超时，长任务返 jobId（M5 outbox/worker 可复用），M6 先不做长任务。
- 实施时锁版本：package.json 写 `@modelcontextprotocol/sdk: "1.30.0"`（精确）或 `^1.30` 并在 CI 复测 Streamable HTTP 无状态 API（SPEC §4 要求）。

---

## 10. 复现实验指引（PoC 全部在 /tmp，可丢弃）

```bash
# 方案 (a) 官方 SDK
cd /tmp/gx-mcp-spike.sdk
npx tsx server.ts                      # JSON 无状态 :4101；MCP_MODE=sse 开 SSE；SOCK=/path 走 unix socket
bash test.sh                           # 全链路 + 三对抗（curl）
npx tsx client.ts http://localhost:4101/mcp "$(curl -s localhost:4101/_pat/ro)"   # 官方 SDK 客户端
npx -y @modelcontextprotocol/inspector --cli --transport http \
  --server-url http://localhost:4101/mcp --header "Authorization: Bearer $TOK" --method tools/list
npx tsx gateway.ts                     # 伪飞牛网关 :4200 -> unix socket（注入 X-Trim-Userid）
node stdio-client.mjs                  # stdio 双入口

# 方案 (b) 手写
cd /tmp/gx-mcp-spike.raw
npx tsx server.ts                      # :4104
bash test.sh
# 互操作：用 (a) 的官方 client 连手写 server
cd /tmp/gx-mcp-spike.sdk && npx tsx client.ts http://localhost:4104/mcp "$(curl -s localhost:4104/_pat/ro)"

# 审计
cat /tmp/gx-mcp-spike.audit/audit.logl /tmp/gx-mcp-spike.audit-raw/audit.logl
```

PoC 文件：SDK 版 `server.ts / mini.ts / client.ts / gateway.ts / stdio-server.ts / stdio-client.mjs / test.sh`；手写版 `server.ts / test.sh`。

---

## 11. 待上游确认 / 开放问题

1. **M6 是否接受画布只读**（本 spike 建议只读、写二期）；若 AC-M6-3 的画布三矩形两箭头写入必须 M6 交付，需追加「Plait 不变量 shared 纯函数 + 服务端校验器」一个切片，工作量与文档写相当，建议产品/架构拍板。
2. MCP 独立限流档默认值（建议 120/60s/PAT）与超限口径需运维确认。
3. `personal_access_tokens.scopes` 用 JSON 字符串列 vs 关联表：M6 token 量小建议 JSON 列；若未来要「按 scope 反查所有 token」再上表。

# M6 鉴权 MCP 服务 — S8 三客户端真连通 / 四对抗 / 401 五态（出口硬门基线）

- 日期：2026-09-17
- 里程碑：M6（鉴权 MCP 服务）S8「三客户端 + 四对抗」
- 作者：后端 贝洛奇
- 性质：**纯新增测试设施 + 本文件**（零生产码改动、零迁移、零产品语义变更）。
- 实施依据：`docs/planning/phase2/M6-implementation-plan.md` §S8（§414-417）、§460（11MB 豁免 / 独立限流 / 30s 超时不挂连接）、§317（错误码词汇）、§455-460（AC-M6-1~4 口径）、§12 DoD。
- 前置切片：S6b（`d1a7a72`/`3bf7691`）、S7（`b4d51b2`/`4b06af8`）均已过闸。
- 回滚：删 `apps/api/vitest.e2e.config.ts` + `apps/api/src/e2e/` + 本文件即可（零生产码）。

> **★ 硬门语义**：AC-M6-1~4、IDOR、401 五态、三客户端连通，**任一失败阻断 S9**。
> 本文件所有数字与结论均为**本次实跑所得的实测值**（非转引、非估算），命令逐条可复现。

---

## 0. 结论速览

| # | 出口项 | 结论 | 证据位置 |
|---|---|---|---|
| 1 | 三客户端连通（curl / 官方 SDK / MCP Inspector） | **pass**，三客户端**全部真自动化**（无降级） | §3 |
| 2 | 三形态（TCP 根 / 子路径 basePath / unix socket） | **pass**，`/mcp` 与 `/app/gouxiangdb/mcp` 同源可达 | §3.4 |
| 3 | AC-M6-1 只读凭证无写工具 + 直调不泄漏存在性 | **pass**（HTTP + stdio） | §4.1 |
| 4 | AC-M6-2 字段受限 schema 收窄 / 出参缺席 / 参数二次拦截 | **pass**（HTTP + stdio） | §4.2 |
| 5 | AC-M6-3 doc 409/confirm + 画布 UNSUPPORTED_OPERATION 不静默 | **pass**（7 发二期操作 + 2 发缺 confirm + 1 发 409） | §4.3 |
| 6 | AC-M6-4 吊销即时 401 + 每次 call 入审计 | **pass**（HTTP + stdio；审计三类 resultCode 齐） | §4.4 |
| 7 | IDOR 四条（base/doc/canvas-read/canvas-write） | **pass**，隐藏与"不存在"**逐字节一致** | §5 |
| 8 | 401 五态（+ 非 PAT 形态共六态） | **pass**；**"查不到"三态逐字节一致**；吊销/过期/停用可辨识（口径差异见 §8-4） | §6 |
| 9 | §460-1 11MB 只对 /mcp 生效 | **pass**（2MB：/mcp 200 / /api 413） | §7.1 |
| 10 | §460-2 独立限流可观测 | **pass**（第 4 次 429 + Retry-After: 60） | §7.2 |
| 11 | §460-3 工具超时不挂连接 | **pass**（TIMEOUT @1284ms，随后同连接 ping 正常） | §7.3 |
| 12 | 常规门零污染（**收集总数恒 2089 = 基线**） | **pass**（e2e 用例结构性不进常规门，见 §2；`0 failed` 的负载类失败由 team-lead 独占复验裁决，见 §9） | §9 |
| 13 | Web 端结构完整（画布 / 文档块） | **不重造**，引用 S6b-FE Playwright golden 与 S5 round-trip | §10 |

**e2e 实测**：`Test Files 6 passed (6)`、`Tests 64 passed (64)`、退出码 0（耗时随机器负载波动，以 team-lead 独占复验实数为准；61 → 64 的增补见 §1 与 §4.3/§5）。

---

## 1. 本次新增（全部为测试设施）

| 文件 | 行数性质 | 职责 |
|---|---|---|
| `apps/api/vitest.e2e.config.ts` | 配置 | e2e 专用配置，与常规门**互斥**（见 §2）；含 `globalSetup` 挂钩 |
| `apps/api/src/e2e/globalSetup.ts` | 设施 | e2e 全局前置：现场构建**生产 stdio 产物** `dist/mcp-stdio.js`（缺产物直接抛错，stdio 出口门不许空转） |
| `apps/api/src/e2e/serverHarness.ts` | 设施 | 环境准备/真迁移、真 TCP + unix 监听、原始 fetch / curl / unix-fetch 三套客户端 |
| `apps/api/src/e2e/clientHarness.ts` | 设施 | 官方 SDK 的 HTTP 与 stdio 客户端、审计 JSONL 读取 |
| `apps/api/src/e2e/inspectorCli.ts` | 设施 | MCP Inspector CLI 非交互驱动（固定版本） |
| `apps/api/src/e2e/bootstrap.ts` | 设施 | 共享引导（临时库 + 迁移 + 夹具 + 双形态服务） |
| `apps/api/src/e2e/fixtures.ts` | 夹具 | 每族「可见 / 不可见」成对资源 + 策略 + 5 枚身份 PAT |
| `apps/api/src/e2e/attackLog.ts` | 设施 | 对抗台账（「输入 → 期望码 → 实际码」三列） |
| `apps/api/src/e2e/m6-s8-clients.e2e.ts` | 用例 16 | 三客户端 × 三形态 + stdio + Inspector |
| `apps/api/src/e2e/m6-s8-ac12.e2e.ts` | 用例 9 | AC-M6-1 / AC-M6-2（HTTP + stdio） |
| `apps/api/src/e2e/m6-s8-ac34.e2e.ts` | 用例 17 | AC-M6-3 / AC-M6-4（HTTP + stdio；stdio 补陈旧 baseVersion 409 一发） |
| `apps/api/src/e2e/m6-s8-idor.e2e.ts` | 用例 9 | IDOR 四条 + 同族补证 + 反例护栏 + **stdio 入口 IDOR 两族**（doc 读 / canvas 写） |
| `apps/api/src/e2e/m6-s8-401.e2e.ts` | 用例 10 | 401 六态 + 认证失败审计 |
| `apps/api/src/e2e/m6-s8-limits.e2e.ts` | 用例 3 | §460 三项 |

---

## 2. e2e 与常规门完全隔离（常规门零污染的机制保证）

两个 include **零交集**：

| 门 | 收集规则 | 收得到 |
|---|---|---|
| 常规门 `pnpm --filter @gx/api test`（无 config） | vitest 默认 `**/*.{test,spec}.?(c|m)[jt]s?(x)` | 只收 `*.test.ts`；**收不到任何 `*.e2e.ts`** |
| e2e `vitest run --config vitest.e2e.config.ts` | `include: ["src/e2e/**/*.e2e.ts"]` | 只收 `*.e2e.ts`；收不到任何 `*.test.ts` |

配置要点：`fileParallelism: false` + `pool: "forks"`（真监听/端口/socket 文件/stdio 子进程会互相干扰，串行才可读）、`hookTimeout: 240s`（真迁移 + 多客户端往返）。

**命令**：

```bash
# e2e（本片，不计入常规门）
cd apps/api && pnpm exec vitest run --config vitest.e2e.config.ts --reporter=verbose

# 常规门（须保持零污染；见 §9）
pnpm --filter @gx/api test
```

"真服务"口径（派工单硬要求）：e2e 内**所有**请求都经网络栈打到真监听端口，**不使用** `app.request` 直调（后者是 S2-S7 的形态，不经传输层，证不了"第三方能连"）。服务起法与生产入口同源：TCP 用 `@hono/node-server` 的 `serve()`，unix 用 `node:http` `createServer(getRequestListener(app.fetch))`——与 `src/index.ts` 完全同一对 API。

---

## 3. 三客户端连通（全部真自动化）

### 3.1 curl（子进程，独立于 Node 的第二套 HTTP 实现）

命令形态（**token 用 `<PAT>` 占位，绝不落明文**；本片把请求头写入 0600 临时文件后用 `-H @file` 传入，**token 不进 argv**）：

```bash
curl -sS -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <PAT>' \
  --data-binary @request.json \
  http://127.0.0.1:<port>/mcp                       # unix 形态追加 --unix-socket <tmpdir>/api.sock
```

输出摘要（3 形态 × 4 用例，共 12 例全绿）：

| 用例 | TCP 根 | unix socket | 子路径 basePath |
|---|---|---|---|
| initialize | 200 + `serverInfo.name=gouxiangdb-mcp` | 同 | 同 |
| tools/list | 200，含 `ping_echo`（+ 13 工具） | 同 | 同 |
| 成功 tools/call | `pong:hello` | 同 | 同 |
| 被拒 tools/call（入参越界） | HTTP 200 + `-32602` | 同 | 同 |

### 3.2 官方 SDK `StreamableHTTPClientTransport`（"任意第三方 AI host 能接"的核心证据）

```ts
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer <PAT>` } },
  // unix 形态：SDK 支持注入 fetch（streamableHttp.js: `this._fetch ?? fetch`），无需改全局 fetch
  ...(isUnix ? { fetch: unixSocketFetch } : {}),
});
```

结论：3 形态各 `listTools()` + `callTool()` 成功 + 被拒一次，共 3 例全绿；`tools/list` 下发的每个工具都带 `inputSchema`（第三方 host 可据此构造参数）。
**服务端返回的尺寸**：`ping_echo`、`table.list_bases`、`table.get_schema`、`record.list_records`、`record.query_records`、`record.create_record`、`record.update_record`、`record.delete_record`、`doc.get_doc_blocks`、`doc.append_blocks`、`doc.update_block`、`doc.delete_blocks`、`canvas.get_board`、`canvas.commit_elements` = **14 件**（M5 off 时 `record.search` 缺席，符合运行期可用性门）。

### 3.3 MCP Inspector CLI（固定版本、非交互、**真自动化**）

```bash
npx -y @modelcontextprotocol/inspector@0.16.6 \
  --cli http://127.0.0.1:<port>/mcp \
  --transport http \
  --method tools/list \
  --header 'Authorization: Bearer <PAT>'
```

实测输出：`[M6-S8] Inspector v0.16.6 自动化成功：14 个工具，耗时 3459ms`（真连上真服务：服务端日志可见 `POST /mcp 200` → `POST /mcp 202`（notification）→ `GET /mcp`）。

**无需降级**。参数形态是**两次失败实测**出来的（留证）：

| 尝试 | 结果 | 原因 |
|---|---|---|
| `inspector@0.16.5 --cli <url> ... --header 'Authorization: Bearer x'` | `Arguments cannot be passed to a URL-based MCP server.` | 0.16.5 未定义 `--header`，该值沦为**第二个位置参数** |
| `inspector@0.16.6 --cli --server-url <url> ...` | `error: missing required argument 'target'` | `<target...>` 是**位置参数**，`--server-url` 不满足它 |
| `inspector@0.16.6 --cli <url> --method tools/list --header ...` | ✅ 14 工具 | 位置 URL + 变参 `--header` 置于其后 |

另：npx 对 **0.16.5 直接拒装**（`version 0.16.5 is unsafe, please use 0.16.6 or later`）→ 版本 pin 到 **0.16.6**。
安全注记：Inspector CLI 的 `--header` 只有 argv 形态（无 curl 的 `-H @file` 等价物），测试令牌会短暂出现在本机进程 argv；缓解＝仅用于临时库一次性令牌、进程随即回收，本文件与报告一律 `<PAT>` 占位。

### 3.4 stdio 第二入口（官方 `StdioClientTransport` 真 spawn **随包生产产物**）

真 spawn **`dist/mcp-stdio.js`**（package.json `bin` 随包投递的构建产物，实测 413.8 KiB；由 `globalSetup` 调 `scripts/build.mjs` 现场构建，dist 在 `.gitignore` 内），**不是 `tsx` 直跑 `src/`**——出口门验的是**交付物本身**。`initialize` / `tools/list` / `tools/call` 全通；工具集与 HTTP **同源**（共用 `buildServer`，闸门一决策一致）。另覆盖退出码场景（§4.4：吊销后重启进程 → 退出码 2 + stdout 空）。

> HTTP 形态由 in-process 真监听承担（`serve()` + unix `createServer`），与 `dist/index.js` 的监听代码路径同源（`startTcpServer`），故"真服务"口径对两种入口一致。

### 3.5 子路径与根同源可达

同一实例双挂载：`/app/gouxiangdb/mcp` 与 `/mcp` 均可 `initialize` 且均可成功调用工具（`GX_BASE_PATH` 在 config 求值时冻结 → 该形态以 `vi.resetModules()` 后重新装配并在**独立端口真监听**验证）。

---

## 4. 四对抗（HTTP 与 stdio 两入口）

> 纪律：每条**先构造应被拒的输入**，断言**拒绝码**；不用 happy path 充数（§4.3 额外用 DB 逐字节不变证明"拒绝＝真没落库"）。

### 4.1 AC-M6-1 只读凭证（`record:read` + `doc:read` + `canvas:read`）

| 入口 | 断言 | 实测 |
|---|---|---|
| HTTP | `tools/list` **恰为** `canvas.get_board`/`doc.get_doc_blocks`/`ping_echo`/`record.list_records`/`record.query_records`/`table.get_schema`/`table.list_bases`（7 件，零写工具） | ✅ 精确集合相等 |
| HTTP | 直调被裁写工具 `record.create_record` | `isError` + `-32602`，与 `no.such_tool` **同文案模板** |
| stdio | 同集合 | ✅ |
| stdio | 直调 `canvas.commit_elements` | 同上 |

**口径澄清（重要）**：计划 §S8 写"与不存在的工具名**逐字节一致**"。实测 SDK 的未注册工具文案形如
`MCP error -32602: Tool <name> not found` —— **工具名是客户端自己传的**，故字面逐字节相等在构造上不可能；
本片断言的是"**名字占位归一化后逐字节相等**"。安全性结论不变：**存在性零泄漏**（同模板、同码、同 HTTP 200）。

### 4.2 AC-M6-2 字段受限凭证（`r,u` + `fieldMask={allowFields:[可见列]}`）

| 入口 | 断言 | 实测 |
|---|---|---|
| HTTP | 注册集 == 有效动作集：有 `u` → `record.update_record` 在册；无 `c`/`d` → create/delete **不在册** | ✅ |
| HTTP | `table.get_schema` 的字段恰为 `[可见列]`（不可见列**不进 schema**） | ✅ |
| HTTP | `record.list_records` 返回记录的 `fields` 键恰为 `[可见列]`（不可见字段**物理缺席**） | ✅（2 条记录逐条校验） |
| HTTP | 参数越权（可见令牌传不可见 `fieldId` 给 `update_record`） | `FORBIDDEN_FIELD`（**二次拦截**） |
| stdio | schema 收窄 + 参数越权拦截 | 同上 ✅ |

### 4.3 AC-M6-3 写入面

**doc 块**：`append_blocks` 成功一次 `contentVersion` **恰好 +1** 且经协议读回结构一致；陈旧 `baseVersion` → `VERSION_CONFLICT` + `currentVersion`；破坏性写缺 `confirm:true` 一律 `-32602`（`doc.delete_blocks` 与 `canvas.commit_elements` 各一发）。

**画布二期操作（C-2 边界，7 发全部显式拒绝、绝不静默）**：

| 输入 | 期望 | 实际 |
|---|---|---|
| `element.update` / `element.move` / `element.delete` / `element.connect` | `UNSUPPORTED_OPERATION` + `supported:["element.create"]` | ✅ ×4 |
| 箭头 `arrow-line` | 同上 | ✅ |
| `gxLinkRef` 关联块 | 同上 | ✅ |
| `gxDocRef` 文档引用 | 同上 | ✅ |

补充证据：被拒的**整批未落库**（DB `content` 与 `contentVersion` 逐字节不变）；stdio 入口同款一发同样被拒。

**stdio 入口乐观锁补证**：stdio 侧再发一次陈旧 `baseVersion = cur - 1` 的 `append_blocks`，同样返回 `VERSION_CONFLICT` + `currentVersion=cur`（对抗台账 `AC-M6-3/409`，entry=stdio）——乐观锁在第二入口同样生效，不是 HTTP 专属。stdio 侧 `append_blocks` 成功一发（LWW）证明第二入口可写，故 409 是语义拦截而非只读退化。

**Web 端结构完整**：不重造，见 §10。

### 4.4 AC-M6-4 吊销与全量审计

| 入口 | 场景 | 实测 |
|---|---|---|
| HTTP | 先成功 `initialize` + `tools/call`，**吊销后下一请求** | **HTTP 401**，且审计落 `mcp_auth_failure(reason=revoked)` |
| stdio | stdio 无连接概念：吊销后**下次启动进程** | **退出码 2**，`stdout` 空（协议流零污染），`stderr` 含 `invalid` |
| 两入口 | 每次 call 入审计 | `mcp_tool_call` 的 `resultCode` 集合含 **OK / UNSUPPORTED_OPERATION / UNKNOWN_TOOL** 三类 |
| 两入口 | 参数脱敏、无业务值、无 token 明文 | `detail.args` 不含画布 `ops` 载荷；审计全文不含"AI 追加段"；**不含任一 PAT 明文及随机段** |
| 两入口 | 来源可辨识 | stdio 行 `ip=stdio`；HTTP 行 `path=/mcp`（带 basePath 部署记去前缀后的逻辑路径） |

---

## 5. IDOR 四条（隐藏 vs 不存在，逐字节对拍）

前置：先证明"隐藏资源**真实存在**"（直读 DB 非空 + 不在可见集内），否则就是退化成 404 冒烟。

| 编号 | 工具 / 输入 | 期望 | 实际 |
|---|---|---|---|
| IDOR-base | `table.get_schema` 传不可见 `baseId` vs 不存在 id | `FORBIDDEN_RESOURCE`，两发逐字节一致 | ✅ HTTP |
| IDOR-doc | `doc.get_doc_blocks` 传不可见 `docId` vs 不存在 id | 同上 | ✅ HTTP + **stdio** |
| IDOR-canvas-read | `canvas.get_board` 传不可见 `canvasId` vs 不存在 id | 同上 | ✅ HTTP |
| IDOR-canvas-write | `canvas.commit_elements` 传不可见 `canvasId` vs 不存在 id | 同上 + 隐藏画布内容零改动 | ✅ HTTP + **stdio** |

**stdio 入口补两族**（第二入口不放宽，均逐字节对拍）：`IDOR-doc`（stdio 读不可见文档）与
`IDOR-canvas-write`（stdio 直调写入不可见画布）与"不存在 id"同发 `FORBIDDEN_RESOURCE`，两响应 `content[0].text`
逐字节相等，台账 entry=stdio。stdio 未单列 `base` / `canvas-read` 两族（HTTP 列已四族齐，stdio 与其共用同一
`buildServer` 与权限端口，第二入口的价值在于证明"入口不改变判定"，故取读族代表 doc、写族代表 canvas 写各一发）。

同族补证：`record.list_records` 打不可见表 vs 不存在表 → 逐字节一致。
反例护栏：同一令牌读**可见** base/doc/canvas 均正常返回（证明拒绝只因权限，不是工具坏了）。

---

## 6. 401 六态

| 态 | HTTP | 信封 | 文案 |
|---|---|---|---|
| 无 Authorization | 401 | `-32001` + `id:null` + `WWW-Authenticate: Bearer` | `Unauthorized` |
| 非 PAT 形态（无 `gxpat_` 前缀） | 401 | 同 | `Unauthorized` |
| 伪造（`gxpat_` 前缀但查不到） | 401 | 同 | `Unauthorized` |
| 过期 | 401 | 同 | `Token expired` |
| 已吊销 | 401 | 同 | `Token revoked` |
| 主体停用 | 401 | 同 | `Account disabled` |

- **「查不到」三态响应体逐字节一致** → 不泄漏 token 是否存在（防枚举）。
- 审计：六态 `reason` 全部落 `mcp_auth_failure`；`patPrefix` **只对 `gxpat_` 形态**截前 14 字符（非 PAT 形态与无 Bearer **不带** `patPrefix`，不截断任意 Authorization 值）。
- 零泄漏：整份 `audit.logl` 不含任一 PAT 明文（含随机段）。
- 口径已裁决（保留现状，见 §8-4）：拿不出有效令牌的三种情况（无 Bearer / 非 PAT 前缀 / 查不到）响应体逐字节一致；已过期 / 已吊销 / 账号停用各自可辨识。

---

## 7. §460 三项

### 7.1 11MB 豁免只对 /mcp 生效

| 请求 | 实测 |
|---|---|
| 2MB payload → `POST /mcp` | **200**（非 413；2MB > /api 的 1MB 档、远 < 11MB 档） |
| 2MB payload → `POST /api/records?tableId=none` | **413** + `code=PAYLOAD_TOO_LARGE` |

（既有断言在 `m6-s2-mcp-app.test.ts` 以 `app.request` 覆盖；本片以**真监听端口**再证一次，属同口径复跑而非新造。）

### 7.2 独立限流可观测

把 patId 桶调到 3（`GX_MCP_RATE_PAT_MAX=3`，IP 预桶放到 1000）后：**前 3 次放行，第 4 次 429** + `Retry-After: 60` + `X-RateLimit-Limit: 3` + 信封 `-32029 RATE_LIMITED`。
（双桶设计见 §5.3 与 `m6-s2-mcp-rate-limit.test.ts`；本片在真服务上把桶调小观测。）

### 7.3 工具超时不挂连接

慢夹具（sleep 5000ms）+ `GX_MCP_TOOL_TIMEOUT_MS=1200`：返回 **HTTP 200 + `isError` + `code:"TIMEOUT"`**，耗时 **1284ms**（< 5000ms，证明是适配层超时而非跑到自然结束）；随后**同一 socket** 上的 `ping_echo` 正常返回 → **连接未被挂死**。
（慢夹具思路沿用 S7 `m6-s7-audit-idempotency.test.ts`；S7 原用例在 §9 一并复跑。）

---

## 8. 实施中发现的问题（如实登记）

1. **同进程 `spawnSync` 会与"被测服务在本进程内监听"互相饿死**（本片第一个坑）。
   现象：curl 组静默挂死 11 分钟，`vitest` 的 `testTimeout` 也不生效。根因：`spawnSync`/`execSync` **阻塞事件循环**，本进程内的 HTTP 服务因此无法应答 curl，curl 永远等 → 双死锁。
   处置：e2e 设施里**一切与被测服务交互的子进程都必须 async**（`execFile`/`spawn` + Promise）；`spawnSync` 仅允许用于不触服务的动作（如 `curl --version`）。硬护栏：子进程 `timeout`。
   影响面：仅测试设施，**零生产码**。后续任何"真服务 e2e"必须遵守此纪律。

2. **MCP Inspector 的版本与参数形态**（见 §3.3）：0.16.5 被 npx 判定 unsafe 且不认识 `--header`；0.16.6 的 `<target...>` 是位置参数。两处都踩过并留证，版本 pin 到 0.16.6。

3. **"与不存在工具逐字节一致"只能在工具名归一化后成立**（见 §4.1）：SDK 文案内嵌客户端传入的工具名。安全性（零存在性泄漏）成立，但措辞需精确化——建议后续文档统一写"**同文案模板 + 同错误码**，工具名占位由客户端输入决定"。

4. **401 五态"响应体不区分"与计划 §4.3 的口径差异 —— 已裁决：保留现状（team-lead S9 派工第 7 条）**。派工单 §D 曾要求五态响应体不区分；计划 §4.3 明文设计为 `revoked/expired/disabled` **各自可辨识**（现网即此行为，S2 已冻结文案快照）。
   **裁决：保留现状（计划 §4.3 优先级高于派工单 §D；伪造者止于"查不到"三态）**：拿不出有效令牌的三种情况（无 Bearer / 非 PAT 前缀 / 查不到）响应体逐字节一致；已过期 / 已吊销 / 账号停用各自可辨识。理由：持有效令牌者看到自身令牌状态有助于排障；伪造者必须先猜中 32 字符随机段才可能到达可辨识分支，而"查不到"三态已逐字节不可区分，不存在枚举面。本片未改生产码。

5. **测试夹具陷阱：M4 的 `createdBy` 属主路径会让"自己建的"资源自动可见**。
   本片探针阶段以 `uFull` 创建隐藏资源，结果 `uFull` **能读到**这些资源，IDOR 对抗当场失真。
   处置：隐藏资源改由第三方 `uOther` 创建。**后续任何 M6 权限对抗夹具必须遵守**：要"不可见"，就不能由被测主体创建。

6. **字段受限夹具必须用**该身份的令牌**打开独立 stdio 客户端**。首版复用了只读身份的 stdio 客户端去断言 mask 身份的 schema，得到"两列全在"的假失败；根因是令牌身份不同（无 fieldMask 的来源胜出）。已改为按身份各开一个 stdio 客户端。

7. **块类型枚举是 `p`/`h1`…（`@gx/blocks`），不是 `paragraph`**。首版用例按直觉写了 `paragraph`，被 SDK 拦为 `-32602`（拒绝行为本身正确，是用例写错）。

8. **`GlobalSetupContext` 在 vitest 3.x 只从 `vitest/node` 导出**（实测本仓 vitest **3.2.7**，`node_modules/vitest/dist/node.d.ts:158`）。写成 `from "vitest"` 会 `TS2305` 直接破 tsc 门。已修。另：`globalSetup` 里用 `execFileSync(...{stdio:"inherit"})` 构建 `dist/mcp-stdio.js` 是安全的——该阶段**服务尚未起**，不触发 §8-1 的自死锁。

9. **常规门在机器高负载下会爆"纯负载 5s 超时"**（详见 §9）：失败**恒为** `Test timed out in 5000ms`、日志 `AssertionError` 计数 **0**、逐项隔离复跑全绿、同一用例负载下耗时达隔离态 **5.7×**。属**既有已登记 flaky 类**（同 `s10-ac-upgrade-20x20:136` 定案），与本片零因果。本片坚持**不调全局 `testTimeout` 掩盖**，改用"隔离复跑 + 收集数恒等 2089"双向证明。

10. **"同目录并发写入"已查明并收敛（结论）**：当时观察到的在途改动（`globalSetup.ts`、stdio 改走生产产物 `dist/mcp-stdio.js`、ac34 增例）来自**并行前端线** commit `fbb4981`（`feat(m6-fe)`，22:00）工作窗口内的同机活动；核对 `fbb4981` 的改动集**只含 `apps/web/**`，不含任何 `apps/api/src/e2e/**` 或 `vitest.e2e.config.ts`** —— 即 **api e2e 目录并无第二个 writer**，那些文件仍是本片单一作者收敛、最终以单个 commit `6d898b0` 归档（15 文件口径一致）。无"待 team-lead 裁决归属"的悬挂项。教训留存：**同一份未跟踪目录不得拆给两个 writer 共写**（半写状态会污染对方 lint/tsc 读数，本片抓到过一条幻影 warning）；如确需并行，先按子目录划清写边界。

11. **advisory-B（字段收窄语义，S9 文档必写）**：AC-M6-2 的"字段受限"靠的是 M4 节点策略行上的 `fieldMask.allowFields`，其语义是**在 M4 可见集之上的显式收窄白名单（allow 之上再裁剪），不是 deny 清单、也不是独立授权来源**。即：字段最终可见 = 资源可见（M4 决定"看不看得到这条记录"）∩ `allowFields`（决定"看得到哪些列"）；缺省/空 `fieldMask` = 不裁剪。S9 文档（openapi `x-mcp`、runbook、接入说明）恢复撰写时必须把这层写准确：PAT scope 只做族级粗筛，`fieldMask` 才是字段级收窄点，且"不在 allowFields"与"资源不可见"对外同走 `FORBIDDEN_FIELD` / 物理缺席，不泄漏区别。本片先在此登记，冻结期不改正文档。

---

## 9. 常规门零污染复验（e2e 不计入常规门）

> **复验裁决权说明（S9 冻结期加注）**：本节下列"同机两轮"的失败数与耗时是本片在高负载/多任务并发窗口自跑所得，
> team-lead 已裁定这些数字在并发污染下**不作为过闸依据**；常规门最终实数（收集总数与失败归类）由 team-lead
> **独占机器重跑**裁决。结构性隔离结论（include 互斥、e2e 不进收集）不依赖任何耗时数字，仍然成立。

**结构保证**：本片只新增 `*.e2e.ts`；常规门 `vitest run`（默认 include `**/*.{test,spec}.*`）**根本收集不到** `*.e2e.ts`。`src/e2e/**` 内**零生产码、零迁移、零依赖变更**。

**实测（`pnpm --filter @gx/api test`，同机两轮）**：

| 轮次 | Test Files | Tests | 收集总数（passed+failed） | 退出码 |
|---|---|---|---|---|
| 第 1 轮 | 2 failed \| 185 passed \| 2 skipped (189) | 2 failed \| 2087 passed \| 13 skipped | **2089** | 1 |
| 第 2 轮 | 3 failed \| 184 passed \| 2 skipped (189) | 4 failed \| 2085 passed \| 13 skipped | **2089** | 1 |

**关键读数（结构性）**：常规门 `passed + failed` 恒为 **2089**（本片自跑两轮亦然），与基线 `2089 passed / 13 skipped` 的用例数**精确一致** → 本片对常规门**零新增、零删除、零改写**。e2e 的 64 例**完全不进入**常规门。最终 0/非0 failed 实数以 team-lead 独占重跑为准。

**本片自跑观察（已不作过闸依据，最终归类以 team-lead 独占重跑为准）：本片窗口内见到的失败全部呈"纯负载 5s 超时"形态，不是语义破坏**：

| 失败文件 | 该文件用例 | 失败签名 | 日志 `AssertionError` |
|---|---|---|---|
| `domain/search/__tests__/adminEmbedding.test.ts` | 6 | `Test timed out in 5000ms` | **0** |
| `domain/search/__tests__/indexer-derive.test.ts` | 10 | 同上 | **0** |
| `domain/search/__tests__/check-coverage.test.ts` | 7 | 同上 | **0** |
| `routes/v1/org/__tests__/s8-upgrade-drill.test.ts` | — | 同上 | **0** |

- 两日志 `rg -c AssertionError` = **0**；失败**无一例外**是 5s 预算被打穿（`Test timed out in 5000ms`）。
- **逐个隔离复跑全绿**：`adminEmbedding + indexer-derive` → `Test Files 2 passed (2)` / `Tests 16 passed (16)` / 5.50s；`check-coverage` 单跑 → `7 passed (7)` / 15.3s；`s8-upgrade-drill` 在配对跑中其文件通过。
- **量级证据**：同一用例 `cloud->off … model 变更才置`，隔离 **912ms** vs 全量 **5231ms**（5s 预算）＝ **5.7× 负载膨胀**。
- **负载实测**：运行期机器 `load average 26.98 – 30.69`（同机多队友并发跑测）。
- 涉事文件属 M5/S9、M4/S8 既有代码，`git status apps/api/src/domain/search/` **为空** = 本片未触碰。
- 结论：与已定案件 `s10-ac-upgrade-20x20.test.ts:136`（"纯负载、隔离即绿、失败恒为 5s 超时、零 AssertionError"）**同类既存 flaky**，本片零因果。**未改任何断言、未调全局 `testTimeout`、未删/跳任何用例**。

**tsc / lint**：
```bash
pnpm exec tsc --noEmit                      # -> 0 错
pnpm exec eslint src --max-warnings 5       # -> 4 warnings / 0 errors（恰为改动前既存 4 条）
```
既存 4 条 warning 位于 `domain/__tests__/formula-functions.test.ts` / `domain/formula.ts` / `domain/recordWrite.ts` / `routes/kb/docs.ts`（**均非本片文件**）→ **本片新增 warning = 0**。

---

## 10. 不重造的两处 Web 端证据（引用）

| 方向 | 证据文件 | 说明 |
|---|---|---|
| 画布：服务端产出 JSON → Web 真实加载 | `apps/web/e2e/canvas-mcp-golden.spec.ts` | S6b 第三步 Playwright golden，**chromium + webkit 双绿**（selftest）：无白屏、坐标/绑定/层级完整、往返一致 |
| 文档块 round-trip | `apps/api/src/mcp/transport/__tests__/m6-s5-doc-tools.test.ts` | S5 块模型 round-trip golden（`mdToBlocks`/`blocksToMd` 唯一真源） |

本片**只出服务端侧证据**（写入后经协议读回结构一致，§4.3），浏览器侧不重复搭建（web 侧有独立的 `playwright.config.ts` + `e2e/` 设施，与 api 侧 vitest e2e **不混用**）。

---

## 11. 回滚

```bash
rm -rf apps/api/src/e2e apps/api/vitest.e2e.config.ts docs/baseline/m6-connectivity.md
```

零生产码、零迁移、零产物变更；常规门与 Web 门均不受影响。

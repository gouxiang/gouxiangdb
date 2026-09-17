# MCP 客户端接入说明（协议无关）

本文给"要把 AI 客户端接到 GouXiangDB"的人看：怎么拿凭证、怎么连、能看到什么、出错怎么判。
内容只依赖 MCP 协议本身与 HTTP/进程约定，不针对任何特定客户端实现。

- 协议面端点与错误口径：[`../api/openapi.yaml`](../api/openapi.yaml) 文末 `x-mcp` 扩展节
- 运维侧（签发/吊销/限流/审计/排障）：[`../runbooks/mcp.md`](../runbooks/mcp.md)
- 端到端连通证据：[`../baseline/m6-connectivity.md`](../baseline/m6-connectivity.md)

> 全文用 `<PAT>` 代指令牌明文。**不要**把真实令牌写进本文档、工单、聊天记录或仓库。

---

## 1. 前置条件

1. 服务器已启用 MCP 面：`GX_ENTERPRISE_ORG=on`（默认）。若未启用，`/mcp` 与 `/api/v1/pats` 都返回 404。
2. 你有一个可登录的账号（账号状态为 ACTIVE）。
3. 你有一枚**个人访问令牌（PAT）**，且 scope 覆盖你要用的工具族。

---

## 2. 第一步：拿一枚 PAT

PAT 用登录态 JWT 通过 REST 签发（**不是**用 PAT 签发 PAT）：

```bash
# $JWT = 登录接口拿到的 Bearer JWT
curl -sS -X POST "https://<host>/api/v1/pats" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "我的 AI 客户端",
    "scopes": ["record:read", "record:write", "doc:read", "doc:write", "canvas:read", "canvas:write"],
    "expiresInDays": 90
  }'
```

响应 `201`：

```json
{
  "id": "pat_...",
  "name": "我的 AI 客户端",
  "scopes": ["record:read", "record:write", "doc:read", "doc:write", "canvas:read", "canvas:write"],
  "token": "<PAT>",
  "tokenPrefix": "gxpat_xxxxxxxx",
  "expiresAt": "2026-12-16T00:00:00.000Z",
  "createdAt": "2026-09-17T00:00:00.000Z"
}
```

`token` **只在这一次响应里出现**，之后任何时候都取不回来（服务端只存摘要）。丢了就重新签发一枚。

六位 scope 的语义：`record:read/write`（基础库与记录）、`doc:read/write`（文档块）、`canvas:read/write`（画布图元）。
`expiresInDays` 可填 `30` / `90` / `365`，或 `null` 表示永不过期；不填默认 90 天。

> scope 只做**族级粗筛**。真正能不能看到某条记录、某个字段，由服务端的权限引擎按你的账号身份判定，
> 与你令牌里写了什么无关。所以：令牌 scope 给宽了不会越权，给窄了会直接看不到工具。

---

## 3. 第二步：选一种传输

同一套工具、同一套认证，两种接法任选（也可以都接）：

| | HTTP | stdio |
|---|---|---|
| 适用 | 远程客户端、多客户端共享一个服务端 | 客户端与服务端同机（本地进程接入） |
| 端点 | `POST https://<host>/mcp` | 本地子进程，无端口 |
| 凭证 | `Authorization: Bearer <PAT>` 头 | `GX_MCP_TOKEN` 环境变量 |
| 子路径部署 | 同时暴露 `{basePath}/mcp`（如 `/app/gouxiangdb/mcp`） | 不适用 |

---

## 4. HTTP 接法

### 4.1 必需的请求头

```
Authorization: Bearer <PAT>
Content-Type: application/json
Accept: application/json, text/event-stream
```

`Accept` 两个类型都要带（Streamable HTTP 的约定）；缺了会得到 406，`Content-Type` 不对会得到 415。

### 4.2 握手与列工具（curl 示例）

```bash
# 初始化
curl -sS -X POST "https://<host>/mcp" \
  -H 'Authorization: Bearer <PAT>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 列工具
curl -sS -X POST "https://<host>/mcp" \
  -H 'Authorization: Bearer <PAT>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 调工具（连通性自检，不涉任何资源）
curl -sS -X POST "https://<host>/mcp" \
  -H 'Authorization: Bearer <PAT>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping_echo","arguments":{"text":"hi"}}}'
```

服务端是**无状态**的：不需要在多个请求之间维系 session，也不靠连接粘性。每个请求独立认证与授权。

### 4.3 客户端 SDK 配置要点

任何支持 MCP Streamable HTTP 的客户端，填这四项即可（各客户端的配置键名不同，按各自文档映射）：

- URL：`https://<host>/mcp`
- 传输：Streamable HTTP（stateless / JSON 响应模式即可）
- 认证头：`Authorization: Bearer <PAT>`
- 附加头：`Accept: application/json, text/event-stream`

### 4.4 连通判据

`tools/list` 返回非空数组，且包含 `ping_echo`；`ping_echo` 调用返回 `pong:hi`。到这一步就说明
网络、前缀、令牌、协议四件事都对；之后剩下的都是权限与参数问题。

---

## 5. stdio 接法

stdio 用的是发布包里同一个可执行文件（不占端口、不起第二服务）：

```bash
GX_MCP_TOKEN='<PAT>' node /path/to/apps/api/dist/mcp-stdio.js
```

- 客户端侧把它配成一个 stdio server 进程即可（命令 + 环境变量两项）。
- 启动时立即校验令牌：缺失 / 为空 / 格式不对 / 已吊销 / 已过期 / 账号停用，**一律以退出码 2 结束**，
  原因写在 stderr。若进程立刻退出，先看退出码是不是 2，再读 stderr 的括号原因。
- stdout 只承载 JSON-RPC 协议流；诊断一律走 stderr。**不要在客户端侧把 stdio 的 stdout 重定向进日志**，
  会把协议流搅乱。
- 客户端关闭 stdin 即视为会话结束，进程正常退出（码 0）。

典型客户端配置形状（键名以各客户端文档为准）：

```json
{
  "mcpServers": {
    "gouxiangdb": {
      "command": "node",
      "args": ["/path/to/apps/api/dist/mcp-stdio.js"],
      "env": { "GX_MCP_TOKEN": "<PAT>" }
    }
  }
}
```

---

## 6. 你能看到哪些工具

`tools/list` 的返回**不是固定清单**，而是下面两个集合的交集：

1. 令牌 scope 允许的族（闸门一，粗筛）；
2. 你的账号在该族确实有可见资源（闸门二）。

几个可预期的现象：

- 只给 `record:read` 的令牌，`tools/list` 里不会有任何写工具（不是报错，是本来就没入册）。
- 被裁掉的工具与"工具名写错"返回**同一个**错误码与文案（不泄漏存在性），所以排查时不要指望从
  错误文案区分"我没权限"和"我拼错了"。
- 有一项检索工具（`record.search`）取决于服务端是否启用了统一检索能力：未启用时它不出现在列表里。
- 工具族：`table.*` / `record.*`（表与记录）、`doc.*`（文档块）、`canvas.*`（画布），外加 `ping_echo` 自检。

### 6.1 三层判定，别混为一谈

服务端对"你能看到什么"分三层判定，它们的失败表现不同，排查时要分清：

| 层 | 判定什么 | 失败表现 |
|---|---|---|
| 令牌作用域（scope） | 这个令牌能不能碰这一**族**（table/record、doc、canvas） | 工具**根本不出现在** `tools/list` |
| 资源权限 | 这条**记录/文档/画布**你看不看得到 | `FORBIDDEN_RESOURCE`；读路径表现为"它不存在" |
| 字段收窄（`fieldMask`） | 这张表里**哪些列**可见/只读 | 列在 `table.get_schema` 里**物理缺席**；写入含该列整单 `FORBIDDEN_FIELD` |

关于字段收窄，有个容易误判的点：`fieldMask.allowFields` 是**在可见集之上的收窄白名单（allow 之上再裁剪）**，
**不是 deny 清单，也不是独立授权来源**。最终可见的列 = 资源可见 ∩ `allowFields`；**没配就等于不裁剪**。

所以：**令牌里把 scope 给宽不会越权**（资源与字段两层都不看 scope），但**给窄会让你直接看不到工具**。
"某列消失了"通常来自服务端的字段收窄配置，不是你的令牌缺了什么——需要就找管理员确认该资源的字段授权。

---

## 7. 错误处理约定（接入方必读）

### 7.1 工具失败不是 HTTP 失败

工具业务失败时，HTTP 状态**仍是 200**，失败体现在响应体的 `result.isError === true`，
真正的机器码在 `result.content[0].text` 里的 JSON 体（字段名 `code`）。

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "isError": true,
    "content": [
      { "type": "text", "text": "{\"code\":\"FORBIDDEN_RESOURCE\",\"message\":\"...\"}" }
    ]
  }
}
```

**判断分支必须读 `code`，不能只看 HTTP 状态。** 常见码：

| code | 含义 | 建议动作 |
|---|---|---|
| `OK` | 成功 | — |
| `UNKNOWN_TOOL` | 工具未入册（权限不够）或名字不对 | 重新 `tools/list` 取实际清单，不要缓存 |
| `UNSUPPORTED_OPERATION` | 操作超出本服务端已开放的能力范围 | 不要重试；改用已开放的操作 |
| `FORBIDDEN_RESOURCE` | 已认证但本次资源/动作无权 | 不要重试；请管理员确认可见集 |
| `FORBIDDEN_FIELD` | 写入包含不可见/只读字段，整单被拒 | 先 `table.get_schema` 拿可见字段再写 |
| `VERSION_CONFLICT` | 乐观锁失配（并发写） | 读响应里的 `currentVersion`，重新读取后重试 |
| `CONFIRM_REQUIRED` | 破坏性操作没带 `confirm: true` | 明确用户意图后再带 `confirm` |
| `RATE_LIMITED` | 工具层限流 | 退避后重试 |
| `TIMEOUT` | 单次调用超时 | 减小单次数据量；**连接仍可复用**，不需要重连 |
| `INVALID_PARAMS` | 入参不符工具 schema | 按工具 schema 修正参数 |

### 7.2 HTTP 层错误

只有这几种情况是 HTTP 层错误：

| 状态 | 含义 | 动作 |
|---|---|---|
| 401 | 令牌不可用 | 见 [`runbooks/mcp.md`](../runbooks/mcp.md) 第 5 章六态判读；不要盲目重试 |
| 413 | 请求体超过 `/mcp` 上限（默认 11MB） | 拆小单次载荷 |
| 429 | 触发限流（IP 桶或令牌桶） | **按 `Retry-After` 秒数退避**，不要并发重打 |
| 406 / 415 | `Accept` / `Content-Type` 不合法 | 按第 4.1 节补齐请求头 |
| 404 | MCP 面未启用（或路径前缀不对） | 找管理员确认部署与 basePath |

### 7.3 退避与重试纪律

- 429：读 `Retry-After`，等足秒数再发；不要用固定短间隔硬打。
- `TIMEOUT`：不是连接坏了，**同一条 HTTP 连接可以直接继续用**（可以紧接着发一次 `ping_echo` 验证）。
- `VERSION_CONFLICT` / `CONFIRM_REQUIRED` / `FORBIDDEN_*` / `UNSUPPORTED_OPERATION`：**不要自动重试**，
  这些是确定性失败，重试只会放大问题。
- 写工具可以带 `requestId`：同令牌 + 同工具 + 同 `requestId` 的重放，在 **24 小时**窗内返回首次结果、
  不会重复落库。适合客户端自己做"网络抖动重发"时的幂等保护。`requestId` 由客户端生成，请用它自己的
  稳定业务 id（上限 128 字符），不要用随机数（随机数起不到幂等作用）。

---

## 8. 令牌安全建议

- 令牌明文只用于配置，不写日志、不进 shell 历史（用环境变量或密钥文件，别写进命令行参数）。
- 给每个客户端/每台机器单独签发一枚令牌并起可辨识的 `name`：出事时可按 `tokenPrefix` 精准吊销。
- 定期轮换：先签发新令牌、切换客户端、确认无 `lastUsedAt` 更新后再吊销旧的。
- 怀疑泄漏时立即吊销（`DELETE /api/v1/pats/{id}`），下一次请求就失效，不需要重启服务。
- 账号被停用会连带吊销该账号的全部令牌，且**重新激活不会自动恢复**——需要重新签发。

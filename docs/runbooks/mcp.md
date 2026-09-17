# M6 鉴权 MCP 服务 Runbook（PAT 签发/吊销、两入口、限流与超时调档、401 判读、审计）

适用：M6 鉴权 MCP 服务（`/mcp` 协议面 + `/api/v1/pats` 管理面 + `dist/mcp-stdio.js` 第二入口）
启用后的运维。覆盖 PAT 生命周期、门控开关、两入口启动与排障、三个可调旋钮、401 六态判读、
审计字段与"永不记录"清单、常见故障处置。

事实真源：

- 实施计划 [`../planning/phase2/M6-implementation-plan.md`](../planning/phase2/M6-implementation-plan.md)
  §4.1 中间件序、§4.3 认证口径、§4.5 工具契约、§5.1 停用联动、§5.3 限流双键、§5.4 可观测、§6 契约纲要；
- 接口契约 [`../api/openapi.yaml`](../api/openapi.yaml) 的 `/pats` 段与文末 `x-mcp` 扩展节（协议面非 REST）；
- 出口证据 [`../baseline/m6-connectivity.md`](../baseline/m6-connectivity.md)（三客户端 / 四对抗 / IDOR / 401 五态 / §460 三项）；
- 架构决策：ADR-0051（SDK 直桥 + 每请求无状态）、ADR-0052（PAT 凭证模型）、ADR-0053（双闸门与 UNKNOWN_TOOL 口径）、
  ADR-0054（11MB 豁免与 patId 独立限流）、ADR-0055（块模型下沉与画布最小写入）。

> 命令默认在 api 应用目录（发布物的 `apps/api` 或等价 current 目录）执行；生产 `DATABASE_URL`
> 与 `GX_AUDIT_DIR` 由 `/etc/gouxiangdb/env.conf` 注入。改库前先按 [backup.md](backup.md) 做一次
> 在线备份。M6 为单实例部署（ADR-0003），限流桶与幂等表都以此为前提。

---

## 1. 门控：`GX_ENTERPRISE_ORG`

`/mcp` 与 `/api/v1/pats` **同受** `GX_ENTERPRISE_ORG` 门控（C-5 定稿；两者都不看 `GX_ENTERPRISE_NAV`）。

| 状态 | `/mcp` | `/api/v1/pats` | 说明 |
|---|---|---|---|
| `GX_ENTERPRISE_ORG=on`（默认） | 挂载，可服务 | 挂载，可服务 | 正常运营态 |
| `GX_ENTERPRISE_ORG=off` | **不挂载**，顶层 404 | 不挂载，顶层 404 | 整个 MCP 面对外下线 |

### 1.1 紧急收回（flag off）

设置 `GX_ENTERPRISE_ORG=off` 后重启（改 `/etc/gouxiangdb/env.conf`，`systemctl restart gouxiangdb`）：

- 能收回：`/mcp` 与 `/api/v1/pats` 的全部 HTTP 入口（404 `{error,code:"NOT_FOUND"}`）。
  这把 AI 接入面整体摘掉，旧 `/api/*` 数据面不受影响、继续可用。
- 不能收回（必须明确）：**flag off 不等于令牌作废**。PAT 行仍在库里、`revokedAt` 仍为空，
  重新置 on 后**原令牌立即恢复可用**。要真正断掉某个令牌，走第 2 章的吊销，不要靠关 flag。
- `dist/mcp-stdio.js` 不受 flag 影响（它是本地子进程读本地库，不走 HTTP 路由）。
  要停 stdio 接入，靠"不发令牌/吊销令牌"，见第 4 章。

### 1.2 未升级与未认证的区分（判障第一步）

| 现象 | 含义 | 处置 |
|---|---|---|
| `POST /mcp` 得 404 `NOT_FOUND` | flag off（未挂载）或路径/前缀写错 | 查 flag 与 basePath（见第 3.3） |
| `POST /mcp` 得 401 | 已挂载，但令牌不可用 | 走第 5 章六态判读 |
| `POST /mcp` 得 200 但 `error.code = -32602` | 协议与令牌都正常，是**工具层**业务失败 | 看 `content[0].text` 的 `code`，码表与处置见第 7 章 |

---

## 2. PAT 的签发与吊销

REST 契约见 openapi 的 `/pats` 段；此处给运维命令。三个端点都要求 `Authorization: Bearer <JWT>`
（登录态 JWT，不是 PAT），且只作用于本人数据。

### 2.1 签发

```bash
# 默认有效期 90 天；scopes 必须是六位子集且非空。
curl -sS -X POST "$API/api/v1/pats" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"AI 助手接入","scopes":["record:read","record:write","doc:read"],"expiresInDays":90}'
```

- 响应 `201`，**`token` 字段只在这一次出现**。之后任何端点都不再返回它，库里只存 sha256 摘要。
  把明文交给人/交给客户端后，服务端侧**无法再取回**；丢了只能重新签发。
- `tokenPrefix` 是明文前 14 字符（`gxpat_` 加 8 随机字符），只用于列表辨识与排障关联，**不可认证**。
- `expiresInDays` 取 `30` / `90` / `365` / `null`；键缺省等于 90 天；显式 `null` 表示永不过期
  （UI 侧有强警示，运维侧建议除特殊场景外都用有限期）。
- 入参非法返回 400，`code` 为 `PAT_NAME_INVALID` / `PAT_SCOPE_INVALID` / `PAT_EXPIRY_INVALID`。

### 2.2 列表（排障主入口）

```bash
curl -sS "$API/api/v1/pats" -H "Authorization: Bearer $JWT"
```

返回数组，每项八键：`id / name / tokenPrefix / scopes / expiresAt / revokedAt / lastUsedAt / createdAt`。
按 `createdAt` 降序，**绝不含 `token` 或 `tokenHash`**。

直接查库关联"同一坏令牌反复尝试"（审计里的 `patPrefix` 与库里 `tokenPrefix` 对齐）：

```bash
sqlite3 "$DB" "SELECT id, name, tokenPrefix, scopes, expiresAt, revokedAt, lastUsedAt \
               FROM personal_access_tokens WHERE tokenPrefix = 'gxpat_XXXXXXXX' ORDER BY createdAt DESC;"
```

### 2.3 吊销

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "$API/api/v1/pats/$PAT_ID" -H "Authorization: Bearer $JWT"
# 期望 204
```

- 置 `revokedAt` 软吊销，**不物删行**（保留审计可追溯）。
- 生效即时：下一次 `/mcp` 请求就 401（每请求重认证、无会话缓存，不需要等任何 TTL 或重启）。
- 非本人令牌 / 不存在的 id / 已吊销的 id **统一 404 `PAT_NOT_FOUND`**，用于不泄漏存在性。
  所以"删了返回 404"不代表删除失败，见第 7 章故障表。
- 吊销是终态：重新激活账号、或把 flag 重新打开，都**不会**把令牌救回来。

### 2.4 停用账号的连带吊销（C-4）

停用成员时，服务端在**同一事务内**把该用户所有 `revokedAt IS NULL` 的 PAT 批量置为已吊销
（`disableUser` 的写事务里加一条 `updateMany`）。因此：

- 停用后不必逐个吊销；`/api/v1/pats` 列表里每条都会显示 `revokedAt` 非空。
- **重新激活不自动恢复 PAT**（吊销是终态，安全优先）：激活后需要重新签发新令牌，并把新明文交给客户端替换。
- 令牌行有效的账号停用属另一条路（C-4 纵深防御）：即使 `revokedAt` 为空，`/mcp` 边缘仍会因账号非 ACTIVE
  而拒，文案 `Account disabled`。两条路互为兜底，验证停用闭环时两条都应能观察到。

验证停用闭环（三步）：

```bash
# 1) 停用前：令牌可用
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/mcp" -H "Authorization: Bearer <PAT>" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'     # 200
# 2) 停用该成员（管理面），随后再打一次：应为 401
# 3) 重新激活后：仍应 401（须重新签发）
```

---

## 3. 两个入口

### 3.1 HTTP 入口（`/mcp`）

- 由 API 进程直接提供：裸机部署经 Caddy 反代；容器部署由同一进程托管前端静态。
- 无状态直桥：每请求新建 server 与 transport（`sessionIdGenerator: undefined`、
  `enableJsonResponse: true`），不维护会话。**这就是吊销/调岗/改权限"下一次请求即生效"的机制保证。**
- basePath 子路径部署下同一进程还暴露 `{basePath}/mcp`（例如 `/app/gouxiangdb/mcp`），
  协议语义不参与路径（spike §2.1 实测）。判障时先确认前缀。

```bash
# 最小连通自检（替换 <host>、<PAT>）
curl -sS -X POST "https://<host>/mcp" \
  -H 'Authorization: Bearer <PAT>' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

启动日志里应有一行挂载提示（§5.4）：

```
[mcp] streamable-http mounted at /mcp (stateless json, body=11mb)
```

### 3.2 stdio 入口（`dist/mcp-stdio.js`）

只是**随包投递的一个文件**：不起第二个常驻服务、不占端口、不碰 HTTP 监听（C-5）。

```bash
GX_MCP_TOKEN='<PAT 明文>' node dist/mcp-stdio.js
```

- 启动即校验 `GX_MCP_TOKEN`：**缺失 / 为空 / 格式非法 / 不可用一律退出码 2**。
  stderr 文案区分具体原因（`GX_MCP_TOKEN missing: ...` 与 `GX_MCP_TOKEN invalid (<reason>): token 不可用`），
  但对外语义统一是"token 不可用"，不区分给客户端。
- 与 HTTP 共用同一个 `buildServer` 与同一套 `authenticatePat`，**没有第二份工具注册实现**。
  因此 HTTP 侧的工具准入与拒绝口径在 stdio 侧逐字相同。
- 通道纪律：stdout 只写 JSON-RPC 协议流，一切诊断走 stderr。**不要在 stdout 上打印任何日志**，
  否则会污染协议流导致客户端解析失败。
- 客户端关闭 stdin（管道 EOF）即视为会话结束，进程正常退出 0；残留进程说明客户端没关管道。
- 审计来源固定为 `ip=stdio / path=stdio / method=STDIO`（不伪造 IP）。

### 3.3 404 / 401 / 200 三分（快速定位）

```bash
# 挂载与门控
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 404 = 未挂载（flag off / 前缀不对）；401 = 已挂载但无令牌（正常）
```

---

## 4. 三个运行旋钮（改 env 后重启进程生效）

| 旋钮 | 环境变量 | 默认 | 作用 |
|---|---|---|---|
| 请求体上限 | `GX_MCP_BODY_LIMIT` | **11MB** | 只管精确路径 `/mcp`；`/api` 的 1MB 与上传 6MB 语义不变 |
| 工具调用超时 | `GX_MCP_TOOL_TIMEOUT_MS` | **30000** | 单次 `tools/call` 上限；超时返回结构化 `TIMEOUT` |
| 限流（认证前 IP 桶） | `GX_MCP_RATE_IP_MAX` / `GX_MCP_RATE_WINDOW_SEC` | **300 次 / 60 秒** | 防未认证流量打爆 |
| 限流（认证后 patId 桶） | `GX_MCP_RATE_PAT_MAX` / `GX_MCP_RATE_WINDOW_SEC` | **120 次 / 60 秒** | 按令牌隔离配额 |
| 限流（PAT 管理敏感档） | `GX_MCP_RATE_PAT_REST_MAX` / `GX_MCP_RATE_PAT_REST_WINDOW_SEC` | **30 次 / 60 秒 / 人** | 只管 `/api/v1/pats` 的 POST 与 DELETE |

### 4.1 调档注意事项

- 三个桶是**互不干扰的独立实例**：IP 桶、patId 桶、PAT 管理桶各自计数。放宽一个不影响另一个。
- `/mcp` 的限流内聚在 `/mcp` 子应用内，**不写进全局规则表**（全局对 `/mcp` 的 `selectRule` 仍返回 null），
  所以不会出现"双重计数"。改动只影响 `/mcp`。
- 计数是**进程内内存固定窗**：重启即清零。多实例部署会退化成"每实例各一份配额"——
  M6 按单实例设计（ADR-0003），上多实例前必须先解决这一点。
- AI agent 的调用形态可能比人陡得多（单令牌连续循环调用）。若在 NAS 等小规格机上观察到
  连续触发 429，优先**放大 patId 桶**而不是关限流；关掉等于把打爆风险转嫁给数据库。

### 4.2 体积上限与反代的余量（必须成对检查）

- /mcp 上限 11MB；裸机部署的 Caddy `request_body { max_size 12MB }`（`deploy/caddy/Caddyfile`，
  全局一条，不是 /mcp 专用）。两者之间只有 1MB 余量。
- 改大 `GX_MCP_BODY_LIMIT` 时**必须同步放大 Caddy 侧**，否则请求在反代层先被拒
  （现象：应用日志里看不到 413，客户端拿到的是 Caddy 的 413 页面）。
- 改小则不必动 Caddy。
- 容器/NAS 网关（飞牛等）另有一层上传上限，同理需要对齐。

---

## 5. 401 六态判读表

HTTP 层统一返回 401，附带 `WWW-Authenticate: Bearer realm="gouxiangdb-mcp"`，
错误体是 JSON-RPC 形态（`id` 恒为 null）：

```json
{"jsonrpc":"2.0","error":{"code":-32001,"message":"<文案>"},"id":null}
```

| 触发条件 | 内部 reason | `message` | 对外可辨识？ |
|---|---|---|---|
| 无 `Authorization` 头，或值不是 `Bearer ` 前缀 | `missing_bearer` | `Unauthorized` | 否（与下两行逐字节一致） |
| Bearer 值缺少 `gxpat_` 前缀（不查库，防枚举） | `not_pat_prefix` | `Unauthorized` | 否（同上） |
| sha256 摘要查不到该令牌 | `unknown_token` | `Unauthorized` | 否（同上） |
| 令牌行 `revokedAt` 非空 | `revoked` | `Token revoked` | 是 |
| 令牌行 `expiresAt` 已过 | `expired` | `Token expired` | 是 |
| 令牌行有效但账号非 ACTIVE | `account_disabled` | `Account disabled` | 是 |

**口径（计划 §4.3）**：拿不出有效令牌的三种情况响应体逐字节一致；已过期 / 已吊销 / 账号停用各自可辨识。

判障步骤：

1. 401 且文案 `Unauthorized`：先用 `sqlite3` 按 `tokenPrefix` 查库（第 2.2 节）。
   查得到行 -> 说明客户端给的令牌**不是**这一行（可能被截断、被引号包裹、或复制时少了字符）；
   查不到行 -> 令牌已不在库中（换了环境/换库/从未签发）。
2. 401 且文案 `Token revoked`：看 `revokedAt` 时间，对照是否有停用操作或手工吊销。
3. 401 且文案 `Token expired`：重新签发并把新明文交付客户端。
4. 401 且文案 `Account disabled`：走组织面重新激活账号，**并重新签发 PAT**（原令牌是终态吊销）。
5. 认证失败**必然入审计**（`mcp_auth_failure`），用 `patPrefix` 与 `reason` 关联（第 6 章）。

---

## 6. 审计

审计是 JSONL（一行一条 JSON），落在 `$GX_AUDIT_DIR/audit.logl`
（生产默认 `/var/log/gouxiangdb`；开发/测试默认 `<dataDir>/.audit`）。目录与文件权限 `0640`。

### 6.1 四枚事件

| event | 触发 | status |
|---|---|---|
| `mcp_pat_create` | `POST /api/v1/pats` 成功 | 201 |
| `mcp_pat_revoke` | `DELETE /api/v1/pats/{id}` 成功 | 204 |
| `mcp_tool_call` | **每次** `tools/call`（成功与被拒都记） | 由 `resultCode` 映射 |
| `mcp_auth_failure` | 边缘认证失败（HTTP 与 stdio 两入口都记） | 401 |

`mcp_tool_call` 的 `status` 是**审计行的语义码**，不是响应码（工具业务失败时 HTTP 仍是 200）：
`OK=200 / UNKNOWN_TOOL=404 / UNSUPPORTED_OPERATION=400 / FORBIDDEN_RESOURCE=403 / FORBIDDEN_FIELD=403 /
VERSION_CONFLICT=409 / CONFIRM_REQUIRED=400 / RATE_LIMITED=429 / TIMEOUT=504 / INVALID_PARAMS=400 /
IN_PROGRESS=409 / INTERNAL_ERROR=500`。

### 6.2 字段（白名单）

公共：`event / ts / actorId / ip / method / path / status`。

`mcp_tool_call.detail`：`patId / tool / resultCode / resource{kind,id} / args{白名单} / requestId / durationMs / idempotentReplay`。

- `args` 只保留资源 id 标量与元信息（`recordId/docId/canvasId/tableId/baseId/limit/baseVersion/confirm/mode/afterBlockId/blockId`），
  外加 `hasCursor`（只记存在性）与 `requestId`。
- `requestId` 随请求落库到 `mcp_idempotency`（key 主键 + 24 小时窗），重放返首次结果并标 `idempotentReplay: true`。

`mcp_auth_failure.detail`：`reason / patPrefix`（仅限 `gxpat_` 形态；非该形态不落前缀）。

### 6.3 永不记录清单（硬纪律）

- **完整 PAT 明文**（任何事件、任何字段、任何日志行都不出现）；
- `Authorization` 头原值；
- `hashToken` 的输入与输出；
- 业务值本身：`fields` / `ops` / `patch` / `element` / `content` 等（只记 id 与元信息）；
- 被拒资源的内容与名称（防"拒绝路径变相成为读取路径"）。

该纪律由 e2e 的审计扫描用例守护（含"审计全文不出现令牌随机段"的断言），证据见
[`../baseline/m6-connectivity.md`](../baseline/m6-connectivity.md) §4.4。

### 6.4 幂等表维护（`mcp_idempotency`）

写工具的 `requestId` 幂等落在这张表（C-8：不用进程内 Map，重启不丢）。键 = `patId` + 工具名 +
`requestId`（JSON 编码，无分隔符歧义），去重窗 **24 小时**。

- 语义：同 key 的重放在窗内**返回首次结果且不重复执行**（先占位再执行，占位失败者读回首次结果）。
- **过期行不主动清理**（表极小），需要时手工清：

```bash
# 清理 24 小时以前的行（幂等窗已过，删掉不影响语义）
# 注意：Prisma 在 SQLite 里把 DateTime 存成 INTEGER（unix 毫秒），所以**不能用**
# datetime('now','-24 hours') 这类文本比较——SQLite 里整数恒小于文本，那样写会把整表删光。
# 必须换算成毫秒整数比较：
sqlite3 "$DB" "DELETE FROM mcp_idempotency WHERE createdAt < (strftime('%s','now') * 1000 - 86400000);"
# 先干跑看清楚会删多少（务必先跑这条，再决定是否删）
sqlite3 "$DB" "SELECT count(*) FROM mcp_idempotency WHERE createdAt < (strftime('%s','now') * 1000 - 86400000);"
# 看规模与现存行的时间范围
sqlite3 "$DB" "SELECT count(*), min(createdAt), max(createdAt) FROM mcp_idempotency;"
```

- 幂等表 `createdAt` 的 DDL 默认值是 `CURRENT_TIMESTAMP`，但正常路径由 Prisma 显式写入毫秒整数。
  若曾用裸 SQL 插过行，那些行可能是文本格式，会与上面的整数比较不一致（表现为"删不掉"）。
  用 `SELECT typeof(createdAt), count(*) FROM mcp_idempotency GROUP BY 1;` 确认全表类型一致。

- 注意表里存的是**首次响应体**。它可能包含业务数据（该次调用的返回内容），因此该库文件的权限与备份
  按主库同等对待；不要把它导出到不受控的地方。
- 若在窗内删了某行，随后同 key 的重放会被当成一次**新**调用重新执行（幂等保护失效）。所以清理要按
  "早于窗口"的条件删，不要清空全表。

### 6.5 常用判读命令

```bash
# 最近 20 条 MCP 侧审计
tail -n 200 "$GX_AUDIT_DIR/audit.logl" | grep -E '"mcp_(tool_call|auth_failure|pat_)' | tail -20

# 按 resultCode 聚合（先装 jq 更省事）
grep -F '"mcp_tool_call"' "$GX_AUDIT_DIR/audit.logl" | jq -r '.detail.resultCode' | sort | uniq -c | sort -rn

# 某枚令牌的使用轨迹
grep -F '"patId":"<PAT_ID>"' "$GX_AUDIT_DIR/audit.logl" | tail -20

# 认证失败的原因分布（含来源前缀，便于判断是否被扫）
grep -F '"mcp_auth_failure"' "$GX_AUDIT_DIR/audit.logl" | jq -r '.detail.reason + " " + (.detail.patPrefix // "-")' | sort | uniq -c | sort -rn
```

日志轮转见 [deploy.md](deploy.md)（logrotate 小节）。

---

## 7. 常见故障处置

| 现象 | 可能原因 | 处置 |
|---|---|---|
| stdio 进程立刻退出，退出码 **2** | `GX_MCP_TOKEN` 未设 / 为空 / 不是 `gxpat_` 形态 / 令牌已吊销、已过期、账号停用 | 看 stderr 文案里的 `(reason)`；按第 5 章对应处置；确认不是把 `tokenPrefix` 当令牌传了 |
| `tools/list` 里少了写工具 | 令牌 scope 不含对应写位（闸门一：粗筛不入册） | 重新签发带写位的令牌；这是设计行为，不是故障 |
| `tools/list` 里少了一整族工具 | 该主体在该族没有可见资源（闸门二：族可见集为空） | 先用 M4 的 `/api/v1/authz/visible-scope` 或 `/nodes/{id}/effective` 确认可见集 |
| `tools/list` 里没有 `record.search` | `GX_M5_SEARCH=off` | 属预期（该工具受 M5 门控）；需要检索就开 M5 |
| 调用被裁工具返回 `UNKNOWN_TOOL` | 工具未入册（作用域不够或族不可见） | 与"工具名写错"同码同文案，不泄漏区别；按上一行排查 |
| **429 + `Retry-After`** | 命中两段式限流之一，或 PAT 管理敏感档 | 客户端须按 `Retry-After` 秒数退避后重试（不要立刻重打、不要加并发）；持续命中则按 4.1 调 patId 桶 |
| 单次调用返回 `TIMEOUT`，但连接随后仍可用 | 工具超过 `GX_MCP_TOOL_TIMEOUT_MS` | **不是连接故障**：HTTP 连接不被切断，可在同一连接继续发请求。加大超时前先确认是不是数据量本身过大 |
| `404 NOT_FOUND` 打 `/mcp` | flag off，或 basePath 前缀不对 | 见 1.2 与 3.3 |
| `406` / `415` | 客户端 `Accept` 或 `Content-Type` 不合法 | 补 `Accept: application/json, text/event-stream` 与 `Content-Type: application/json` |
| `413` 且机器码是 `MCP_PAYLOAD_TOO_LARGE` | 单次请求体超过 `/mcp` 档 | 减少单批数据量，或按 4.2 同步放大应用与反代两侧 |
| 客户端收到 413 但应用日志无记录 | 被 Caddy（或 NAS 网关）先拒 | 放大前置反代的上限，见 4.2 |
| 删令牌返回 404 | 非本人 / 不存在 / 已吊销，三者同码 | 属设计（不泄漏存在性）；用 `GET /api/v1/pats` 确认 id 是否仍在本人列表中 |

### 7.1 已知取舍与安全提醒（如实登记，不是缺陷但要知道）

- **MCP Inspector 的 `--header` 会把令牌写进进程命令行**：`--header 'Authorization: Bearer <PAT>'`
  是该工具的既定用法，令牌会出现在该机 `ps` 输出与 shell 历史中。因此：
  只用它在**本机自检**；不要把令牌交给任何会落到共享机器的脚本；自检完成后吊销这枚短命令牌。
- **1MB 反代余量**：见 4.2，改大应用上限必须同步改 Caddy。
- **`tokenPrefix` 是 14 字符且不可认证**，但它**确实会**出现在 `GET /api/v1/pats` 响应与审计里。
  把它当"半公开标识"对待，不要在对外材料里当作可脱敏边界。
- **审计文件名是 `audit.logl`**（不是 `audit.log`）：这是历史命名，采集/轮转配置按实际文件名对齐，
  不要按直觉写 `audit.log`。

---

## 8. 权限判定两层：scope 粗筛与 fieldMask 字段收窄（排障口径）

排障时最容易把这两层混为一谈，这里写死口径（S8 出口基线 §8-11 登记要求 S9 文档写明）：

| 层 | 判定什么 | 真源 | 表现 |
|---|---|---|---|
| 令牌作用域（scope） | **族**级：这个令牌能不能碰 table/record、doc、canvas 这几族 | PAT 行 `scopes` | 不含写位则写工具**不入册**（`tools/list` 里直接没有） |
| 资源权限（M4） | **这条记录/文档/画布**看不看得到、能不能改 | M4 权限引擎（与令牌无关，按账号身份求值） | 不可见则以 `FORBIDDEN_RESOURCE` 拒绝；读路径表现为"它不存在" |
| 字段收窄（fieldMask） | **这张表里哪些列**可见/只读 | M4 节点策略行的 `fieldMask.allowFields` / `readOnlyFields` | 不可见列在 `table.get_schema` 里**物理缺席**；写入含该列则整单 `FORBIDDEN_FIELD` |

**fieldMask 的准确语义（易错点）**：

- 它是**在 M4 可见集之上的显式收窄白名单（allow 之上再裁剪）**，**不是 deny 清单**，也**不是独立授权来源**。
  换句话说：`allowFields` 只能把"本来能看到的一部分列"再收窄，**不能**把"本来看不到的记录"变成可见。
- 最终可见 = 资源可见（M4 决定整条记录看不看得到）**∩** `allowFields`（决定看得到哪些列）。
- **缺省或空 `fieldMask` = 不裁剪**（不是"全禁"）。所以"某列看不到"要分清是没配 allowFields 的收窄造成的，
  还是该主体本来就没有这条记录的权限。
- 排障手法：同一条记录用两个不同身份各发一次 `table.get_schema`，列集差异即 `allowFields` 的收窄效果；
  若连记录都取不到，则问题在资源级（走 M4 的 `/api/v1/nodes/{id}/effective` 或 `/api/v1/authz/visible-scope`）。

**不泄漏区别（对外）**：请求含 `allowFields` 之外的字段走 `FORBIDDEN_FIELD`，请求不可见资源走
`FORBIDDEN_RESOURCE`，两者码不同但都**不回显**被拒字段/资源的内容；读路径一律表现为"该字段/该资源不存在"，
不起"这里有个你看不到的东西"的提示。因此不要试图从错误文案区分"列被收窄"与"记录无权"，请用上面的排障手法。

---

## 9. 升级与回滚

### 9.1 SDK 与产物

- MCP SDK 精确 pin（ADR-0051）。升级 SDK 必须重跑 S8 出口门（三客户端 + 四对抗 + 401 五态），
  因为协议行为与 Inspector 版本敏感；e2e 套件与固定版本的 Inspector CLI 已入库，按
  [`../baseline/m6-connectivity.md`](../baseline/m6-connectivity.md) §3 的命令复跑即可。
- `dist/mcp-stdio.js` 与 `dist/index.js` 同一构建产出（`apps/api/scripts/build.mjs` 双入口），
  `apps/api/package.json` 的 `bin.gx-mcp-stdio` 指向它。**发布物必须包含该文件**，
  否则 stdio 接入在目标机上直接缺失（S8 的 e2e 前置会因产物缺失而直接报错，不会空转通过）。
- 部署物核查项：Docker 镜像里 `apps/api/dist` 整体 COPY（含 stdio 产物）；fpk 打包清单含同一路径。

### 9.2 回滚

- 协议面回滚的最快路径是 `GX_ENTERPRISE_ORG=off`（摘路由，见 1.1）。
- 数据面回滚按 [rollback 说明](deploy.md)：PAT 两表（`personal_access_tokens`、`mcp_idempotency`）
  是只增迁移，回滚老版本时留着不动即可，不影响老版本的任何读写路径。
- 关 MCP 面**不会**影响旧 `/api/*`（旧路由在 M6 实施期间零改动，见 M6 出口基线的"旧路由零 diff"证明）。

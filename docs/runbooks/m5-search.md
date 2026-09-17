# M5 统一检索（search.db / 向量 / 降级自愈）Runbook

适用：M5 统一检索面（`GX_M5_SEARCH=on|shadow|off`）启用后的运维，覆盖

- off/cloud 两态的「零外网」抓包验收（AC-M5-5，本手册第 1 章，发版/S13/S14 必跑）；
- search.db 物理损坏自愈（AC-M5-1 Gap A）与降级跳变审计（Gap B）的现场判读；
- vec0 原生扩展、musl 禁令、search.db 可重建资产边界、reindex、NFS、model/dim 切换。

事实真源：[`../planning/phase2/M5-implementation-plan.md`](../planning/phase2/M5-implementation-plan.md) §4.9 降级矩阵、§6 flag 纪律、§12 供应链；ADR-0042/0044/0045/0046/0048/0049/0050。

---

## 1. AC-M5-5「off 零外网」抓包验收（核心）

**判定标准（两种姿态都必须满足）**：

1. **`GX_M5_SEARCH=off`（出厂默认）**：跑完一整套「检索旧端点 + 主写（records POST/PATCH、kb PUT content）+ status」链路，抓包记录里**没有任何**外部方向连接（embedding 端点一次都不发），且不产生 `search.db` 文件。
2. **`GX_M5_SEARCH=on` 但 `GX_EMBEDDING_MODE=off`（切 on 后的出厂默认）**：同样跑完整链路，**零**外部连接；检索走 FTS5 trigram + 短词 LIKE，不向量化。
3. **cloud 仅在显式启用后**：管理员 `PATCH /api/v1/admin/embedding/config` 把 mode 改 cloud 且带 `confirmCloud:true` 之后，才允许出网，且**所有**外联只朝配置的 `GX_EMBEDDING_BASE_URL`（OpenAI 兼容 `/v1/embeddings`）host；无任何第三方遥测/分析/CDN 方向。off→cloud 不带 `confirmCloud:true` 必须 `409 NEED_CLOUD_CONFIRM`，且这一步本身零出网。

### 1.1 关键事实：Node 22 全局 fetch 不读代理环境变量

M5 cloud provider 用 Node 全局 `fetch`（undici），**默认不读 `http_proxy` / `HTTP_PROXY` / `https_proxy` / `HTTPS_PROXY` / `no_proxy`**。
因此「设了 `HTTPS_PROXY` 就在代理上看到全部流量」对本服务**不成立**——只设这些环境变量，流量仍直连，代理侧零记录会被误判成「零出网」（假阴性）。验收必须用下面两条之一，二者都可复现：

- **方案 A（推荐，结论最硬）：透明包捕获**。不依赖应用是否尊重代理变量，在网络层把所有出站 SYN/连接记录下来。
- **方案 B：显式 undici 代理 + 私有 CA**。给 Node 进程装全局 `ProxyAgent` 并信任抓包 CA（等价 `NODE_EXTRA_CA_CERTS`），让 TLS 对中间人可见。

### 1.2 方案 A：透明/包捕获（无需改应用、无需装 CA）

在被验机同网段的一台抓包机（或本机回环 + 一个抓包口）上做被动捕获。最省事的是直接在**运行 API 的同一台机**用 `tcpdump` 抓出站包（NAS/Linux 自带或可装）；只看连接方向，不解 TLS 内容即可判零。

```bash
# 1) 先确认当前没有无关进程噪声；抓除回环/局域网外的出站 SYN（按本机网段改 nets）
sudo tcpdump -i any -n -w /tmp/gx-off-egress.pcap \
  'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0 and not dst net 127.0.0.0/8 and not dst net 10.0.0.0/8 and not dst net 192.168.0.0/16 and not dst net 172.16.0.0/12'
```

> 若数据/检索流量也在同机回环（自管 SQLite，无网络），排除回环不影响结论——M5 唯一可能的出网就是 cloud embedding 的 HTTPS。

另一终端用**出厂 off 环境**启动（systemd 覆写或直接命令行；变量清单见 §6）：

```bash
sudo systemctl stop gouxiangdb-api
sudo GX_M5_SEARCH=off \
  GX_DATA_DIR=/var/lib/gouxiangdb \
  GX_AUDIT_DIR=/var/log/gouxiangdb \
  JWT_SECRET="$(sudo cat /etc/gouxiangdb/jwt.secret)" \
  /opt/gouxiangdb/server/bin/node /opt/gouxiangdb/server/dist/index.js
# 注意：不要设置任何 GX_EMBEDDING_* 变量（未配置远端即 off）。
```

再开第三终端跑完整业务链路（owner token 获取方式见 deploy.md；下例用 `$TOKEN`）：

```bash
B=http://127.0.0.1:8080
# 旧检索端点（GX_M5_SEARCH=off 时 /api/v1/search 应 404，旧 /api/search 200）
curl -s -o /dev/null -w "v1=%{http_code}\n" "$B/api/v1/search?q=zeroegress" -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "legacy=%{http_code}\n" "$B/api/search?q=zeroegress" -H "Authorization: Bearer $TOKEN"
# 主写：records POST/PATCH、kb PUT content（证明零外网姿态下主写不受影响）
curl -s -o /dev/null -w "recPOST=%{http_code}\n" -X POST "$B/api/records" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"tableId":"<TID>","fields":{"<FID>":"zeroegress write"}}'
curl -s -o /dev/null -w "recPATCH=%{http_code}\n" -X PATCH "$B/api/records/<RID>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"tableId":"<TID>","fields":{"<FID>":"zeroegress patch"}}'
curl -s -o /dev/null -w "kbPUT=%{http_code}\n" -X PUT "$B/api/kb/docs/<DOCID>/content" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"content":"# zeroegress\n\nbody"}'
```

停止 tcpdump（Ctrl-C）后判读：

```bash
# 期望：没有任何出站 SYN 行（输出为空）= 通过
tcpdump -nn -r /tmp/gx-off-egress.pcap 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'
# 且出厂 off 不产生 search.db
sudo ls -l /var/lib/gouxiangdb/search.db 2>/dev/null || echo "OK: no search.db in off"
```

再以 `GX_M5_SEARCH=on`（不设任何 `GX_EMBEDDING_*`）重启，重复同样的捕获 + 业务链路（此时 `/api/v1/search?q=...` 应 200，响应 `mode` 为 `fts`/`like`，`degraded` 不含 embedding 项），**捕获仍须零出站 SYN**。

### 1.3 方案 B：显式代理 + 私有 CA（可看明文/host，等价 mitmproxy）

只有在需要看到解密后的 HTTP 目标（确认只打 `/v1/embeddings`、确认 host 白名单）时才需要，用来验 cloud 姿态。

```bash
pip install mitmproxy          # 或下官方二进制
mitmweb --listen-host 127.0.0.1 --listen-port 8888 --set block_global=false
# 首次启动后信任其 CA（Linux 系统/Node 两条都要）：
#   Node 只认自己的 CA 束，需显式指向 mitm CA：
export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

由于 Node 全局 fetch 不读 `HTTPS_PROXY`，需要给进程装一个指向 mitm 的全局 dispatcher。用 `NODE_OPTION` 预载一个极小引导（一次性验收脚本，不进生产镜像）：

```js
// /tmp/gx-proxy-bootstrap.cjs
const { setGlobalDispatcher, ProxyAgent } = require("/opt/gouxiangdb/server/node_modules/undici");
setGlobalDispatcher(new ProxyAgent("http://127.0.0.1:8888"));
```

```bash
NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
NODE_OPTIONS="--require /tmp/gx-proxy-bootstrap.cjs" \
GX_M5_SEARCH=on \
/opt/gouxiangdb/server/bin/node /opt/gouxiangdb/server/dist/index.js
```

- **off 态**：mitm 流列表应**一条连接都没有**（跑完整检索+主写链）= 通过。
- **cloud 显式启用**：先 `PATCH .../embedding/config` 不带 `confirmCloud`，断言 `409 NEED_CLOUD_CONFIRM` 且 mitm 无新连接；再带 `"mode":"cloud","confirmCloud":true,"baseURL":"https://embeddings.example.internal/v1","model":"<m>"` 并先 `POST .../api-key/rotate`，触发一次 reindex/检索，mitm 中**只应出现**到 `embeddings.example.internal` 的 `POST /v1/embeddings`；出现任何 `telemetry.*`/`analytics.*`/`sentry.*`/CDN/其它 host 即失败。

> 不要用「设了 `HTTPS_PROXY` 但没装 dispatcher、代理零记录」当证据——那是 Node 不读代理变量造成的假阴性。

### 1.4 自动化确定性证据（仓内，CI 层 (e)）

人工程序抓包之外，仓内 vitest 用「拦截全局 fetch + fail-closed」给出可重复的确定性证据（不触真外网）：

- `apps/api/src/routes/v1/__tests__/m5-s12-zero-egress.test.ts`
  - **用例 A**：安装 fail-closed fetch（任何调用即抛错并记录），`GX_EMBEDDING_MODE=off` 跑 auto/fts 检索 + records POST/PATCH + kb PUT + admin status，全部成功且 `embeddingCalls.length === 0`；
  - **用例 B**：`GX_M5_SEARCH=off` 时 `/api/v1/search` 404、旧 `/api/search` 200、`search.db` 不存在、fetch 零调用；
  - **用例 C**：出厂 off 零 fetch → 无 `confirmCloud` 改 cloud 得 409 且零出网 → 带 `confirmCloud` 启用 + reindex 后，所有 fetch 的 `host` 全等于受控 baseURL host、url 含 `/v1/embeddings`，无 telemetry/analytics/sentry/cdn 方向。

确定性层 + 本章 runbook 抓包层共同满足 AC-M5-5 / CI(e)。

---

## 2. search.db 损坏自愈（ADR-0049 / §4.9 Gap A）

### 2.1 触发与行为

检索读现役 search.db 时，若打开或查询命中物理损坏（`SQLITE_NOTADB` / `SQLITE_CORRUPT`，或 message 含 `malformed` / `file is not a database` / `disk image`），在**当次请求内**：

1. 关闭现役单例连接；
2. 把主库与**存在的** `-wal`/`-shm` 一起 rename 成 `search.db.corrupt-<unixms>`（**只隔离、绝不删除**，留证；同毫秒再损坏追加 `-2`/`-3` 不覆盖证据）；
3. 在原路径重开一个空、已自举 schema 的新库并成为单例；
4. 当次检索**不返回 500**：scope 实时收敛后，回退对**主库** title/searchText/主字段的**参数化** LIKE（复用 ADR-0005 有界语义，top20、limit≤50，无字符串拼接），响应 `mode:"like"`、`degraded` 含 `search_store_recovering`；
5. 后台 fire-and-forget 复用 reindex 的抽取/灌库真源把全部活实体重播进新库；cloud 期 embed 失败按 vecDebt 欠账、不阻塞 FTS 恢复。

**文件缺失不算损坏**：search.db 不存在是正常懒初始化，不产生 `.corrupt-*`。

### 2.2 现场判读

```bash
DATA=/var/lib/gouxiangdb
ls -lt "$DATA" | grep -E 'search\.db(\.corrupt-|-wal|-shm)?'
# 期望看到一组 search.db.corrupt-<ts>（主库，可能带 -wal/-shm）与新的 search.db。
```

- 应用日志：`[search] search.db 损坏已隔离至 .../search.db.corrupt-<ts>，当次回主库 LIKE 应急并重播`。
- 检索响应 `mode:"like"` + `degraded:["search_store_recovering"]` 只在「隔离后到后台重播完成」窗口出现；重播完成后自动回 `fts`/`hybrid` 且该标记消失。
- 主应用 records POST/PATCH、kb PUT content 全程不受影响（这些写只落主库 + outbox，不依赖 search.db）。

### 2.3 处置

1. **不要删 `.corrupt-*`**：它是事故证据。需要磁盘空间时先整体归档（主库 + 同名 -wal/-shm 成组）到异机，与 [wal-crash-recovery.md](./wal-crash-recovery.md) 同一纪律。
2. 看 status 确认重播结果：`GET /api/v1/admin/search/status`（role_owner），关注覆盖度 D（cloud 向量欠账）是否归零；未归零可手动 `POST /api/v1/admin/reindex` 或 `pnpm gx:reindex`（停机维护）补齐。
3. search.db 是**可重建派生产物，不进在线备份**（见 §5）；若损坏反复发生，排查磁盘/NFS/断电（§4.4），不要手改新库。

---

## 3. 降级跳变审计（Gap B）

- 仅在降级**状态发生跳变**（非降级↔降级，或 reason 集合变化）时，经统一 writeAudit 写**一条** `search_degraded` 系统事件；恢复本身不打「恢复」行，恢复后再次降级会再打一条。
- detail 只含技术态：`{ reasons: string[], mode: string, recovering: boolean }`，**严格不含**查询串 q、title、任何字段值、实体 key、向量、apiKey、Bearer。
- 该事件以系统身份记录（`actorId:null`、r 身份、GET），不是某个 admin 的写动作。
- 排障时：`grep '"event":"search_degraded"' $GX_AUDIT_DIR/audit.logl`；同态持续期间不应有重复行（采样限流）。

可能的 reason：`vec_unavailable`、`embedding_unhealthy`、`dim_mismatch`、`search_store_recovering` 等（queryTypes 真源）。

---

## 4. vec0 原生扩展 / musl / 部署位置

- 唯一原生供应链是 sqlite-vec 的 `vec0.<ext>`；运行时按 `GX_VEC_EXT_PATH`（运维覆盖，最高优先）→ 随产物的 `native/<triplet>/vec0.<ext>` 解析，文件名恒 `vec0`。
- `.so`/`.dylib` 缺失、dlopen/dlsym 失败、musl 无对应二进制：**不阻断启动**，search.db 不建/不查 `vec_chunks`，检索自动退化为 FTS+LIKE，status/审计标 `vec_unavailable`，主写不受影响。
- **禁止 alpine/musl 镜像**（vec0 无 musl 构建）；Docker 固定 node:22-bookworm（glibc）。详见 M5 plan §12。
- 加载失败排查：确认产物里 `native/<triplet>/` 存在且文件 0644/目录 0755、`file` 架构与机一致；或显式 `GX_VEC_EXT_PATH=/abs/vec0.so` 指定。
- **NFS**：search.db（WAL 模式）与主库一样必须落在本地可写磁盘（ext4 等），**不要放 NFS/网络盘/只读安装目录**（posix锁/WAL 语义不可靠，易诱发损坏）。

---

## 5. search.db 资产边界（ADR-0048）

- search.db 是同机**可重建派生产物**：内容由主库活实体经 outbox/indexer 或 reindex 随时重建；**不进**在线备份（`online-backup.mjs` 只备 `DATABASE_URL` 主库）。
- 被字段 mask 的文本作为派生行物理存在于 search.db，但按主体在 FTS MATCH / vec KNN **召回前**由 `field_grant` 收敛排除（非召回后过滤）。不做授权域分片、不做落盘加密；文件系统权限与主库同级，不因此引入新的越权面。
- 换机器/恢复主库后：search.db 无需恢复，启动后 reindex 或等 worker 自动重建即可。

---

## 6. Flag / 配置 / reindex / model 切换速查

| 变量/动作 | 默认 | 说明 |
|---|---|---|
| `GX_M5_SEARCH` | `off` | off=不挂 v1 search/不建 search.db（旧搜索字节不变）；shadow=新链路对拍旧端点只记日志；on=对外 |
| `GX_EMBEDDING_MODE` | `off`（on 后出厂） | off=纯 FTS/LIKE 零外网；cloud 必须 owner 显式配置 + `confirmCloud:true` |
| `GX_VEC_EXT_PATH` | 未设 | 运维覆盖 vec0 路径；未设则走随产物 native/ 目录 |
| `GX_SEARCH_DB_PATH` | `<dataDir>/search.db` | 一般不显式设；必须本地盘 |
| `GX_SEARCH_FIELD_CHUNK_CAP` | 内置默认 | 字段 chunk 截断阈值 N；调整后受影响记录需 reindex |
| `GX_EMBEDDING_BASE_URL` / `_MODEL` / `_API_KEY` / `_BATCH_SIZE` / `_TIMEOUT_MS` | 空 | cloud 契约配置；OpenAI 兼容 `/v1/embeddings` 单一契约；apiKey 建议走 rotate 端点加密存储 |

- **reindex**：`POST /api/v1/admin/reindex {type?,entityId?}`（role_owner），进行中再调 `409 REINDEX_IN_PROGRESS`；全量走 `<search.db>.rebuild-<ts>` 灌完后原子 rename，期间旧库持续服务、检索不 500。停机 CLI：`pnpm gx:reindex`。
- **model/dim 或 fieldChunkCap 变更两步走**：PATCH config 不自动重建（返回 `reindexRequired:true`），需 owner 再显式 reindex；新 model 首批 embed 维度与旧库不符会 `dim_mismatch` 并退 FTS+LIKE，直到重建完成。
- **积压/worker**：indexer worker（`SearchIndexer`）默认不在 API 进程自动启动（S5 纪律），派生由 reindex/接线的 outbox 处理推进；status 暴露 outbox backlog/dead，旧索引继续服务、主写不被阻。排障可在受控进程内实例化 worker 或停机跑 reindex 补齐。

相关手册：[wal-crash-recovery.md](./wal-crash-recovery.md)、[backup.md](./backup.md)、[restore.md](./restore.md)、[deploy.md](./deploy.md)、[m1-sidecar.md](./m1-sidecar.md)。

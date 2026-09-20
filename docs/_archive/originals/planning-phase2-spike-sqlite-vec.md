# Spike：sqlite-vec + 统一检索只读可行性报告（M5 定架构）

- 作者：spike-sqlite-vec（只读 Spike，未改动仓库任何代码；唯一写入文件即本文档）
- 日期：2026-09-14
- 实验目录（隔离，仓库外）：`/tmp/gx-vec-spike.70uqRs/`（脚本保留；灌数用的大 .db 已删）
- 被测栈：Node `v22.22.2`、npm `10.9.7`、宿主 `darwin arm64`（macOS 26.5.1，Apple M5 / 10 核 / 16GB，参考机非 NAS）
- 项目对齐版本（只读取证）：`apps/api/package.json` 中 `better-sqlite3 ^13.0.3`（实锁 13.0.3）、`prisma/@prisma/client ^5.22.0`（实锁 5.22.0）；当前**未依赖 sqlite-vec，M5 需新增**。
- 隔离装包：`better-sqlite3@13.0.3` + `sqlite-vec@0.1.9`；better-sqlite3 内建 **SQLite 3.53.4**（实测 `sqlite_version()`）。

---

## 0. 结论先行

**sqlite-vec 方案判定：【有条件可行】** —— 在本项目既定的 better-sqlite3@13 + 独立 `search.db` 架构上，vec0 加载、1536 维 KNN、与 Prisma 主库并存全部实测通过；10 万 chunk 的 KNN 延迟在开发机上余量充足，真正的约束在 **2C4G NAS 上的磁盘/内存带宽（1536 维全量暴力扫描）** 与 **跨架构 .so 打包/路径解析**，二者都有明确规避手段。采用，但需按下面硬事实落约束，并保留"加载失败/未配置即纯 FTS+LIKE"的降级为一等公民。

**决定 M5 设计的硬事实（均有实测，见对应小节）：**

1. **better-sqlite3@13 直接支持 `db.loadExtension()`，无需自编译、无需 `enableLoadExtension()`。** 实测 `typeof db.loadExtension === 'function'`、`db.enableLoadExtension === undefined`（13 已无此开关），`sqliteVec.load(db)` 直接成功，`SELECT vec_version()` = `v0.1.9`。（§1）
2. **better-sqlite3@13 把普通 JS `number`（含整数字面量）绑定为 SQL `REAL`，只有 `bigint` 绑定为 `INTEGER`。** sqlite-vec vec0 的 `rowid` 与所有 `integer` 辅助元数据列都严格要求 INTEGER，传 number 会报 `Only integers are allows for primary key` / `Expected integer ... received FLOAT`。**M5 写 vec0 的所有整数绑定必须用 `BigInt`**，否则整批事务回滚。（§2/§4）
3. **vec0 KNN 强制要求 `LIMIT` 或 `k = ?`**，否则报错 `A LIMIT or 'k = ?' constraint is required on vec0 knn queries`；检索为**暴力全表扫描（无 ANN）**，`EXPLAIN QUERY PLAN` = `SCAN v VIRTUAL TABLE ... USE TEMP B-TREE FOR ORDER BY`。100k×1536 在 M5 开发机 p95≈113ms、RSS≈86MB、库文件≈592MB；延迟随行数近线性。（§2/§7）
4. **Prisma 主库与裸 better-sqlite3 打开的独立 `search.db` 同进程互不干扰、物理文件独立、扩展连接级隔离。** search.db 可整文件删除重建；主库连接里 `vec_version()` 不存在（vec0 只加载在 search 连接）。（§4）
5. **sqlite-vec npm 包按 `os`/`cpu` 标准 optionalDependencies 拆 5 个平台子包，linux-x64 / linux-arm64 的 `.so` 齐全且仅依赖 glibc（x64 需 GLIBC≤2.14、arm64≤2.17），无 openssl/libstdc++/libm 依赖** —— Debian bookworm / 飞牛满足，node:22-bookworm 满足；但**动态链接 glibc，musl/Alpine 不兼容（无 musl 专版）**。入口符号按文件名推导（`sqlite3_vec0_init`），**分发时必须保留文件名 `vec0.so/.dylib/.dll`，改名即加载失败**。（§5，linux 仅静态检查未运行）

---

## 1. better-sqlite3@13 加载扩展机制

**结论：预编译的 better-sqlite3@13.0.3 即开启扩展加载，不需要 `-DSQLITE_ENABLE_LOAD_EXTENSION` 自定义编译，也没有 `enableLoadExtension()` 前置开关。** 内建 SQLite 3.53.4，FTS5/trigram 亦内置（§3）。

最小验证（脚本 `exp1-vec-knn.cjs` 节选）与真实输出：

```js
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const db = new Database(":memory:");
console.log(typeof db.loadExtension, typeof db.enableLoadExtension);
sqliteVec.load(db);                       // 内部即 db.loadExtension(getLoadablePath())
console.log(db.prepare("SELECT vec_version() v").get());
```

```
better-sqlite3 version: 13.0.3
typeof db.loadExtension = function
typeof db.enableLoadExtension = undefined
LOAD: sqliteVec.load(db) -> OK (enableLoadExtension 不需要)
vec_version() => { v: 'v0.1.9' }
```

加载失败是**可捕获异常**（不 crash 进程），这是 M5 启动降级的前提：

```js
try { db.loadExtension("/nonexistent/vec0.so"); }
catch (e) { /* e.code === 'SQLITE_ERROR'，应用据此标记 vecUnavailable，不退出 */ }
```
实测输出：`缺失扩展抛错(可捕获): SQLITE_ERROR`。

> 说明【文档+实测】：better-sqlite3 官方 API 中 `enableLoadExtension()` 仅在少数旧构建/特殊发行版需要；13.0.3 预编译包实测该方法为 `undefined` 且 `loadExtension` 默认可用。

---

## 2. sqlite-vec 可用性 + 1536 维 KNN（darwin/arm64 实测通过）

**结论：vec0 虚表加载、建表、插入、KNN 全部通过；目标向量距离 0 且排名第 1，近邻正确。**

原生扩展文件（`file` 命令）：

```
node_modules/sqlite-vec-darwin-arm64/vec0.dylib:
  Mach-O 64-bit dynamically linked shared library arm64   (161,896 B)
```
`sqliteVec.getLoadablePath()` 实际加载路径：
`/tmp/gx-vec-spike.70uqRs/node_modules/sqlite-vec-darwin-arm64/vec0.dylib`

关键脚本（`exp1-vec-knn.cjs`，N=1000 随机向量 + 1 条与查询完全相同的向量）：

```js
db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[1536])`);
// rowid 必须 BigInt（见硬事实 2）；向量以 little-endian Float32 BLOB 绑定
const insert = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
db.transaction(() => {
  for (let i=1;i<=1000;i++) insert.run(BigInt(i), randVec(i*7+1));
  insert.run(BigInt(1001), target);
})();
const rows = db.prepare(
  `SELECT rowid, distance FROM vec_items
    WHERE embedding MATCH ? ORDER BY distance LIMIT 5`).all(target);
```

真实输出：

```
inserted rows: 1001
KNN top5 (rowid, distance):
   1001 0.000000
   738 15.312654
   586 15.372852
   66  15.374261
   369 15.399912
ASSERT nearest rowid == 1001 -> PASS
```

**踩坑（必须写进 M5 实施注意）：**
- 整数主键/元数据列传普通 `number` → vec0 报 `Only integers are allows for primary key values ...`；传 `BigInt` 才成功。对照实测：`SELECT typeof(1)` 在 bsc@13 下绑定为 `real`，`SELECT typeof(13n)` 为 `integer`。
- 查询**必须带 `LIMIT`/`k=?`**，否则 `A LIMIT or 'k = ?' constraint is required`。
- 向量绑定为 `Buffer`（Float32Array 的底层字节）；bsc@13 对 Buffer 正确绑定为 BLOB（`typeof(?) = blob` 实测）。JSON 数组文本绑定在本版本 vec0 未走通，**统一用 BLOB**。

---

## 3. FTS5 trigram 复核（实测）

**结论：trigram 对中文/拉丁 ≥3 字符子串命中正确；2 字词命中 0，必须回退 LIKE。** better-sqlite3 内建 SQLite 3.53.4，FTS5 + trigram 直接可用，无需额外扩展。

脚本 `exp3-trigram.cjs`，建表 `USING fts5(title, body, tokenize='trigram')`，真实输出：

```
中文3字 '向量检索' 命中数 = 1 [ '项目周报' ]
中文3字 '可行性'   命中数 = 1 [ '项目周报' ]
中文2字 '权限'     命中数 = 0 []   <- 期望 0（短词需回退 LIKE）
中文2字 '检索'     命中数 = 0
拉丁3字 'vec'      命中数 = 2 [ '项目周报', 'Knowledge Base' ]
拉丁3字 'KNN'      命中数 = 1 [ 'Knowledge Base' ]
拉丁2字 'KN'       命中数 = 0      <- 期望 0
拉丁前缀 'sear*'   命中数 = 1 [ 'Knowledge Base' ]
LIKE '%权限%' 命中数 = 1           <- 短词回退 LIKE 对照
```

M5 含义：查询规划层对 CJK 按码点长度判定，`<3` 字（以及纯拉丁 `<3` 字符）不走 FTS5 MATCH，直接走现有 LIKE/contains；3 字及以上走 trigram。前缀匹配可用 `term*`。

---

## 4. 多库并存：Prisma 主库 + 独立 search.db（实测通过，关键架构）

**结论：同一进程内 PrismaClient（主库 `main.db`）与裸 better-sqlite3（独立 `search.db`，含 FTS5+vec0+index_meta）互不干扰、各自读写；search.db 是物理独立文件、可整文件删除重建；vec0 扩展是连接级的，不污染主库连接。**

脚本 `prisma-main/exp4-multi-db.cjs`（Prisma 5.22 + bsc 13.0.3 + sqlite-vec 0.1.9 同进程）。注意相对路径口径与项目 `apps/api/src/db/databaseFile.ts` 一致：`file:./main.db` 相对 `prisma/` 目录解析，真实主库落在 `prisma/main.db`。

真实输出：

```
main.db (Prisma) BusinessRecord count = 2
search.db FTS '向量检索' => [ { rowid: 1, title: '合同A' } ]
search.db vec KNN top => [ { rowid: 1, chunk_id: 1001, d: 0 }, { rowid: 2, chunk_id: 1002, d: 1.2889 } ]
index_meta => [ { k: 'vec_loaded', v: 'v0.1.9' } ]
物理文件: [ 'search.db=151552B' ]
main.db 表清单: [ 'BusinessRecord', 'sqlite_sequence' ]  -> 含 docs_vec? false
main.db 连接 vec_version: NOT loaded (连接级隔离)
```

本实验额外暴露两个 M5 必守点：
- `db.transaction(fn)` **返回的是函数，必须再调用** `db.transaction(fn)()` 才执行——Spike 中漏写 `()` 导致整段静默未执行，务必在 code review 清单中提示。
- vec0 的 **integer 辅助列 `chunk_id` 同样必须 `BigInt`**：传 number 报 `Expected integer for INTEGER metadata column chunk_id, received FLOAT`，且因其处于同一事务，连 FTS 插入一起回滚（这是本实验一度"三表皆空"的根因）。

truncate/重建语义：`fs.rmSync('search.db')` 后重新 `new Database` + 建表即得全新派生库，主库零影响（实测删除重建成功）。

---

## 5. 跨架构 / NAS 分发风险评估

### 5.1 包内平台原生文件齐全性（实测 `file`/`ls`）

sqlite-vec 0.1.9 主包**不含二进制**，通过 5 个 `optionalDependencies` 平台子包分发，主包 `index.cjs` 按 `process.platform/arch` 用 `require.resolve('sqlite-vec-<os>-<arch>/vec0.<ext>')` 取路径再 `db.loadExtension()`。全部下载后清单：

| 子包 | 文件 | 大小 | file 识别 |
|---|---|---|---|
| sqlite-vec-darwin-arm64 | vec0.dylib | 161,896 | Mach-O 64-bit arm64 |
| sqlite-vec-darwin-x64 | vec0.dylib | 127,632 | Mach-O 64-bit x86_64 |
| sqlite-vec-linux-arm64 | vec0.so | 156,520 | ELF 64-bit ARM aarch64, dynamically linked, not stripped |
| sqlite-vec-linux-x64 | vec0.so | 159,816 | ELF 64-bit x86-64, dynamically linked, not stripped |
| sqlite-vec-windows-x64 | vec0.dll | 289,280 | PE32+ DLL x86-64 |

- **linux-x64 与 linux-arm64 的 `.so` 齐全**，正是飞牛/Docker 目标双架构。
- 每个平台子包都声明了标准 `os`/`cpu`（如 `{"os":["linux"],"cpu":["arm64"]}`），**在目标架构环境 `pnpm/npm install` 会自动只取对应子包**——与项目现有 better-sqlite3 预编译取包机制同构，`build-fpk.mjs` 强制"Linux 目标架构机/buildx 目标平台内安装"的铁律对 sqlite-vec 同样生效，无需交叉编译。
- **缺口：无 32 位（armv7/x86）、无 musl 专版。**

### 5.2 链接依赖（objdump/strings 静态检查）【未在 linux 运行，仅静态检查】

```
linux-x64   NEEDED: libc.so.6 ; 版本需求最高 GLIBC_2.14（另含 2.2.5/2.3.4/2.4/2.7）
linux-arm64 NEEDED: libc.so.6, ld-linux-aarch64.so.1 ; 版本需求 GLIBC_2.17
（两者均无 libssl/libcrypto/libstdc++/libm/libdl 的 NEEDED）
```

- 依赖极干净：**只动态依赖 glibc**，C++/数学/OpenSSL 相关均静态内联。
- Debian bookworm（glibc 2.36）/ 飞牛 fnOS（Debian 系，glibc ≫2.17）/ `node:22-bookworm-slim`（项目 Docker runner）**均满足**；Prisma engine 已要求的 `openssl`/`libssl3` 与 vec0 无关。
- **Alpine/musl：不兼容**。这些 `.so` 是 glibc 动态链接，musl 环境加载会失败。项目 Docker 明确用 bookworm（非 alpine），安全；需在 runbook 写明"不得换 alpine 基础镜像"。
- 本机为 darwin，**未实际在 Linux 上 dlopen 这两个 .so**；上表为静态 ELF 检查 + 官方加载方式文档，结论（glibc 满足即可加载）建议 M5 在 x86 与 arm 飞牛机各做一次冒烟（加载 + `vec_version()` + 1 条 KNN），作为发版门。

### 5.3 fpk 打包与 loadExtension 路径解析（含实测的改名坑）

实测 `loadExtension` 的入口符号由**文件名**推导：文件叫 `vec0.dylib` 时找符号 `sqlite3_vec0_init`；把文件改名为 `myvec0.dylib` 再加载即报 `dlsym: sqlite3_myvec0_init: symbol not found`，用绝对路径加载原名文件则成功。

**规避建议：**
1. **文件名必须保持 `vec0.so/.dylib/.dll`**，不得重命名；按 target triple 放目录而非改名，如 `server/native/linux-x64/vec0.so`、`server/native/linux-arm64/vec0.so`。
2. esbuild 扁平产物（M0 S2）下 `require.resolve('sqlite-vec-<os>-<arch>/...')` 可能无法解析（node_modules 子包未必被打包/保留）。**M5 不要依赖运行时 require.resolve**，改为：
   - 在 `build-fpk.mjs` 与 Docker 构建中显式把对应平台 `vec0.so` 拷进白名单产物（参照现有拷 prisma engine/prebuilds 的做法），加一条与现有 better-sqlite3 同构的"架构自检：目标 `.so` 存在且 `file` 架构匹配"；
   - 运行时按 `process.platform/arch`（必要时判 libc）拼**绝对路径**，并允许 `GX_VEC_EXT_PATH` 显式覆盖。fpk 下基准目录取 `TRIM_APPDEST/server`（与 `deploy/fnos/gouxiangdb/cmd/main` 现有 `APP_DIR=${TRIM_APPDEST}/server` 口径一致），即 `${TRIM_APPDEST}/server/native/<triplet>/vec0.so`。
3. **运行用户可读性/权限**：`.so` 与 search.db 所在目录需对运行用户可读/可读写；fpk 安装回调里对 `native/` 给 0755、文件 0644/0755，search.db 放到可写数据目录（与 app.sock 同级或 `/data`），不要放进只读安装目录。
4. **无需 `--allow-extension` 之类的启动开关**：SQLite 扩展加载是连接 API，不是 Node 启动参数；唯一动作是运行期 `db.loadExtension(absPath)`。
5. **SELinux / 挂载**：飞牛/Debian 默认不强制 SELinux；若用户把数据目录放 NFS/网络盘，建议 search.db 放本地 ext4（mmap/锁更稳），主库本就建议本地。vec0 暴力扫描随机读较多（§7），NFS 会放大延迟——runbook 提示。
6. **失败即降级**：路径缺失 / 架构不符 / dlopen 失败，一律 catch 后置 `vecAvailable=false`，应用正常启动、检索退化为纯 FTS+LIKE（与 NAS 低端适配原则一致）。

---

## 6. 远端 Embedding 契约（不调真实网络，给契约）

### 6.1 OpenAI 兼容 `POST /v1/embeddings` 契约【文档】

请求（`Authorization: Bearer <KEY>`，`Content-Type: application/json`）：

```json
{
  "model": "text-embedding-3-small",
  "input": ["要向量化的文本一", "要向量化的文本二"],
  "encoding_format": "float"
}
```
- `input`：字符串或字符串数组（批量）；维度由**模型**决定（`text-embedding-3-small`=1536；`text-embedding-3-large`=3072；部分服务支持 `dimensions` 参数做 MRL 降维，需该端点支持，维度一旦用于建表即固定）。

响应：

```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.012, -0.034, "...共 model 维..."] },
    { "object": "embedding", "index": 1, "embedding": ["..."] }
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 17, "total_tokens": 17 }
}
```
- 消费要点：以 `data[].index` 对齐回输入顺序；取 `embedding`（number[]）转 Float32Array→BLOB；用 `usage.prompt_tokens` 做成本/限流观测；HTTP 非 2xx、`data` 缺失/维度不符即视为失败。
- **报告中不含任何真实 key。** key 仅存服务端 env/密文配置，绝不下发前端或 MCP。

### 6.2 M5 的开关形态（按最新裁决：仅远端，无本地模型）

ARCH-enterprise §7.2 原设计含 `local`（Xenova ONNX 本地模型）；按 NAS 低端适配最新裁决**取消本地推理**，开关收敛为 **`cloud` / `off` 两态**（默认 `off`）：

- `off`：不配置/不调用任何 embedding，不建/不写 vec0（或建了也不查），检索 = FTS5 trigram + 短词 LIKE。开箱即用、零外网、零 key。
- `cloud`：配置了 `baseURL + key + model` 且健康检查通过，才启用语义向量与混合检索；配置缺失/维度不一致/连续失败 → 自动回落 `off` 行为（纯 FTS+LIKE），不影响检索可用性。
- 配置建议（env 或管理员设置页，服务端持有）：`GX_EMBEDDING_MODE=off|cloud`、`GX_EMBEDDING_BASE_URL`、`GX_EMBEDDING_API_KEY`、`GX_EMBEDDING_MODEL`、`GX_EMBEDDING_DIM`（显式记录维度，建表/变更据此，**改 model 导致 dim 变化必须全量重建索引**）、可选 `GX_EMBEDDING_BATCH_SIZE`、`GX_EMBEDDING_TIMEOUT_MS`。

### 6.3 EmbeddingProvider 接口草案（TS 签名）

```ts
export type EmbeddingMode = "off" | "cloud";

export interface EmbeddingProvider {
  readonly mode: EmbeddingMode;
  readonly model: string;
  readonly dim: number;            // 与 vec0 float[dim] 严格一致；变更即触发重建
  readonly batchSize: number;      // 单次 /embeddings 最大文本数（按端点限额，默认如 64/128）
  /** 批量向量化；实现内部按 batchSize 切片、限流、超时、重试。返回与输入等长、同序 */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** 维度/鉴权/连通性探活；reindex 与管理页据此判定能否启用 cloud */
  health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }>;
}

/** off 态实现：embed 一律抛 EmbeddingDisabled（调用方不应进入向量路径），health=ok 但不可向量化 */
```
工程约束：单例；信号量限流（并发上限可配）；每次调用 `AbortController` 超时；指数退避重试（仅网络/5xx，4xx 不重试）；整批失败返回可识别错误，让 indexer worker 把 change_event 退回退避队列（复用 ARCH §7.1 的 10s/1m/10m/1h 退避），**绝不让单条 embedding 失败拖垮主写链路或启动**。

---

## 7. 10 万 chunk / P95<500ms 可行性

### 7.1 实测（合成随机向量，darwin/arm64，Apple M5/10 核/16GB，**非 NAS，标注机型**）

脚本 `exp7-perf.cjs`、`exp7b-100k.cjs`，确定性均匀随机 1536 维 float32，WAL 文件库，每轮计时前 warmup：

| 规模 | 全表 KNN(k=10) | 带 metadata 列过滤 KNN | 备注 |
|---|---|---|---|
| 10k | avg 7.6 / p50 7.6 / **p95 7.8 ms** | p95 113ms（首抖，稳态 ~8ms） | |
| 60k | avg 46.9 / p50 46.9 / **p95 48.5 ms** | avg 46.5 / p95 55.6 ms | |
| **100k** | avg 86.1 / p50 82.3 / **p95 112.9 / max 143 ms** | avg 73.9 / p95 78.4 ms | RSS≈86MB |

- 插入吞吐：~2.6–3.1 万行/秒（单事务批量，1536 维），10 万全量灌库 ~3.5s（开发机）。
- 存储：100k×1536 float32 原始 ≈ 614MB，vec0 库文件实测 **592MB**（60k 时 356MB）。
- `EXPLAIN QUERY PLAN`：`SCAN v VIRTUAL TABLE INDEX 0 ... + USE TEMP B-TREE FOR ORDER BY` —— **确认暴力 KNN，无 ANN 索引**；耗时随 N 近线性（10k→100k，行数 ×10、耗时 ×11）。
- 带 `WHERE acl_group=?` 的 metadata 过滤不增加成本（本就全表扫描，在扫描期过滤），但其语义是"过滤后集合内再取 top-k"，不是"先 top-k 再丢弃"。

### 7.2 定性判断（外推到 2C4G NAS）

- sqlite-vec 是**纯暴力距离计算**，成本 ≈ `行数 × 维度` 次 FMA + 全量向量的读入。100k×1536 在 M5（高单核性能/大缓存）p95 113ms。映射到典型 2C4G 低性能 NAS（弱 x86 小核 / ARM A55 级，单核算力约为其 1/3–1/5，且内存带宽低），**纯计算粗估 300–500ms 量级，贴 500ms 红线**；叠加 vec0 边扫边读、592MB 向量数据在 4GB 机上难常驻，磁盘随机读/页缓存抖动可能把 P95 顶过 500ms。**开发机数据不能直接判定 NAS 达标，必须在最低参考机实测（M5 发版门）。**
- 让 100k/500ms 更稳的杠杆（按性价比排序）：
  1. **降维**：远端选 512/768 维（支持 MRL 的模型用 `dimensions`，否则换模型），计算与存储近似线性下降到 1/3（100k×512 ≈ 205MB，更易进页缓存）。语义损失需小样召回评测确认。
  2. **候选集先收敛**：权限/空间/实体类型先把可见候选收敛（见 §8），多数用户的可见集合远小于全库 100k，对该子集 KNN 即显著降成本。
  3. **控制单库 chunk 规模与 k**：`k`（向量候选）取 50–100 而非数百；文档切块不要过碎；把热实体与冷归档分库/分区。
  4. **保证存储本地**（ext4，非 NFS）、WAL、足够页缓存；reindex/批量灌库错峰。
- 阈值沿用 ARCH §7.3：派生 chunk >50 万 或 内网目标机实测混合检索 P95 持续 >500ms → 立项评估 LanceDB（ANN），EmbeddingProvider/indexer 接口保持不变。

> 以上 100k 数据为 **darwin/arm64 M5 实测（N 与机型已标注）**；NAS 延迟为基于"暴力扫描、近线性、算力/带宽差异"的定性外推，**未在 2C4G NAS 运行，不宣称已达标**。

---

## 8. M5 架构建议（落地方案）

### 8.1 search.db 连接管理
- 新增 `SearchStore`（better-sqlite3 单例，**不经 Prisma**）打开 `${GX_DATA_DIR}/search.db`，与现有 `db.ts` Prisma 单例同进程并存（§4 已证无干扰）。
- 打开即设 `PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;`（与主库同口径）。search.db **不进业务备份主集**（可重建资产，runbook 标注"可弃、首启/触发 reindex 自动重建"）。
- 三表 rowid 三处对齐（沿用 ARCH §7.5）：`chunks`（关系元数据普通表）+ `fts_chunks`（fts5 trigram）+ `vec_chunks`（vec0）。写 vec0 的整数列（rowid、chunk_id、类型/分区等 integer metadata）**一律 BigInt 绑定**。

### 8.2 扩展加载时机与失败降级（绝不阻断启动）
- 在 SearchStore 初始化时 `try { db.loadExtension(resolveVecPath()) ; vecAvailable=true } catch { vecAvailable=false }`，记录一条 warn 与 `/readyz` 可观测状态，**不 throw、不退出**。
- 语义检索启用条件 = `vecAvailable && embedding.mode==='cloud' && (await health()).ok && dim 与建表一致`；任一不满足 → 查询规划自动走 **FTS5 trigram + 短词 LIKE**（与现状搜索能力持平）。运行期 embedding 连续失败/kill 同样降级（ARCH AC：kill embedding 后 fts-only 自动生效）。
- `resolveVecPath()`：优先 `GX_VEC_EXT_PATH`；否则按 `process.platform/arch`(+libc) 在 `${appDir}/native/<triplet>/vec0.<ext>` 拼绝对路径；**文件名恒为 vec0**。Docker 在目标架构 `pnpm install` 可直接用包内平台子包；fpk 由 `build-fpk.mjs` 显式拷入并做架构自检（§5.3）。

### 8.3 迁移 / 重建 job
- search.db 不走 Prisma migrations；由 SearchStore 启动时 `CREATE TABLE IF NOT EXISTS` + `index_meta` 记录 `schema_version / embedding_model / dim / indexed_at`。
- `POST /api/v1/admin/reindex`（权限管理员）幂等：置 rebuilding 标记 → truncate/重开三表（实测可整文件删重建，或事务内清表）→ 扫主库播种 outbox change_events → 同进程单例 worker 消化（抽文本→写 FTS→cloud.embed→写 vec；退避重放沿用 §7.1）。重建期间检索自动降级 LIKE；完成后翻标记。model/dim 变更必须走全量重建。

### 8.4 权限先收敛与 RRF 的位置（零泄漏）
- **顺序铁律：先在主库/sidecar 用 M4 权限引擎求"当前主体可见的实体/块候选集合"，再让 FTS 与 vec 各自只在该集合内召回，最后应用层 RRF 融合。绝不在融合之后才做权限过滤**（否则不可见项既可能泄漏到距离/片段，也会占满 top-k 导致可见结果被截断）。
- FTS 路：可见 rowid/实体 id 白名单下推（普通表 JOIN 或 `rowid IN (?)`），再 MATCH trigram（≥3 字）/ LIKE（<3 字）。
- vec 路：把可参与过滤的维度（实体类型、空间/分区、owner/group）建成 vec0 integer metadata 列并在 KNN 的 WHERE 下推（已实测 metadata 等值过滤可用且不加扫描成本）；任意可见集合用 `rowid IN (白名单)` 收敛——**vec0 KNN 对 `rowid IN (子查询/大列表)` 的确切行为本次未实测，列为 M5 首日验证项**；若不支持则改为两阶段（白名单对应的块行 → 仅对这些块算距离，或分组建 metadata 分区列）。
- 融合：两路各取 top-N（如 100），应用层 RRF `score = Σ 1/(60+rank)`，标题精确命中加性加权；返回前再断言所有结果 ∈ 可见集合（纵深防御，写"无权内容零泄漏"对抗用例，对应 M5 AC）。

### 8.5 待 M5 首日/发版门补验
1. x86_64 与 arm64 飞牛真机（或 buildx 目标平台容器）各跑：loadExtension + `vec_version()` + 建表 + 1 条 KNN（本次 linux 仅静态检查）。
2. 最低参考机（2C4G，ext4 本地盘）灌 100k 目标维度向量，量混合检索 P95 是否 <500ms；不达标先降维/收敛候选，再议阈值。
3. vec0 KNN 与 `rowid IN (可见白名单)` 的兼容性与性能。
4. `cloud` 模式小样中文召回评测（财务/制度/技术文档）与 off/cloud 切换、kill 降级正确性。

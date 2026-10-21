# v0.2.5-beta.2 离线编辑 / 断网双向同步 —— 可执行切片蓝图

> 2026-10-19 · 分支 feat/macos-desktop-d0 · HEAD e6c8724
> 本文是四路只读勘察（服务端契约 / 侧车数据层 / 前端挂点 / Yjs+授权）的综合施工蓝图。
> 铁律：厚内核薄壳（§20）；每一切片默认关闭、迁移只增可回滚、独立四门（vitest 收集数恒等 + 三包 tsc 0 + eslint 0 error + S0 golden）、开关打开态有专门测试。本机只跑定向命令，重活走 VM15。

## 0. 勘察结论一句话

- **服务端这一半（YN0–YN8）已经是闭环且在线写真实记账**：12 个 /v1/sync 端点齐全、结构/树注册表 + 记录硬分派、incoming 隔离区、resolve 五种裁决、baseSchemaVersion 结构依赖门都在。总门 GX_SYNC_SERVER fail-closed 默认关。
- **客户端这一半基本是零**：web 无任何 /v1/sync 调用；Rust 壳无 vault/同步引擎；现在"连远程"只是反代转发，本机不存副本，断网即不可用。
- 所以 beta.2 主战场 = **Mac 客户端这一半**，服务端只需增量补"协议握手"这一道防线，不动既有行为。

## 1. 关键事实（带证据）

### 服务端
- 探针 `GET /api/v1/sync/` 仅返 `{apiVersion,sync,phase:"YN8",serverVersion,auth}`，无协议版本/能力协商 —— `apps/api/src/routes/v1/sync/index.ts:46-59`。
- 写端点 `/push` `:189`、`/push/tree` `:256`；总门+鉴权在 `:33-42`；push 逐条裁决、永远 200，回执 status ∈ accepted/conflict/rejected/quarantined/dropped；每批上限 1000（`:151`）。
- 结构依赖门：record op 可带 `baseSchemaVersion`（`:223-232`），落后/超前都挂起（`domain/sync/push.ts:403-415`）；**旧客户端不带字段=不受门（additive）**。
- 注册表：结构 14 条 `structureRegistry.ts:582-597`、树 5 条 `navRegistry.ts:221-227`；未知 entityType/op 服务端明确 rejected=OP_UNSUPPORTED（`push.ts:989-997,1140-1146`），不静默。
- 版本钟三轨同居 sync_entity_versions（record / table_schema:<id> / workspace_tree:ws_default），seq 全局唯一取号口 `oplog.ts:121-126`。
- 在线写切面：`recordWrite.ts:391,466,551,603`、table/field/viewService、`routes/v1/nodes.ts`；三个切面 off 时第一行 return null（`oplog.ts:232` 等）。
- 已有四张服务端同步表（迁移 20261015122228）；**无 local_outbox/replica_state/id_map 客户端表**；全库无同步容量裁决。
- 轨道2 Yjs：doc 服务端完整（/ws/collab 票据鉴权、collab_docs 热写、docFlush 冷归结走统一写队列、与 oplog 物理隔离）；**canvas 无生产 flusher、前端零 Yjs 接入**。

### 侧车 / 数据层
- 内核一进程一 dataDir、全进程级单例（config 冻结 `config.ts:482`、Prisma 单例 `db.ts:26`、searchStore 单例）。→ 多副本**最小路线 = 一作用域一内核进程 + 一加密匣一个 GX_DATA_DIR，内核零改动**。
- 壳改：`SidecarManager.inner: Mutex<Option<Running>>`（`sidecar.rs:84`）Map 化；`Upstream::Replica{port}` 枚举与 http_base 已预留（`upstream.rs:32,41`）；端口/readyz/进程组原语可按实例复用。
- migrate 现"仅首 boot"（`sidecar.rs:436,472`）→ **须改为每次启动 spawn 前幂等 `migrate deploy`**（此刻内核未起，天然满足防 locked）。
- Keychain vault 已预留 service 常量 `secret.rs:32` `cc.gouxiang.desktop.vault`，KeychainStore 通用构造 `:86`、stdin 喂口令、urandom 随机串均可复用；**只需新增 ensure_vault_secret(scope)**。
- hdiutil 四原语（create/mount/detach/destroy）全部需新增（新 `vault.rs`，零 crate 依赖，照 PoC-4 脚本 docs/design/2026-10-node-mode/poc4-vault）。vaults/mounts/offline-attachments 三目录真机当前不存在。
- 生命周期：取口令→mount→以挂载点为 data_dir 构造 planner→start（migrate 已在 spawn 前）；停止逆序 stop→detach；失权=detach+secret.delete+删 sparsebundle。
- 客户端三表模型照设计 `DESIGN-OFFLINE-SYNC.md:333-394`；新迁移序号 > 20261015122228（现 42 枚）；模型插 `schema.prisma:977` 后、手写表禁区 `:979` 之前；列名 camelCase、@@map snake_case、不加物理外键。
- 本地 outbox 切面仿 `recordSyncOpTx`（`oplog.ts:227`，开关第一行 return）挂 recordWrite 四个 Tx 同事务；**新增"托管副本"开关（不复用 GX_SYNC_SERVER）**，仅当数据源指向被托管副本时把 no-op 换成 appendLocalOutboxTx。

### 前端
- 写出口高度集中，**三点切面即可，不需数十处埋点**：① `api/client.ts:304-340` apiFetch（识别离线/登记/错误码分支加在 :333-338）；② `api/hooks.ts:418-674` useGXMutations 写总线（覆盖 39 个调用方）+ 4 个同构旁路（kb-hooks、nav-hooks:117、useLibraryRename:24、useLayoutVersions:155）；③ `features/kb/useDocPersistence.ts:93-132`（已有失败落草稿的离线雏形，收编）。
- 离线权威副本走**同源 /api 落本机内核加密匣**，浏览器不自己加密存储；localStorage 仅留"未及发出"的崩溃草稿。
- 全局态：TanStack Query v5 + 仅两个 zustand store；新增 `store/sync.ts`（zustand 已在依赖，零新增）。
- 六态徽标直接改造现有 `OfflineBanner`（`components/states.tsx:330`，挂载点 `App.tsx:167` 不动）；同步中心入口接壳状态条 `node/ShellStatusDock.tsx:124-212`（仅壳内）/ 浏览器面挂 `WorkspaceTopBar.tsx:49-79`。
- 冲突 UI：记录级双栏需新建（Modal `ui.tsx:604` 为壳，字段 diff 料已齐 `client.ts:671-676`）；结构 compound/树冲突新建（布局底子 MoveImpactModal）；409 现状 ConflictNotice 两按钮无对比。
- **硬点**：记录 create 返回 id 被创建后立即消费（ViewRouter:191、Kanban:91 等），纯排队无法伪造服务端 id → 需前端临时 id + id_map 会合。
- shared-types 新增 `src/sync.ts`（仅 web+api 两消费方，改完双 typecheck）；图标自建 `components/icons.tsx`；gx token 源 packages/design-tokens。
- 帮助：help-api.ts:14-23 加 `cached?`，HelpCenterPage 成功分支加陈旧缓存条；离线缓存放服务端 dataDir（前端零新依赖、三端复用）。

## 2. 切片（每片默认关闭 / 独立四门 / 可回滚）

| 片 | 名称 | 内核(api) | 壳(rust) | 前端(web) | 闸门 |
|---|---|---|---|---|---|
| **S0** | 协议握手（脑裂防护，最先立） | 探针 additive 增 protocolVersion/min/max/capabilities；写端点组中间件 fail-closed（TOO_OLD/TOO_NEW，缺省=v1 旧行为）；新 `domain/sync/protocol.ts` 常量单源；读端点不拒 | — | client.ts 探针函数 + client.ts:333 错误码分支 + "需升级"态；shared-types/sync.ts | 新 yn9 测试；旧 yn* 不带版本号全绿（additive 锚点） |
| **S1** | 加密匣 PoC-4 闸门 | — | vault.rs 四原语 + secret.rs ensure_vault_secret + vaults/mounts 布局 + 退出 detach | — | **需戴总在场真机**（建匣/钥匙串授权）；PoC-4 REPORT 已证 Prisma/sqlite 对挂载点无感 |
| **S2** | 副本 DDL + outbox 切面 + 一作用域一内核 | 新迁移三表；configOfflineReplica 开关；recordWrite 同事务 appendLocalOutbox（默认 no-op）；结构/nav/doc 写原语同构切面 | SidecarManager Map 化 + ShellState 目录注册 + migrate 每次幂等 deploy + mount 后才启内核 | dataSourceResolver 识别副本作用域 | 迁移只增；开关 off 零行为；专门 on 测试 |
| **S3** | 客户端同步引擎 | 复用现有 snapshot/pull/push/incoming/resolve/visibility（无需新端点） | 副本内核起停/status + 切 Replica 上游 | 内核侧客户端引擎：subscribe→snapshot→pull 落副本；outbox→push 回放；临时 id + id_map 会合；游标/authzVersion | 端到端：在线写可离线读到、离线写回放成功 |
| **S4** | 同步中心 + 六态 + 失权擦除 | incoming/visibility 已备 | 失权 detach+销匣编排 | store/sync.ts；OfflineBanner 六态；同步中心抽屉（待同步数/冲突/隔离区/重试丢弃）；失权隔离保留不删 | 各态手测 + 失权不丢数据 |
| **S5** | YN6/YN7/YN8 客户端冲突弹窗 | resolve 五裁决已备 | — | 记录级双栏(mine/theirs/custom/replayData)；结构 compound；树冲突；服务端 reasonCode 全映射 | 三类冲突 headless/手测 |
| **S6** | YN9 富内容离线（doc + canvas，均要自动合并） | doc 轨道完整；**canvas 需补生产 room flusher（注册 registerRoomFlusher("canvas")，冷并回，照 docFlush 范式）**；两轨都补 403 denied 分流 + 在线 revoked 帧发送点 | — | doc：Y.encodeStateAsUpdate 存 localStorage 键族 gx-y:*（yjs 已在依赖，**零新包**，不引 y-indexeddb）+ 重连 step1 前灌入。**canvas：前端从零接 Yjs binding（建 canvas:<id> 会话、图元 ↔ Y 结构绑定，照 doc 的 blocksYjs/useCollabDoc 范式），再套同样的本地持久化与重放**；失权副本隔离 | doc 断网续写→字符级自动合；**canvas 断网作画→重连图元级自动合（单列专项验收）** |
| **S7** | 两个小尾巴 | 帮助：dataDir 缓存 wiki JSON+images，离线回缓存 cached:true；授权 L1：config GX_LICENSE_MODE 默认 off（可选只读接口 off→404） | 授权 L1：license/gate.rs 恒 Bypassed + gx:license_status 命令 | 帮助陈旧缓存条；授权前端**不调用不展示** | 帮助离线可读；授权 vitest 收集数不变/零阻断 |
| **S8** | 封版 | 四门 | VM15 重打 fpk；Mac dmg；tag v0.2.5-beta.2 prerelease（不传 update-manifest.json）；同步 main | 同 | **真机/钥匙串/封包须戴总在场** |

依赖：S0 独立最先；S1 与 S0 并行（内核/Rust 不撞文件）；S2 依赖 S1；S3 依赖 S2；S4/S5 依赖 S3 可并行前端；S6 独立于记录轨但共享 S4 状态；S7 随时可插入。

## 3. 戴总已拍板的范围决策（2026-10-19）

1. **画布离线 = 做真正的断网自动合并**（不满足于草稿兜底）。即 S6 必须把画布实时协同从无到有补齐（服务端 canvas flusher + 前端 canvas Yjs binding），再叠离线，与文档并列验收。这是本版最大增量，单独留足工时与专项验收。
2. **副本容量先不设硬上限**：beta.2 只显示本地占用，不做配额拦截/报错；§16.2 的 1GB/500MB 默认值不在本版启用。
3. **首次建加密匣 / 钥匙串授权 / 真机封包**必须戴总在场，约时间。
4. §16.2 其余产品默认值（冲突保留期、在线读远端权威、单节点单活等）施工触及时逐项确认。

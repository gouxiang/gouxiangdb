-- 批次 F 实时协同（docs/design/2026-09-collab/DESIGN.md §3.1）：协同态旁路表 collab_docs。
--
-- 它装什么：一个协同房间（roomId="<kind>:<objectId>"）当前这份 Y.Doc 的
-- Y.encodeStateAsUpdate 二进制。它是【热路径的唯一落点】——两档写（§2.3）里热路径
-- 每 500ms 防抖只写这一行，不碰 kb_docs / records、不 bump updatedAt、不跑 nav 对账、
-- 不发搜索 outbox；冷归结（阶段 2/3/4 才接主库）才把内容并回既有 domain 写事务。
--
-- 为什么必须单独一张表而不是扩 kb_docs 列：
--   1. 体积与写入频率不是一个量级。实测单字符增量 18B，一次编辑会话会刷几十次；
--      画布 500 图元 42KB。若挂在 kb_docs 行上，每次热写都要重写整行并进入
--      @updatedAt 与 nav 的派生链（§1.5：今天每次保存都跑一次全库 nav 对账）。
--   2. 生命周期不同：kb_docs 是业务实体（有软删、有版本历史、进备份与外链口径），
--      collab_docs 是可随时丢弃重建的协同暂存；混在一行会让"删文档"与"清协同态"
--      两种清理语义纠缠。
--   3. 三类内容共用同一张：文档/画布/数据表都是 "<kind>:<objectId>"，多态主键 + kind
--      判别列，照 share_links.objectType/objectId 的既有先例（不加 FK，应用层校验）。
--
-- base_version 为什么必须留：它是判断"房间空置期间这份内容是否被 HTTP PUT 改过"的
-- 唯一依据。缺失会让冷归结无条件覆写，把已推进的 contentVersion 那次改动静默吞掉
-- （§3.2，R4）。值取房间建立时的 kb_docs.contentVersion。
--
-- 实现纪律（照 20260913062000_record_field_index_sidecar 与 20260922010000_share_link_objects）：
--   1. schema.prisma 【不加 model】：本表是 raw-only 旁路表，完全由手写迁移 + 应用层
--      raw SQL（src/collab/store.ts）维护，避免 Prisma migrate 试图管理/漂移它。
--   2. 只新建本迁移自己的表与索引，不动任何既有表；存量数据零改动，零行为漂移。
--   3. 不加外键：room_id 多态引用（docId / tableId 等）无法用单个 REFERENCES 表达，
--      引用完整性由应用层在点查时校验（票据签发处走既有 requireDocAccess）。
--   4. 列名 camelCase（与 record_field_index 先例一致，应用层 raw SQL 直写列名）；
--      表名 snake_case（照 Prisma @@map 后的物理表名风格）。
--   5. DDL 部分无法加 WHERE 幂等（SQLite 无 CREATE TABLE IF NOT EXISTS 之外的条件过程
--      语句）：重复执行的保护来自 Prisma 的 _prisma_migrations 记录表
--      （migrate deploy 对已应用迁移整体跳过），与既有裸 DDL 迁移口径一致。
--   6. 方言声明（照 record_field_index 第 1 条）：本表 DDL 用了 SQLite 的 INTEGER 整型
--      主键语义与 BLOB 亲和类型，**不能直接平移到 PostgreSQL**——PG 通道（ADR-0008）
--      启用时需改写为 BYTEA + BIGINT / TIMESTAMPTZ。这是本表登记在案的平移关键点。
--   7. 回滚：prisma/docs/rollback/20260923010000_collab_docs.down.sql
--      （整表 DROP，数据为可重建暂存，回滚无业务损失）。
--
-- 二进制往返已实测闭环（设计文档 §3.1 记录）：Prisma raw × SQLite blob 全等
-- （含 0x00/0xFF 边界），42KB blob 完整往返，Uint8Array 直绑即可，不做 base64 编码。

-- ① 协同态主表。
CREATE TABLE "collab_docs" (
    "room_id"      TEXT PRIMARY KEY,   -- "<kind>:<objectId>"，三类内容共用
    "kind"         TEXT NOT NULL,      -- doc | canvas | table（多态判别列）
    "state"        BLOB NOT NULL,      -- Y.encodeStateAsUpdate(doc)，服务端不解析内容
    "seq"          INTEGER NOT NULL DEFAULT 0,  -- 每次写入 +1，排障与收敛判定的单调序号
    "base_version" INTEGER,            -- 房间建立时的 kb_docs.contentVersion；table 房间为 NULL
    "updated_at"   INTEGER NOT NULL    -- epoch ms（旁路表不借 Prisma @updatedAt，raw 直写）
);

-- ② 按类别扫最近更新（冷归结的兜底扫描、运维排查"哪些房间还活着"）。
CREATE INDEX "collab_docs_kind_updated" ON "collab_docs"("kind", "updated_at");

-- 工作区树副本游标（单例树，baseId=null）—— beta.2 S3b-3a：只增空表、零行为。
-- 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §4.2（树维度游标）。
--
-- 为什么不复用 replica_state：replica_state 按 (nodeId, remoteBaseId) 装【每个远端 base】的
-- 副本游标，而工作区树是 baseId=null 的单例资源、不属于任何 base，订阅/快照/游标按
-- (nodeId, scopeId) 维度记一行，故单独一张表。
--
-- 纯只增：不触碰任何既有表，不加 ALTER、不回填存量；本期应用层不写不读这张表一行，
-- 旧行为逐字节不变（下行树 pull 泵 #923 / S3b-3b 才接线读写）。
--
-- 列名一律 camelCase：`@@map(...)` 只改表名不改列名，Prisma 客户端按字段名（camelCase）
-- 拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报 P2022 column does not exist
-- （与 20261015122228_sync_server_foundation / 20261019120000_offline_client_ddl 同款纪律）。
--
-- 刻意不加物理外键：与离线三表一致，SQLite 的 REFERENCES 会让既有旧库在 deploy 时因外键
-- 约束校验失败；悬挂行由应用层在节点清理等处显式 deleteMany 清理。

CREATE TABLE "replica_tree_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT 'ws_default',
    "pullCursorSeq" BIGINT NOT NULL DEFAULT 0,
    "snapshotDone" BOOLEAN NOT NULL DEFAULT false,
    "treeVersion" TEXT NOT NULL DEFAULT '0',
    "authzVersion" TEXT,
    "lastPulledAt" DATETIME
);
CREATE UNIQUE INDEX "replica_tree_state_nodeId_scopeId_key" ON "replica_tree_state"("nodeId", "scopeId");

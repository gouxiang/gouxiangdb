-- 离线客户端（Mac 侧车本地 SQLite）三表 —— beta.2 S2a：只增空表、零行为。
-- 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §4.2.1 / §4.2.2 / §4.2.3。
--
-- 纯只增：不触碰任何既有表，不加 ALTER、不回填存量；本期应用层不写这些表一行，
-- 旧行为逐字节不变（后续切片才接入侧车写服务层）。
--
-- 列名一律 camelCase：`@@map(...)` 只改表名不改列名，Prisma 客户端按字段名（camelCase）
-- 拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报 P2022 column does not exist
-- （与 20261015122228_sync_server_foundation 同款纪律）。
--
-- 刻意不加物理外键：SQLite 的 REFERENCES 会让既有旧库在 deploy 时因外键约束校验失败；
-- 悬挂行由应用层在 base purge / 节点清理等处显式 deleteMany 清理（同服务端 sync_* 表）。

-- 1) 本地待推送操作（含纯本地 base 与远端副本）
CREATE TABLE "local_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientOpId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "baseId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "baseVersion" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "serverClientOpId" TEXT,
    "reasonCode" TEXT,
    "conflictPayload" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "local_outbox_clientOpId_key" ON "local_outbox"("clientOpId");
CREATE INDEX "local_outbox_nodeId_status_idx" ON "local_outbox"("nodeId", "status");
CREATE INDEX "local_outbox_baseId_entityType_entityId_idx" ON "local_outbox"("baseId", "entityType", "entityId");

-- 2) 每个远端 base 的副本与拉取游标
CREATE TABLE "replica_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "remoteBaseId" TEXT NOT NULL,
    "localBaseId" TEXT NOT NULL,
    "pullCursorSeq" BIGINT NOT NULL DEFAULT 0,
    "snapshotDone" BOOLEAN NOT NULL DEFAULT false,
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "lastPulledAt" DATETIME,
    "lastPushedAt" DATETIME,
    "authzVersion" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "replica_state_nodeId_remoteBaseId_key" ON "replica_state"("nodeId", "remoteBaseId");

-- 3) 远端主键 ↔ 本地主键映射（离线新建，兜底）
CREATE TABLE "sync_id_map" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "localEntityId" TEXT NOT NULL,
    "remoteEntityId" TEXT,
    "clientOpId" TEXT NOT NULL
);
CREATE UNIQUE INDEX "sync_id_map_clientOpId_key" ON "sync_id_map"("clientOpId");
CREATE UNIQUE INDEX "sync_id_map_nodeId_entityType_localEntityId_key" ON "sync_id_map"("nodeId", "entityType", "localEntityId");
CREATE INDEX "sync_id_map_remoteEntityId_idx" ON "sync_id_map"("remoteEntityId");

-- 离线优先 + 操作级双向同步（YN0 服务端地基）：四张只增同步表。
-- 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §4.1 / §11.2。
--
-- 纯只增：不触碰 records/fields/bases 等任何既有表，不加 ALTER、不回填存量；
-- GX_SYNC_SERVER 默认 off 时应用层不写这些表一行，旧行为逐字节不变。
--
-- 列名一律 camelCase：`@@map(...)` 只改表名不改列名，Prisma 客户端按字段名（camelCase）
-- 拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报 P2022 column does not exist
-- （与 record_changes / attachments 迁移同款纪律）。
--
-- 刻意不加物理外键：SQLite 的 REFERENCES 会让既有旧库在 deploy 时因外键约束校验失败；
-- 悬挂行由应用层在 base purge / 用户清理等处显式 deleteMany 清理（同 record_changes）。

-- 1) 服务端正向操作日志（增量 pull 的事实源）
CREATE TABLE "sync_op_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seq" BIGINT NOT NULL,
    "workspaceId" TEXT NOT NULL DEFAULT 'ws_default',
    "baseId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "actorId" TEXT,
    "clientId" TEXT NOT NULL,
    "clientOpId" TEXT NOT NULL,
    "baseVersion" BIGINT NOT NULL DEFAULT 0,
    "newVersion" BIGINT NOT NULL,
    "payload" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'accepted',
    "conflictOf" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "sync_op_log_clientOpId_key" ON "sync_op_log"("clientOpId");
CREATE INDEX "sync_op_log_seq_idx" ON "sync_op_log"("seq");
CREATE INDEX "sync_op_log_baseId_seq_idx" ON "sync_op_log"("baseId", "seq");
CREATE INDEX "sync_op_log_entityType_entityId_seq_idx" ON "sync_op_log"("entityType", "entityId", "seq");

-- 2) 每实体权威版本与墓碑（懒初始化，不回填）
CREATE TABLE "sync_entity_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL DEFAULT 'record',
    "baseId" TEXT,
    "version" BIGINT NOT NULL DEFAULT 0,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "sync_entity_versions_baseId_version_idx" ON "sync_entity_versions"("baseId", "version");

-- 3) push 进来但尚未终态的操作（冲突/隔离/挂起暂存）
CREATE TABLE "sync_incoming" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientOpId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL DEFAULT 'ws_default',
    "baseId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "baseVersion" BIGINT NOT NULL,
    "actorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "reasonCode" TEXT,
    "reasonDetail" TEXT,
    "serverVersion" BIGINT NOT NULL DEFAULT 0,
    "conflictServerPayload" TEXT,
    "reviewBaseId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "sync_incoming_clientOpId_key" ON "sync_incoming"("clientOpId");
CREATE INDEX "sync_incoming_status_baseId_idx" ON "sync_incoming"("status", "baseId");
CREATE INDEX "sync_incoming_actorId_status_idx" ON "sync_incoming"("actorId", "status");
CREATE INDEX "sync_incoming_baseId_entityType_entityId_idx" ON "sync_incoming"("baseId", "entityType", "entityId");

-- 4) 客户端订阅与拉取游标
CREATE TABLE "sync_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "actorId" TEXT,
    "cursorSeq" BIGINT NOT NULL DEFAULT 0,
    "snapshotDone" BOOLEAN NOT NULL DEFAULT false,
    "subscribedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPullAt" DATETIME
);
CREATE UNIQUE INDEX "sync_subscriptions_clientId_scopeType_scopeId_key" ON "sync_subscriptions"("clientId", "scopeType", "scopeId");
CREATE INDEX "sync_subscriptions_scopeType_scopeId_cursorSeq_idx" ON "sync_subscriptions"("scopeType", "scopeId", "cursorSeq");

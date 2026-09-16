-- M5/S1 迁移 #21：统一检索 outbox（主库 change_events）+ 手工 KV 配置表 app_settings。
--
-- 纪律（M5-implementation-plan §4.3/§5.1，只增不删，排在全部 M4 迁移之后）：
--   1. change_events 是主库 outbox：业务写事务内同库 INSERT（enqueueChangeEventTx），
--      由后续 S5 indexer worker 认领，驱动独立 search.db 派生索引。search.db 的
--      FTS5/vec0 DDL 是派生库自举语句，绝不进 Prisma migrations（否则 readiness
--      migrations 探针与 _prisma_migrations 对账 MISMATCH，§3-3）。
--   2. change_events 与实体表【不建 FK】：它是可重建的事件流，实体物理删后事件仍可
--      作为 delete 墓碑被 worker 消费；删除本表不影响任何旧功能（仅 M5 读）。
--   3. 幂等只增：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS，空库 deploy
--      与存量库重放都安全；不写 SQLite 专有函数，保 PostgreSQL 平移通道。
--   4. app_settings 本片只建表，不读不写（S4 cloud 凭据/配置加密落库，§4.4）。
--   5. 时间列沿用 DATETIME DEFAULT CURRENT_TIMESTAMP（同 M3 nav DDL 约定）。

-- ---------------------------------------------------------------------------
-- 1) change_events（检索变更事件 outbox）
--    status: pending|processing|done|failed|dead；op: upsert|delete
--    entityType: record|doc|canvas；workspaceId 单工作区恒 ws_default。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "change_events" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "entityType"  TEXT NOT NULL,
    "entityId"    TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL DEFAULT 'ws_default',
    -- BIGINT（非 INTEGER）：record 侧 version=Date.now() 毫秒（13 位，超 32 位 Int）。
    -- SQLite 中 BIGINT/INTEGER 存储等价（均动态 64 位整数），但 Prisma 原生引擎按列
    -- 声明类型名选反序列化 codec：BIGINT->i64(bigint)，INTEGER->i32(number)。列必须
    -- 与 schema 的 BigInt 对齐（prisma migrate 为 BigInt 模型在 SQLite 也生成 BIGINT）。
    "version"     BIGINT NOT NULL,
    "op"          TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    "workerId"    TEXT,
    "lastError"   TEXT,
    "nextRunAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- worker 认领热路径：按 status + nextRunAt 取最早待处理（§5.3 状态机）。
CREATE INDEX IF NOT EXISTS "change_events_status_next_run_idx"
    ON "change_events"("status", "nextRunAt");
-- 合并去重反查：同实体当前事件定位（enqueueChangeEventTx 的 UPDATE WHERE）。
CREATE INDEX IF NOT EXISTS "change_events_entity_idx"
    ON "change_events"("entityType", "entityId");

-- ---------------------------------------------------------------------------
-- 2) app_settings（手工 KV；S1 建表不读不写，S4 起存加密 embedding 配置）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "app_settings" (
    "k"         TEXT NOT NULL PRIMARY KEY,
    "v"         TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

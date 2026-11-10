-- 自研工作流引擎（需求 #1296）刀 A 地基三表 —— 台账 #1302：只增空表、零行为。
-- 三表分工：
--   workflow_defs      流程定义（DAG 图、触发器、版本号、启停状态）；
--   workflow_runs      流程运行实例（归属 defId、运行状态、输入/运行上下文、当前节点）；
--   workflow_approvals 运行中的人工审批节点（归属 runId、审批状态、审批人与意见）。
--
-- 纯只增：不触碰任何既有表，不加 ALTER、不回填存量；本刀不挂路由、不接 runtime，
-- 应用层不写不读这三张表一行，旧行为逐字节不变（刀 B 才接 DAG runtime / 节点执行器 / 路由）。
--
-- 列名一律 camelCase：`@@map(...)` 只改表名不改列名，Prisma 客户端按字段名（camelCase）
-- 拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报 P2022 column does not exist
-- （与 20261015122228_sync_server_foundation / 20261019120000_offline_client_ddl /
--  20261020120000_replica_tree_state 同款纪律）。
--
-- 刻意不加物理外键：与离线三表一致，SQLite 的 REFERENCES 会让既有旧库在 deploy 时因外键
-- 约束校验失败；悬挂行由应用层在定义删除 / 运行清理等处显式 deleteMany 清理。

-- 1) 流程定义
CREATE TABLE "workflow_defs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "triggerType" TEXT NOT NULL DEFAULT 'manual',
    "triggerConfig" TEXT NOT NULL DEFAULT '{}',
    "graph" TEXT NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "workflow_defs_status_idx" ON "workflow_defs"("status");

-- 2) 流程运行实例
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "defId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggerType" TEXT NOT NULL DEFAULT 'manual',
    "entityType" TEXT,
    "entityId" TEXT,
    "input" TEXT NOT NULL DEFAULT '{}',
    "context" TEXT NOT NULL DEFAULT '{}',
    "currentNodeId" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs"("status");
CREATE INDEX "workflow_runs_defId_idx" ON "workflow_runs"("defId");

-- 3) 人工审批节点
CREATE TABLE "workflow_approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approverId" TEXT,
    "comment" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "workflow_approvals_runId_idx" ON "workflow_approvals"("runId");
CREATE INDEX "workflow_approvals_status_idx" ON "workflow_approvals"("status");

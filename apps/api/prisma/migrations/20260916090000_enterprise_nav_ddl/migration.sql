-- M3/S1 迁移 A：统一导航资源树三表 DDL + workspaces 补 navVersion/menuVersion。
--
-- 纪律（M3-implementation-plan §4.1/§5.1/§7-S1，总监裁决 3/9）：
--   1. 只增不删：新建 nav_nodes/menu_items/auth_policies；workspaces 仅 ADD COLUMN
--      （常量默认 0，SQLite ALTER 友好），不改列类型不删列。
--   2. 普通 rowid 表、TEXT/INTEGER 标准类型；布尔 INTEGER 0/1；时间沿用 DATETIME。
--      不用 CTE、不在 SQL 内做 JSON 抽取，保 ADR-0008 PostgreSQL 平移通道。
--   3. nav_nodes 与六张实体表（bases/tables/views/knowledge_bases/kb_docs）【不建 FK】：
--      实体表无 workspaceId 且软删/物理删语义各表不一，引用完整性由同步原语
--      （domain/nav/sync.ts，S3）+ 对账脚本（S2/S4）应用层保证。
--   4. menu_items.nodeId 用真实 FK + ON DELETE RESTRICT（不用 ARCH 草案的 CASCADE）：
--      资源物理删不联动删菜单，强制“先清引用再删节点”的正确顺序，杜绝静默丢菜单；
--      软删不走数据库级联（引用保留待恢复）。menu_items 自引用 ON DELETE CASCADE。
--   5. auth_policies 本里程碑零写入零读取业务路径（M4 启用），本迁移只冻结结构。
--   6. 存量实体节点与默认菜单回填在紧随其后的 *_backfill 迁移（S2），本迁移不跑 DML。

-- ---------------------------------------------------------------------------
-- 1) workspaces 补两列（M2 只建了 policyVersion；常量默认 0，存量行即时回填）
-- ---------------------------------------------------------------------------
ALTER TABLE "workspaces" ADD COLUMN "navVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN "menuVersion" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2) nav_nodes（权威实体树：唯一父级 + 物化 path；kind 七类）
--    kind: base|kb|table|view|doc|canvas|group；group 的 resourceType/resourceId 为 NULL。
-- ---------------------------------------------------------------------------
CREATE TABLE "nav_nodes" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "workspaceId"     TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "parentId"        TEXT REFERENCES "nav_nodes"("id") ON DELETE RESTRICT,
    "kind"            TEXT NOT NULL,
    "resourceType"    TEXT,
    "resourceId"      TEXT,
    "name"            TEXT NOT NULL,
    "ord"             INTEGER NOT NULL DEFAULT 0,
    "path"            TEXT NOT NULL DEFAULT '',
    "depth"           INTEGER NOT NULL DEFAULT 0,
    "isSystem"        INTEGER NOT NULL DEFAULT 1,
    "config"          TEXT,
    "iconName"        TEXT,
    "inheritAncestors" INTEGER NOT NULL DEFAULT 1,
    "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       DATETIME,
    "deletedAt"       DATETIME
);
-- 一资源一权威挂载（group 三 NULL 不受此唯一约束：SQLite 中 NULL 互不相等，符合预期）。
CREATE UNIQUE INDEX "nav_nodes_workspace_resource_key"
    ON "nav_nodes"("workspaceId", "resourceType", "resourceId");
CREATE INDEX "nav_nodes_workspace_parent_idx" ON "nav_nodes"("workspaceId", "parentId");
CREATE INDEX "nav_nodes_workspace_kind_idx" ON "nav_nodes"("workspaceId", "kind");
CREATE INDEX "nav_nodes_resource_idx" ON "nav_nodes"("resourceType", "resourceId");
CREATE INDEX "nav_nodes_path_idx" ON "nav_nodes"("path");

-- ---------------------------------------------------------------------------
-- 3) menu_items（引用编排层：container|shortcut；浅树，容器嵌套应用层限 2 层）
--    shortcut.nodeId 不唯一（同一实体可多处挂载）；container.nodeId 为 NULL。
-- ---------------------------------------------------------------------------
CREATE TABLE "menu_items" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "workspaceId"  TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "parentId"     TEXT REFERENCES "menu_items"("id") ON DELETE CASCADE,
    "type"         TEXT NOT NULL,
    "nodeId"       TEXT REFERENCES "nav_nodes"("id") ON DELETE RESTRICT,
    "label"        TEXT,
    "iconName"     TEXT,
    "ord"          INTEGER NOT NULL DEFAULT 0,
    "brokenReason" TEXT,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    DATETIME,
    "deletedAt"    DATETIME
);
CREATE INDEX "menu_items_workspace_parent_idx" ON "menu_items"("workspaceId", "parentId");
CREATE INDEX "menu_items_node_idx" ON "menu_items"("nodeId");

-- ---------------------------------------------------------------------------
-- 4) auth_policies（M3 只冻结结构：全里程碑无写入/读取业务路径，M4 启用）
-- ---------------------------------------------------------------------------
CREATE TABLE "auth_policies" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "nodeId"      TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId"   TEXT NOT NULL,
    "actions"     TEXT NOT NULL DEFAULT 'r',
    "fieldMask"   TEXT,
    "conditions"  TEXT,
    "reason"      TEXT,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"   TEXT NOT NULL
);
CREATE UNIQUE INDEX "auth_policies_node_subject_key"
    ON "auth_policies"("nodeId", "subjectType", "subjectId");
CREATE INDEX "auth_policies_workspace_subject_idx"
    ON "auth_policies"("workspaceId", "subjectType", "subjectId");
CREATE INDEX "auth_policies_node_idx" ON "auth_policies"("nodeId");

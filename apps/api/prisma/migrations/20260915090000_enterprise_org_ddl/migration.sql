-- M2/S1 迁移 A：组织通讯录五表 + users 扩列（DDL + 系统角色幂等种子）。
--
-- 纪律（M2-implementation-plan §4.2/§4.3/§7-S1）：
--   1. 只增不删：新建 workspaces/departments/dept_members/roles/role_assignments 五表；
--      users 仅 ADD COLUMN（常量默认值，SQLite ALTER 友好），不改列类型不删列。
--   2. 普通 rowid 表、TEXT/INTEGER 标准类型；布尔 INTEGER 0/1；时间沿用 Prisma DateTime（TEXT）。
--      不用 WITHOUT ROWID / GLOB / CTE 递归，保 ADR-0008 的 PostgreSQL 平移通道。
--   3. users.workspaceId【只加列不建 FK】：SQLite ALTER ADD COLUMN 不能附带 REFERENCES；
--      引用完整性由应用层保证（同 M1 方言纪律，见计划 §11-11）。
--   4. 单工作区前提：工作区与五枚系统角色使用固定 id（ws_default / role_owner...），
--      多工作区为 Out-of-Scope，ADR/注释记录该前提（总监裁决 5）。
--   5. 一人一主部门由【部分唯一索引】保证（SQLite/PG 均支持 partial index）。
--   6. 本迁移只建结构 + 幂等系统种子；存量 users 回填与 owner 自举在紧随其后的
--      *_backfill 迁移内完成（拆分以避免单迁移又建表又回填长跑）。

-- ---------------------------------------------------------------------------
-- 1) workspaces（单工作区交付，policyVersion 供 M4 策略失效；nav/menu 版本列不建，YAGNI）
-- ---------------------------------------------------------------------------
CREATE TABLE "workspaces" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "name"          TEXT NOT NULL DEFAULT '默认工作区',
    "policyVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     DATETIME
);

-- ---------------------------------------------------------------------------
-- 2) departments（parentId 真相 + path 物化派生；软删 deletedAt）
-- ---------------------------------------------------------------------------
CREATE TABLE "departments" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "parentId"    TEXT REFERENCES "departments"("id") ON DELETE RESTRICT,
    "path"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "ord"         INTEGER NOT NULL DEFAULT 0,
    "status"      TEXT NOT NULL DEFAULT 'active',
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME,
    "deletedAt"   DATETIME
);
CREATE INDEX "departments_workspace_parent_idx" ON "departments"("workspaceId", "parentId");
CREATE INDEX "departments_path_idx" ON "departments"("path");

-- ---------------------------------------------------------------------------
-- 3) users 扩列（workspaceId 仅加列无 FK，应用层保引用；lastSeenAt 不建，YAGNI）
--    必须在 workspaces 建表之后执行；status/tokenVersion 带常量默认，存量行即时回填默认。
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "disabledAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "inviteTokenHash" TEXT;
ALTER TABLE "users" ADD COLUMN "invitedAt" DATETIME;
CREATE INDEX "users_workspace_idx" ON "users"("workspaceId");
CREATE INDEX "users_status_idx" ON "users"("status");

-- ---------------------------------------------------------------------------
-- 4) roles（组织管理角色；permissions 仅承载组织管理动作三枚，资源动作位不进此表）
-- ---------------------------------------------------------------------------
CREATE TABLE "roles" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "systemKey"   TEXT,
    "name"        TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isSystem"    INTEGER NOT NULL DEFAULT 0,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"   DATETIME
);
-- 同工作区角色名唯一；systemKey 唯一（自定义角色 systemKey=NULL，SQLite 多 NULL 不冲突）。
CREATE UNIQUE INDEX "roles_workspace_name_key" ON "roles"("workspaceId", "name");
CREATE UNIQUE INDEX "roles_workspace_system_key" ON "roles"("workspaceId", "systemKey");

-- ---------------------------------------------------------------------------
-- 5) dept_members（多对多 + isMain）
-- ---------------------------------------------------------------------------
CREATE TABLE "dept_members" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "departmentId" TEXT NOT NULL REFERENCES "departments"("id") ON DELETE RESTRICT,
    "userId"       TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "isMain"       INTEGER NOT NULL DEFAULT 0,
    "joinedAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "dept_members_dept_user_key" ON "dept_members"("departmentId", "userId");
CREATE INDEX "dept_members_user_idx" ON "dept_members"("userId");
-- 一人仅一个主部门（部分唯一索引；仅约束 isMain=1 的行，无主部门时不冲突）。
CREATE UNIQUE INDEX "dept_members_one_main_per_user"
    ON "dept_members"("userId") WHERE "isMain" = 1;

-- ---------------------------------------------------------------------------
-- 6) role_assignments（subject=user|dept；scope M2 恒 workspace/node 预留）
-- ---------------------------------------------------------------------------
CREATE TABLE "role_assignments" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "roleId"       TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
    "subjectType"  TEXT NOT NULL,
    "subjectId"    TEXT NOT NULL,
    "scopeType"    TEXT NOT NULL DEFAULT 'workspace',
    "scopeNodeId"  TEXT,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"    TEXT
);
-- 主体反查（effectiveOrgRoles 求值 / usersWithRole）。
CREATE INDEX "role_assignments_subject_idx" ON "role_assignments"("subjectType", "subjectId");
-- 业务唯一：同角色对同主体在同 scope 仅一行。scopeNodeId 在 M2 恒 NULL，
-- 而 SQLite 唯一索引把 NULL 视为互不相等，故用 COALESCE 归一 NULL，保证真去重。
CREATE UNIQUE INDEX "role_assignments_uniq"
    ON "role_assignments"("roleId", "subjectType", "subjectId", "scopeType", COALESCE("scopeNodeId", ''));

-- ---------------------------------------------------------------------------
-- 7) 幂等系统种子：默认工作区 + 五枚系统角色（仅 owner 持三枚 manage_* 动作）
-- ---------------------------------------------------------------------------
INSERT INTO "workspaces"("id", "name", "policyVersion")
SELECT 'ws_default', '默认工作区', 0
WHERE NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = 'ws_default');

-- 五枚系统角色：仅 owner 持三枚 manage_* 动作，其余四枚 permissions=[]
-- （它们是 M4 资源角色命名锚点，M2 不给管理面权力，见计划 §5-A）。逐行幂等。
INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions")
SELECT 'role_owner', 'ws_default', 'owner', '所有者', '工作区所有者，承担组织管理面全部动作', 1, '["manage_departments","manage_members","manage_roles"]'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_owner');

INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions")
SELECT 'role_creator', 'ws_default', 'creator', '创建者', 'M4 资源角色命名锚点，M2 无组织管理动作', 1, '[]'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_creator');

INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions")
SELECT 'role_editor', 'ws_default', 'editor', '编辑者', 'M4 资源角色命名锚点，M2 无组织管理动作', 1, '[]'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_editor');

INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions")
SELECT 'role_commenter', 'ws_default', 'commenter', '评论者', 'M4 资源角色命名锚点，M2 无组织管理动作', 1, '[]'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_commenter');

INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions")
SELECT 'role_viewer', 'ws_default', 'viewer', '阅读者', 'M4 资源角色命名锚点，M2 无组织管理动作', 1, '[]'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_viewer');

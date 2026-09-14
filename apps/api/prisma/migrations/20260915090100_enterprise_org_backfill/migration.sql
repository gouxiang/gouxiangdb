-- M2/S1 迁移 B：存量数据幂等回填（users 归属 + 首位用户 owner 自举）。
--
-- 全部语句幂等可重跑（UPDATE ... WHERE NULL / INSERT ... SELECT ... WHERE NOT EXISTS）。
-- 单实例用户量 <=500，秒级完成，无需独立回填脚本（与 M1 sidecar 百万回填场景不同）。
-- 依赖迁移 A 已建 ws_default、role_owner 与 users 新列。

-- 1) 存量用户归入默认工作区、置 ACTIVE、tokenVersion=0（列默认已是该值，此处双保险，
--    只回填仍为 NULL 的 workspaceId；status/tokenVersion 带 NOT NULL 默认不会为 NULL）。
UPDATE "users"
SET "workspaceId" = 'ws_default'
WHERE "workspaceId" IS NULL;

UPDATE "users"
SET "status" = 'ACTIVE'
WHERE "status" IS NULL OR "status" = '';

UPDATE "users"
SET "tokenVersion" = 0
WHERE "tokenVersion" IS NULL;

-- 2) owner 自举：取最早注册用户（createdAt 最小，并列取 id 最小）授予系统 owner，
--    workspace scope，createdBy='system-bootstrap'。仅当库中至少有一个用户、
--    且尚不存在任何 -> role_owner 的用户级授予时插入（幂等，重跑不重复）。
INSERT INTO "role_assignments"("id", "roleId", "subjectType", "subjectId", "scopeType", "scopeNodeId", "createdBy")
SELECT
    'ra_bootstrap_owner',
    'role_owner',
    'user',
    (SELECT "id" FROM "users" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1),
    'workspace',
    NULL,
    'system-bootstrap'
WHERE
    EXISTS (SELECT 1 FROM "users" LIMIT 1)
    AND NOT EXISTS (
        SELECT 1 FROM "role_assignments"
        WHERE "roleId" = 'role_owner' AND "subjectType" = 'user'
    );

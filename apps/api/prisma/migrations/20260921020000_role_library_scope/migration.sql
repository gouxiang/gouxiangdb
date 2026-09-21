-- 迁移 #28：权限核心模型（二）——「角色 × 库」的库权限段 + 允许分享两级开关。
--
-- 做什么：
--   ① 新建 role_library_scope 表，承载二维的库权限（角色 × 库 × 表 × 字段）。
--      每行 = 一个角色对一个库的一条视野授权：
--        canManage = 1 → 该角色在这个库里持管理权（改结构/改数据/开分享），【不含删库】；
--        visible   = 1 → 该角色能进这个库；只勾可见不做逐表设置 = 全部表只读；
--        config    → JSON：逐表增/删/改/查勾选 + 逐字段 仅可见/可编辑/隐藏。
--   ② bases / tables / knowledge_bases 各加 shareEnabled 列（库、表两级允许分享开关）。
--      两级都开才允许成员把数据/文档外发成链接；开这个开关的人必须对该库有管理权
--      （超级管理员、管理员除外，见 domain/authz/libraryPolicy.ts）。
--   ③ 给三枚权限预设建库权限落地吗？——不建。
--      超级管理员/管理员的全量视野是【硬编码推导】出来的（libraryPolicy.ts 见这两个角色即短路
--      返回全权），不需要行；写行反而会"配置出的全权"与"硬规则全权"打架，
--      改硬规则时还要记得同步改数据。受限成员零权限，同样不需要行（缺省即不可见）。
--      存量自定义角色的库权限需要管理员在角色编辑器里逐库勾选——本迁移不做猜测性放权。
--      唯一例外见 ④：超级管理员/管理员的【可见】是硬编码的，但【管理权 canManage】
--      只认表里的行，故每个库都要补两行台账，否则管理员进得去却什么都管不了。
--
-- 为什么不复用 auth_policies：那套表带着「导航资源授权引擎」的语义，而引擎总门
-- configAuthz.ts:17 AUTHZ_ENFORCE_READY=false，配进去的行只会被 shadow 层观测、永不拦截，
-- 正是计划要消灭的"配了不生效"的坑（apps/api/src/domain/authz/reconcile.ts 还把它当成 healthy
-- 校验对象）。新表不进任何既有权责链，读写只有 domain/authz/libraryPolicy.ts 一个出口。
--
-- 纪律（照 20260920220000_org_directory_actions）：
--   1. ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语法（SQLite），依赖 _prisma_migrations 只执行一次。
--   2. CREATE TABLE 一律 IF NOT EXISTS（重跑不炸）。
--   3. 建 index 也带 IF NOT EXISTS。
--   4. 只加列/只建新表，不删任何既有数据、不改既有行语义。
--   5. 回滚：prisma/docs/rollback/20260921020000_role_library_scope.down.sql。

-- ① 角色 × 库 的库权限段
CREATE TABLE IF NOT EXISTS "role_library_scope" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roleId" TEXT NOT NULL,
  "libraryKind" TEXT NOT NULL,          -- "base" | "kb"
  "libraryId" TEXT NOT NULL,            -- bases.id 或 knowledge_bases.id（多态列，不建 FK）
  "canManage" INTEGER NOT NULL DEFAULT 0,
  "visible" INTEGER NOT NULL DEFAULT 0,
  "config" TEXT NOT NULL DEFAULT '{"tables":{},"fields":{}}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 一个角色对一个库只允许一行（PUT 语义 upsert 依赖这条唯一）。
CREATE UNIQUE INDEX IF NOT EXISTS "role_library_scope_uniq"
  ON "role_library_scope"("roleId", "libraryKind", "libraryId");

-- ①a 按角色查（加载一个用户的有效角色集后批量取其全部库视野）。
CREATE INDEX IF NOT EXISTS "role_library_scope_role_idx"
  ON "role_library_scope"("roleId");

-- ①b 按库查（角色成员视图：这个库被哪些角色覆盖到）。
CREATE INDEX IF NOT EXISTS "role_library_scope_library_idx"
  ON "role_library_scope"("libraryKind", "libraryId");

-- ② 允许分享两级开关（库级 + 表级）
ALTER TABLE "bases" ADD COLUMN "shareEnabled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tables" ADD COLUMN "shareEnabled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "knowledge_bases" ADD COLUMN "shareEnabled" INTEGER NOT NULL DEFAULT 0;

-- ④ 存量库回填：给超级管理员、管理员补「角色 × 库」视野行（canManage=1 visible=1）。
--    理由与"取消库主"同源：库不再属于建它的人，改结构/改数据的管理权只来自这张表。
--    存量库建库时还没这张表，若不回填，升级后管理员进得去（硬编码）却什么都管不了
--    （canManage 无来源），等于把既有库一次性变成只读。故每个存量库各补两行。
--    幂等：WHERE NOT EXISTS 挡住重跑；id 由 kind+libraryId+roleId 拼成，稳定不重复。
--    只补超级管理员/管理员两行，不猜测任何自定义角色或受限成员的权限——那是管理员
--    在角色编辑器里逐库勾选的事，迁移不做放权。
INSERT INTO "role_library_scope"
  ("id","roleId","libraryKind","libraryId","canManage","visible","config","createdAt","updatedAt")
SELECT
  'rls_seed_' || l."libraryKind" || '_' || l."libraryId" || '_' || r."roleId",
  r."roleId", l."libraryKind", l."libraryId", 1, 1, '{"tables":{},"fields":{}}',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT 'base' AS "libraryKind", "id" AS "libraryId" FROM "bases"
  UNION ALL
  SELECT 'kb'   AS "libraryKind", "id" AS "libraryId" FROM "knowledge_bases"
) l
CROSS JOIN (
  SELECT 'role_owner' AS "roleId"   -- 超级管理员（迁移 #27 已就地把 role_owner 升为超级管理员）
  UNION ALL SELECT 'role_admin'     -- 管理员
) r
WHERE NOT EXISTS (
  SELECT 1 FROM "role_library_scope" s
  WHERE s."roleId" = r."roleId" AND s."libraryKind" = l."libraryKind" AND s."libraryId" = l."libraryId"
);

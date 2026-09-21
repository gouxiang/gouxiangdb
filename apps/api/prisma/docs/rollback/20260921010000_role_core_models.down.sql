-- 20260921010000_role_core_models 回滚脚本。
--
-- 定位（与正向迁移同纪律）：这份脚本只回退【本迁移写入的东西】，不重建被回退的状态。
-- 发布前快照仍是主路径；此处提供「原地反演」，供演练与紧急回退。
--
-- 顺序必须与正向相反：
--   ⑥ 删掉种子授予 -> ⑤b/⑤a 摘掉补发的细粒度动词 -> ④ 清 immutable ->
--   ③ 删两枚新预置角色（先清其上的授予，避免悬挂） -> ② role_owner 还原 ->
--   ① 删 immutable 列。
--
-- 5. immutable 列不可「原地删除」：SQLite 3.35+ 支持 ALTER TABLE DROP COLUMN，但 Prisma
--    自带引擎版本不一致时可能不支持。故最后一节给出两种写法：优先 DROP COLUMN，
--    不支持时改用「重建表」脚本（apps/web 不感知该列，drop 安全）。

-- ⑥ 移除本迁移补发的受限成员默认授予（只删 createdBy 标记为本迁移的行）
DELETE FROM "role_assignments"
WHERE "roleId" = 'role_restricted'
  AND "subjectType" = 'user'
  AND "createdBy" = 'migration-20260921010000';

-- ⑤b 摘掉补发的部门三枚（从数组尾部连续移除三次）
UPDATE "roles"
SET "permissions" = json_remove(json_remove(json_remove("permissions",
      '$[#-1]'), '$[#-1]'), '$[#-1]')
WHERE "id" NOT IN ('role_owner', 'role_admin', 'role_restricted')
  AND "permissions" LIKE '%"manage_departments"%'
  AND "permissions" LIKE '%"create_departments"%'
  AND "permissions" LIKE '%"edit_departments"%'
  AND "permissions" LIKE '%"delete_departments"%';

-- ⑤a 摘掉补发的角色四枚（从数组尾部连续移除四次）
UPDATE "roles"
SET "permissions" = json_remove(json_remove(json_remove(json_remove("permissions",
      '$[#-1]'), '$[#-1]'), '$[#-1]'), '$[#-1]')
WHERE "id" NOT IN ('role_owner', 'role_admin', 'role_restricted')
  AND "permissions" LIKE '%"manage_roles"%'
  AND "permissions" LIKE '%"create_roles"%'
  AND "permissions" LIKE '%"edit_roles"%'
  AND "permissions" LIKE '%"delete_roles"%'
  AND "permissions" LIKE '%"assign_role_members"%';

-- ④ immutable 全部归零
UPDATE "roles" SET "immutable" = 0;

-- ③ 删两枚新预置角色：先清其授予行（role_assignments 对 roles 有 FK ON DELETE CASCADE，
--    事务内先删子表更稳），再删策略里以它为 role 主体的行，最后删角色行。
DELETE FROM "role_assignments" WHERE "roleId" IN ('role_admin', 'role_restricted');
DELETE FROM "auth_policies" WHERE "subjectType" = 'role' AND "subjectId" IN ('role_admin', 'role_restricted');
DELETE FROM "roles" WHERE "id" IN ('role_admin', 'role_restricted');

-- ② role_owner 还原为旧 owner 语义（匹配【全十八枚】时才还原，避免误改手工改过的行）
UPDATE "roles"
SET "systemKey" = 'owner',
    "name" = '所有者',
    "description" = '工作区所有者，承担组织管理面全部动作',
    "immutable" = 0,
    "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users"]'
WHERE "id" = 'role_owner'
  AND "permissions" LIKE '%"create_roles"%';

-- ① 删列（SQLite 3.35+）
ALTER TABLE "roles" DROP COLUMN "immutable";

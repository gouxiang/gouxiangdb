-- 20260921020000_role_library_scope 回滚脚本。
--
-- 定位（与正向迁移同纪律）：只回退【本迁移写入的东西】。发布前快照仍是主路径，
-- 此处提供"原地反演"供演练与紧急回退。顺序与正向相反。
--
-- 语义提醒（不是技术问题，是数据问题）：本库权限段一旦投产，管理员会在角色编辑器里
-- 逐库勾出各角色的库权限。回滚意味着这些授权全部消失、所有人回到"只有超级管理员
-- 和管理员能进库"的状态。回滚前先确认这是可接受的结果，或者更好的选择是不回滚、
-- 而是把某个角色的 visible 临时置 1 修住紧急情况。

-- ② 先删三张实体表上的 shareEnabled 列（SQLite 3.35+ 支持 DROP COLUMN；
--    若部署自带的 Prisma 引擎不支持，改用 apps/api/prisma/schema.prisma 注释掉的重建表方案：
--    这三列都是纯开关、无索引依赖，drop 是安全的。）
ALTER TABLE "bases" DROP COLUMN "shareEnabled";
ALTER TABLE "tables" DROP COLUMN "shareEnabled";
ALTER TABLE "knowledge_bases" DROP COLUMN "shareEnabled";

-- ① 删索引再删表（IF EXISTS 保证幂等可重放）
DROP INDEX IF EXISTS "role_library_scope_library_idx";
DROP INDEX IF EXISTS "role_library_scope_role_idx";
DROP INDEX IF EXISTS "role_library_scope_uniq";
DROP TABLE IF EXISTS "role_library_scope";

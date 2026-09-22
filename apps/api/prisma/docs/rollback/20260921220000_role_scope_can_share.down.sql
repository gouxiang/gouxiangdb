-- 20260921220000_role_scope_can_share 回滚脚本。
--
-- 定位（与正向迁移同纪律）：只回退【本迁移写入的东西】。发布前快照仍是主路径，
-- 此处提供"原地反演"供演练与紧急回退。
--
-- 语义提醒（不是技术问题，是数据问题）：canShare 是一位纯授权开关、无索引依赖，
-- drop 是安全的。回滚后所有"只靠 canShare 拿到分享权、canManage=0"的角色会失去分享权，
-- canManage=1 的角色不受影响（判定是 canManage || canShare）。若这批人是靠前端
-- 「可分享」勾选项单独授权的，回滚等于把他们静默收权——回滚前先确认这是可接受的结果。
--
-- 注意：正向迁移是 ALTER TABLE ADD COLUMN，SQLite 3.35+ 才支持 DROP COLUMN。
-- 若部署自带的 Prisma 引擎不支持，改用重建表方案（本表无外键依赖，重建安全）。

ALTER TABLE "role_library_scope" DROP COLUMN "canShare";

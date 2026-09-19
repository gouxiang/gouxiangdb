-- 回滚演练用（非正式迁移）：撤销 20260919102128_entity_icon_ddl 的效果（DROP 六列）。
--
-- 前置：本回滚只删列。列内数据（用户自选的图标名/颜色）随列一起丢失且不可恢复，
--       回滚后全部实体回到「未自定义 → 前端默认图标 + 默认色」状态，属可接受降级。
--       执行前需确认已发布的前端不再发送 icon/iconColor（否则 PATCH 会因列不存在报 500），
--       建议顺序：先摘除前端写入 + 后端 schema 校验，再执行本文件。
--
-- 语法：本机 sqlite3 CLI 为 3.51.0（>= 3.35.0），支持 ALTER TABLE ... DROP COLUMN，
--       故直接逐列 DROP。Prisma 内置 SQLite 引擎同样 >= 3.35，可直接执行本文件。
--       若目标环境为 SQLite < 3.35（不支持 DROP COLUMN），改走「重建表」路径：
--         1) CREATE TABLE "x_new" AS SELECT <保留列清单> FROM "x";
--         2) DROP TABLE "x";  ALTER TABLE "x_new" RENAME TO "x";
--         3) 手工补回原表的索引/外键/触发器（本迁移涉及的四张表索引见 schema.prisma）。
--       注意：重建表路径会丢 FK 定义，四张表里 bases/tables/kb_docs 在外键关系中被引用，
--             生产环境优先用「发布前快照回滚」而非重建表。
--
-- 幂等：SQLite 的 DROP COLUMN 无 IF EXISTS 语法；列已不存在时重放会报错属预期。

ALTER TABLE "bases" DROP COLUMN "icon";
ALTER TABLE "knowledge_bases" DROP COLUMN "icon";
ALTER TABLE "tables" DROP COLUMN "icon";
ALTER TABLE "tables" DROP COLUMN "iconColor";
ALTER TABLE "kb_docs" DROP COLUMN "icon";
ALTER TABLE "kb_docs" DROP COLUMN "iconColor";

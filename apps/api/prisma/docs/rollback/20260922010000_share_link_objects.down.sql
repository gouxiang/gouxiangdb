-- 回滚：撤掉 share_links 的对象化扩列，回到"只有库级链接"的形态。
-- 仅回退本迁移效果（发布前快照为主路径）。
--
-- 前置条件：SQLite 3.35.0+ 才支持 ALTER TABLE DROP COLUMN（本项目自带的 Prisma 引擎与
-- better-sqlite3 均已高于该版本）。低于该版本请改用发布前快照恢复，不要手改表结构。
--
-- 影响面：回退后所有 objectType=table / kb_doc 的分享链接行会连同列一起消失，
-- 已发出的表级/视图级分享链接立即 404。若线上已有外部访问者在用，先通知再回退。
--
-- 顺序：先删索引（依赖列），再删列。

DROP INDEX IF EXISTS "share_links_object_type_object_id_idx";

ALTER TABLE "kb_docs" DROP COLUMN "shareCreatedBy";

ALTER TABLE "share_links" DROP COLUMN "createdBy";
ALTER TABLE "share_links" DROP COLUMN "mode";
ALTER TABLE "share_links" DROP COLUMN "viewId";
ALTER TABLE "share_links" DROP COLUMN "objectId";
ALTER TABLE "share_links" DROP COLUMN "objectType";

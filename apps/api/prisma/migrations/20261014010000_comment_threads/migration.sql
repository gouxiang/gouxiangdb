-- 记录评论增强：两级回复 / 附件引用 / @ 提及。纯只增，不重建表、不加外键约束。
--
-- 兼容性：
--   · 旧评论 parentId/replyToUserId 为 NULL，天然成为根评论；
--   · attachments/mentions 两 JSON 列默认 '[]'，旧评论恒为空数组；
--   · body 列保持 NOT NULL 不动（纯附件评论写空串），避免 SQLite 改列定义的表重建。
--
-- 列名一律 camelCase：`@@map("comments")` 只改表名不改列名，Prisma 客户端按
-- Prisma 字段名（camelCase）拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报
-- P2022 column does not exist（与 20261009010000_attachments 同款纪律）。

ALTER TABLE "comments" ADD COLUMN "parentId" TEXT;
ALTER TABLE "comments" ADD COLUMN "replyToUserId" TEXT;
ALTER TABLE "comments" ADD COLUMN "attachments" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "comments" ADD COLUMN "mentions" TEXT NOT NULL DEFAULT '[]';

-- 按根评论聚合回复（无 DB 外键，应用层级联删除）。
CREATE INDEX "comments_parentId_idx" ON "comments"("parentId");

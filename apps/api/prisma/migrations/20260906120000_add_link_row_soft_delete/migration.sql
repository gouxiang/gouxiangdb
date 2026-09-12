-- linkRow 软删：删除记录时只打标记，从回收站恢复记录时关联关系随之恢复
-- 列名保持与其它表一致（Prisma 默认不映射 JS 字段名，故直接用 deletedAt）
ALTER TABLE "link_rows" ADD COLUMN "deletedAt" DATETIME;

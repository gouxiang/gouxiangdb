-- R2 附件外置（ARCH-production.md §5.1）：服务端上传附件的元数据表。
-- 纯只增：不触碰 records / fields / bases 等任何既有表，也不回填存量 dataURL。
--
-- 列名一律 camelCase：`@@map("attachments")` 只改表名不改列名，Prisma 客户端按
-- Prisma 字段名（camelCase）拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报
-- P2022 column does not exist（本项目踩过的坑）。
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseId" TEXT NOT NULL,
    "tableId" TEXT,
    "fieldId" TEXT,
    "recordId" TEXT,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploaderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);

-- 按内容去重重查（同 base 内同 sha256 复用同一行）
CREATE INDEX "attachments_sha256_idx" ON "attachments"("sha256");

-- 按库列举 / 权限归属判定
CREATE INDEX "attachments_baseId_idx" ON "attachments"("baseId");

-- 按记录列举某行挂了哪些附件
CREATE INDEX "attachments_recordId_idx" ON "attachments"("recordId");

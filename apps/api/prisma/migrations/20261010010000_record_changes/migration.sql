-- 记录级变更历史（数据日志）：记录详情抽屉「查看日志」的数据源。
-- 纯只增：不触碰 records / fields / bases 等任何既有表，也不回填存量历史（存量无历史可言）。
--
-- 列名一律 camelCase：`@@map("record_changes")` 只改表名不改列名，Prisma 客户端按
-- Prisma 字段名（camelCase）拼 SQL，写成 snake_case 会静默通过 deploy、查询时才报
-- P2022 column does not exist（本项目踩过的坑）。
--
-- 刻意不加物理外键：SQLite 的 REFERENCES 会让既有旧库在 deploy 时因外键约束校验失败；
-- 悬挂行由应用层在 record purge / table purge 处显式 deleteMany 清理。
CREATE TABLE "record_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changes" TEXT NOT NULL
);

-- 主查询路径：按记录取变更历史，按时间倒序翻页（keyset 续点走 (changedAt, id) 复合键）
CREATE INDEX "record_changes_recordId_changedAt_idx" ON "record_changes"("recordId", "changedAt");

-- 清理/巡检路径：按表批量清理（purge table 时按 tableId 删）
CREATE INDEX "record_changes_tableId_changedAt_idx" ON "record_changes"("tableId", "changedAt");

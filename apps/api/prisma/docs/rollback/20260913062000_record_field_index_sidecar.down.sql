-- M1/S3 回滚脚本（【不】在 Prisma 主迁移链执行，仅供人工回退时手动跑）。
--
-- 对应正向迁移：20260913062000_record_field_index_sidecar/migration.sql
--
-- 安全性：record_field_index 是 records.fields JSON 的派生冗余（可随时由 S4
-- backfill-sidecar 脚本全量重建），删除它不丢任何源数据；records 上的复合索引
-- 删除后仅回退到原有单列索引 records_tableId_idx / records_createdAt_idx，
-- 查询正确性不变、仅默认列表热路径失去覆盖索引。
--
-- 回退后旧 release 不认识该表/索引，闲置无害。应用回滚步骤：
--   1) 停 API（确保无写入）；
--   2) 备份当前库；
--   3) DATABASE_URL=file:/path/to/app.db sqlite3 执行本文件，或用 better-sqlite3
--      逐句 exec；
--   4) 若要让 Prisma 迁移历史也回到 11 条（可选，仅在彻底放弃 S3 时做）：
--      DELETE FROM "_prisma_migrations"
--        WHERE migration_name='20260913062000_record_field_index_sidecar';
--    注意：正常「回滚旧 release 但保留再升级能力」时不要删 _prisma_migrations 行。

DROP INDEX IF EXISTS "records_table_live_created_id";
DROP INDEX IF EXISTS "rfi_table_record";
DROP INDEX IF EXISTS "rfi_table_field_text";
DROP INDEX IF EXISTS "rfi_table_field_num";
DROP INDEX IF EXISTS "rfi_record_field_ord_key";
DROP TABLE IF EXISTS "record_field_index";

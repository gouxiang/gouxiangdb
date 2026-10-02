-- 回滚：DROP 记录变更历史表与其索引。
-- 本表为纯增量新表（无物理外键、无其它表依赖它），整表删除不影响任何既有数据；
-- 存量 records.fields 完全不受影响（本次从未改写）。
DROP INDEX IF EXISTS "record_changes_tableId_changedAt_idx";
DROP INDEX IF EXISTS "record_changes_recordId_changedAt_idx";
DROP TABLE IF EXISTS "record_changes";

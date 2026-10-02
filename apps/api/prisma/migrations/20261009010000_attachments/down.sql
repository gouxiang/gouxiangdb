-- 回滚：DROP 附件表与其索引（本表为纯增量新表，无其它表依赖它，可安全整表删除）。
-- 存量 records.fields 里的 base64 dataURL 附件不受影响（本次从未改写）。
DROP INDEX IF EXISTS "attachments_recordId_idx";
DROP INDEX IF EXISTS "attachments_baseId_idx";
DROP INDEX IF EXISTS "attachments_sha256_idx";
DROP TABLE IF EXISTS "attachments";

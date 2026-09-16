-- M5/S1 回滚脚本（仅演练/紧急使用；主回滚路径是发布前数据库快照）。
--
-- 对应迁移：
--   20260917090000_m5_search_outbox_ddl    建 change_events + app_settings
--   20260917090100_m5_search_outbox_seed   活实体播种（数据落在 change_events）
--
-- 影响面：change_events 只被 M5 检索派生链路读（S5 worker）；app_settings 仅 S4 起存
-- embedding 配置。删除这两张表不影响 M1-M4 任何既有功能与旧 /api/search。
-- 派生库 search.db 独立文件，不在主库回滚范围（需要时删除该文件后 reindex 重建）。
-- 警告：回滚 S1 后，S2+ 若已写入 change_events 的消费状态会一并丢失；重新向上迁移
-- 时 20260917090100 会按活实体重新播种 pending 事件，索引可重建（可重建派生产物）。

DROP INDEX IF EXISTS "change_events_entity_idx";
DROP INDEX IF EXISTS "change_events_status_next_run_idx";
DROP TABLE IF EXISTS "change_events";
DROP TABLE IF EXISTS "app_settings";

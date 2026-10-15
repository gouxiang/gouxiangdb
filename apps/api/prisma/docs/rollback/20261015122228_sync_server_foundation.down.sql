-- 回滚：撤掉离线同步 YN0 服务端地基的四张 sync_* 表，回到"无同步面"形态。
-- 对应迁移：20261015122228_sync_server_foundation。
-- 仅回退本迁移效果（只增表，主数据 records/fields/bases/... 与本迁移无任何外键依赖）。
--
-- 影响面：这四张表只服务 /api/v1/sync/*（GX_SYNC_SERVER=on 时才挂载、才写入）。
--   - off（出厂默认）时应用从不写这些表，DROP 不影响任何现有功能；
--   - on 且已产生同步数据时，DROP 会丢失 oplog / 版本 / 暂存 / 订阅游标，
--     故【只在确认无同步数据、或明确要废弃同步能力时手动执行】。
--
-- 回滚前置：
--   1. 先把 GX_SYNC_SERVER 置 off 并重启/等路由刷新，确保没有在途 push/pull；
--   2. 停掉 API 进程（SIGTERM），避免回滚瞬间仍有同步写；
--   3. 需要留档先导出四张表。
--
-- 顺序：先删唯一/普通索引（随表 DROP 一并清，SQLite 下 DROP TABLE 自动级联删其索引），
-- 再删表；这里直接 DROP TABLE IF EXISTS 即可，索引随之删除。

DROP TABLE IF EXISTS "sync_subscriptions";
DROP TABLE IF EXISTS "sync_incoming";
DROP TABLE IF EXISTS "sync_entity_versions";
DROP TABLE IF EXISTS "sync_op_log";

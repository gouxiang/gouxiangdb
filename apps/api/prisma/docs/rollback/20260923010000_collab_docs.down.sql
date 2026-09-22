-- 回滚：撤掉协同态旁路表 collab_docs，回到"无任何协同持久化"的形态。
-- 对应迁移：20260923010000_collab_docs（DESIGN.md §3.1）。
-- 仅回退本迁移效果（发布前快照为主路径）。
--
-- 影响面：collab_docs 是【可重建暂存】——它只装协同房间的 Y.Doc 增量二进制，
-- 内容的真源始终是 kb_docs.content / records.fields。因此 DROP 本表**不丢业务数据**，
-- 只丢"尚未冷归结回主库的那一段协同编辑"。
--
-- 回滚前必须做的一步（否则真会丢东西）：
--   1. 停掉 API 进程（走 SIGTERM，让它跑完优雅关闭的 flushAllAndClose）；
--   2. 或手工确认此刻无在线协同房间（SELECT count(*) FROM collab_docs WHERE seq > 0）。
-- 未 flush 的房间在进程退出时也会落盘，所以"停进程"这一步本身就是保数据的动作。
--
-- 顺序：先删索引（依赖表），再删表。

DROP INDEX IF EXISTS "collab_docs_kind_updated";

DROP TABLE IF EXISTS "collab_docs";

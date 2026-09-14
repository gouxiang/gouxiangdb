-- M3/S1 迁移 A 演练用下迁脚本（非主回滚路径）。
--
-- 主回滚路径 = 发布前数据库快照恢复 + GX_ENTERPRISE_NAV=off 摘路由（见 M3 runbook，S11 归档）。
-- 本脚本仅供隔离环境演练：
--   1. SQLite 旧版本不支持 ALTER TABLE DROP COLUMN（3.35+ 虽支持但本项目不依赖），
--      workspaces.navVersion/menuVersion 两列无法干净下删，闲置无害（M3 版本列无消费者外键），
--      故本脚本只 DROP 三张新表，两列保留为死列并在此注明。
--   2. 必须在无任何连接持锁时执行；menu_items 对 nav_nodes 有 FK，先删 menu_items/auth_policies。
--
-- 演练：sqlite3 $DATABASE_URL < 本文件（文件: URL 先解析为真实路径）。

DROP TABLE IF EXISTS "menu_items";
DROP TABLE IF EXISTS "auth_policies";
DROP TABLE IF EXISTS "nav_nodes";

-- workspaces.navVersion / workspaces.menuVersion：保留不删（见上注），无代码读取时零行为影响。

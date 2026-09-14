-- M2/S1 组织通讯录回滚脚本（手工应急用，非 prisma migrate 回滚）。
-- 对应迁移：
--   20260915090000_enterprise_org_ddl
--   20260915090100_enterprise_org_backfill
--
-- 主回滚路径是【应用层 flag off】（GX_ENTERPRISE_ORG=off 摘 /api/v1 路由，S2 起生效）
-- 加发布前快照恢复，而不是执行本脚本。本脚本仅在需要把库结构退回 M2 之前时使用。
--
-- 重要限制（SQLite，同 M1 纪律）：
--   1. 旧版 SQLite 的 ALTER TABLE 不支持 DROP COLUMN（3.35 之前）。users 上新增的六列
--      （status/workspaceId/tokenVersion/disabledAt/inviteTokenHash/invitedAt）与两个索引
--      无法在此直接安全删除；列保留为【闲置无害】，旧代码不读不写它们。
--      若确需物理移除列，须走"建新表-拷数据-改名"的表重建流程（有停机/锁表成本，不推荐）。
--   2. 执行本脚本会删除全部组织数据（部门/多部门归属/组织角色/授予）与默认工作区。
--      资源层 members/kb_members/kb_doc_acls/分享表不受影响。
-- 执行前务必备份：sqlite3 app.db ".backup '/path/backup.db'"

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS "role_assignments";
DROP TABLE IF EXISTS "dept_members";
DROP TABLE IF EXISTS "roles";
DROP TABLE IF EXISTS "departments";
DROP TABLE IF EXISTS "workspaces";

-- users 新列上的索引（若存在）随表无关，单独删；列本身保留闲置（见上）。
DROP INDEX IF EXISTS "users_workspace_idx";
DROP INDEX IF EXISTS "users_status_idx";

PRAGMA foreign_keys=ON;

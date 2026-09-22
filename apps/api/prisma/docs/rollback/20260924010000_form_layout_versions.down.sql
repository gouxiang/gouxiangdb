-- 回滚：撤掉表单设计器布局版本表 form_layout_versions，回到"无布局历史"的形态。
-- 对应迁移：20260924010000_form_layout_versions。
-- 仅回退本迁移效果（发布前快照为主路径）。
--
-- 影响面：本表是【可重建派生历史】——它只装布局的历史快照，当前布局的真源始终是
-- views.config（ViewConfig.detailLayout）与各 tabs 字段的 tabsConfig。因此 DROP 本表
-- **不丢当前布局**，只丢"回退到某次历史布局"的能力。
--
-- 回滚前建议做的一步（不强制，但排障时会想要）：
--   1. 需要保留历史时先导出：SELECT view_id, version, label, snapshot, created_at
--      FROM form_layout_versions ORDER BY view_id, version;
--   2. 停掉 API 进程（走 SIGTERM），避免回滚瞬间仍有保存布局的写落到该表。
--
-- 代码侧联动：回滚后必须同时下线 src/domain/formLayoutVersion.ts 的读写、
-- src/routes/layoutVersions.ts 三个端点，以及 views.ts 里的 maybeAutoSnapshotLayoutTx
-- 调用点，否则运行时报 "no such table: form_layout_versions"。
--
-- 顺序：先删索引（依赖表），再删表。

DROP INDEX IF EXISTS "form_layout_versions_viewId_version_key";

DROP INDEX IF EXISTS "form_layout_versions_viewId_idx";

DROP TABLE IF EXISTS "form_layout_versions";

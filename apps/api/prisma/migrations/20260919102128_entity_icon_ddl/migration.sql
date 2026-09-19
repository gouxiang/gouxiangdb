-- 迁移 #25：五类实体（Base / KnowledgeBase / Table / KbDoc[doc|canvas]）自定义图标 + 图标颜色。
--
-- 用途：实体可持久化「图标名 icon + 图标颜色 iconColor」两列；未自定义（NULL）时由前端按
-- 实体类型渲染默认图标与默认色（Base #378ADD / KB #0F6E56 / Table / doc / canvas），
-- 故本迁移【一律给 NULL 默认，不落 DB 默认色】——已有数据的展示零变化。
--
-- 覆盖范围（表名取自 schema.prisma 的 @@map，均为 snake_case）：
--   bases          ← Base.icon                 （iconColor 已存在，迁移 0003 之前即有）
--   knowledge_bases← KnowledgeBase.icon        （iconColor 已存在）
--   tables         ← Table.icon + Table.iconColor  （两列均为新增）
--   kb_docs        ← KbDoc.icon + KbDoc.iconColor  （doc 与 canvas 共用此表，按 kind 区分）
--
-- 纪律：
--   1. 只加列，不改既有列、不删数据；全部 TEXT 且可空（NULL = 未自定义），无需回填 UPDATE。
--   2. 无 NOT NULL + 常量默认，因此存量行自动为 NULL，语义即「走默认」，与旧行为一致。
--   3. 不建索引：icon/iconColor 只随实体详情/列表整行读出，不存在按图标过滤的查询路径。
--   4. 不进 nav_nodes：nav 编排图标仍由 NAV_ICONS + menu 侧 iconName 决定，
--      syncNavFromEntitiesTx 语义不动（见 bases.ts base.rename 既有注释）。
--   5. 取值约束由应用层保证（shared-types ENTITY_ICONS 白名单 + /^#[0-9a-fA-F]{6}$/），
--      不写 CHECK 约束——SQLite ALTER TABLE ADD COLUMN 不支持带 CHECK 的可空列回补，
--      且白名单后续「只增不删」时需要改约束，代价高于应用层校验。
--   6. 幂等：本迁移由 prisma migrate deploy 按 _prisma_migrations 记录只执行一次；
--      手写 SQL 不做 IF NOT EXISTS（SQLite 的 ADD COLUMN 无该语法），重放会报错属预期。
--
-- down：prisma/docs/rollback/20260919102128_entity_icon_ddl.down.sql。

ALTER TABLE "bases" ADD COLUMN "icon" TEXT;
ALTER TABLE "knowledge_bases" ADD COLUMN "icon" TEXT;
ALTER TABLE "tables" ADD COLUMN "icon" TEXT;
ALTER TABLE "tables" ADD COLUMN "iconColor" TEXT;
ALTER TABLE "kb_docs" ADD COLUMN "icon" TEXT;
ALTER TABLE "kb_docs" ADD COLUMN "iconColor" TEXT;

-- 表单设计器布局版本表 form_layout_versions：每次保存布局自动快照 {layout, tabs} 全量 JSON。
--
-- 它装什么：一个视图（view_id）的详情页/表单布局历史。snapshot 列存信封 JSON
--   { version, layout, tabs }，其中 layout 是 ViewConfig.detailLayout 全量，
--   tabs 是 tabs 容器字段 id -> { cards, lazyTouched } 的映射（信封构造见
--   src/domain/formLayoutVersion.ts 的 buildSnapshotEnvelope）。
--   一条记录 = 一次可回退的布局状态；回退前由前端先 POST 一条手动版本做保护备份。
--
-- 为什么单独一张表而不是扩 views 列：
--   1. 基数不同：一个视图的版本是 1..N 且会淘汰（自动版本上限 50），挂在 views 行上
--      就得把整段历史塞进 config JSON，读写都要重写整行并进入 nav 派生链。
--   2. 生命周期不同：视图删了版本就该清掉；视图的 config 是"当前态"，版本是"历史态"，
--      混在一行会让"改布局"与"读历史"共用一把锁、共用一份 JSON。
--   3. 淘汰语义只对自动版本生效（label IS NULL），手动版本永不淘汰；独立表才能用
--      一条带 WHERE 的查询挑出可淘汰集合。
--
-- 实现纪律（照 20260923010000_collab_docs）：
--   1. 只新建本迁移自己的表与索引，不动任何既有表；存量数据零改动，零行为漂移。
--   2. 不加物理外键：view_id 是软引用（视图物理删时由应用层在 views.delete 的
--      purge 事务里 deleteMany 清理），与 collab_docs.room_id 的多态软引用口径一致。
--   3. 列名 camelCase（Prisma @@map 后的物理列名即 model 字段名）；表名 snake_case。
--   4. DDL 无法加条件幂等（SQLite 除 CREATE TABLE IF NOT EXISTS 外无过程语句）：
--      重复执行的保护来自 Prisma 的 _prisma_migrations 记录表（migrate deploy 对已应用
--      迁移整体跳过），与既有手写迁移口径一致。
--   5. 回滚：prisma/docs/rollback/20260924010000_form_layout_versions.down.sql
--      （先 DROP INDEX 再 DROP TABLE；整表为可重建派生历史，回滚不丢当前布局）。
--
-- 方言：DATETIME + TEXT + INTEGER 为 SQLite 亲和类型，平移到 PostgreSQL（ADR-0008）
-- 时需改写为 TIMESTAMPTZ / TEXT / INTEGER，并复核 @@unique 生成的两处索引名。

-- 列名必须保持 camelCase（与 schema.prisma 的 model 字段名逐字一致）：本项目
-- @@map 只映射表名，列名不加 @map，因此物理列名就是 model 字段名。
-- 参照同族的 20260906100000_add_knowledge_base 里 kb_doc_versions 的写法
-- （"docId" / "createdBy" / "createdAt" 均为驼峰）。

CREATE TABLE "form_layout_versions" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "viewId"     TEXT NOT NULL,
    "version"    INTEGER NOT NULL,
    "label"      TEXT,
    "snapshot"   TEXT NOT NULL,
    "createdBy"  TEXT NOT NULL,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "form_layout_versions_viewId_version_key" ON "form_layout_versions"("viewId","version");
CREATE INDEX "form_layout_versions_viewId_idx" ON "form_layout_versions"("viewId");

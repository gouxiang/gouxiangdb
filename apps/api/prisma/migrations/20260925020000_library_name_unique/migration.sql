-- 数据库名 / 知识库名全局唯一（活数据部分唯一索引）。
--
-- 应用层已在 bases.ts（建/改）与 kb/index.ts（建/改）的写事务内做 trim + 查重；
-- 本迁移加数据库级兜底，防止绕过应用层写入重名。
--
-- 为什么是【部分】唯一索引：软删（deletedAt 非空）的库不占名，其名字允许复用
-- （与应用层 deletedAt:null 的查重口径一致）。SQLite 支持带 WHERE 的部分索引。
--
-- ⚠️ 升级风险：老库若已存在同名【活】数据库/知识库，本迁移会创建失败。
-- 部署前必须先排查重名，重名活库需人工改名或删除后再升级；不提供自动改名脚本。

CREATE UNIQUE INDEX "bases_name_live_key" ON "bases"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "knowledge_bases_name_live_key" ON "knowledge_bases"("name") WHERE "deletedAt" IS NULL;

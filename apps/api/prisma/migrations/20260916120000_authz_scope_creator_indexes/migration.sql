-- M4/S4 visible-scope creator 兜底批量查询的只增索引。
--
-- 背景（计划 §4.7「索引需求：S1 核对/增补，EXPLAIN 留证无全表 SCAN」）：
--   scope 客体第 3 条物理 SQL 是 scopeCreators.ts 的 UNION ALL，按 "createdBy"=? 在
--   bases / knowledge_bases / kb_docs / tables 四表一次性取目标用户创建的活资源。
--   规模夹具（40 base / 400 table / 10000 nav 节点）EXPLAIN QUERY PLAN 实测：四表
--   createdBy 均无索引，计划为裸 SCAN（探针：SCAN bases），违反 S4 验收「EXPLAIN 无 SCAN」。
--
-- 只增纪律：
--   1. 仅 CREATE INDEX（IF NOT EXISTS 幂等，可重入）；不改列、不搬数据、不回填；
--   2. 不加 WHERE 部分索引谓词，保持与 PostgreSQL 通道的 DDL 可平移性（ADR-0004 同口径）；
--   3. kb_docs 同时承载 doc/canvas，UNION 中以 SELECT kind 区分，单 createdBy 索引即可；
--   4. 回滚：DROP INDEX "bases_createdBy_idx" 等四条（派生索引，删除零数据损失）。

CREATE INDEX IF NOT EXISTS "bases_createdBy_idx" ON "bases" ("createdBy");
CREATE INDEX IF NOT EXISTS "tables_createdBy_idx" ON "tables" ("createdBy");
CREATE INDEX IF NOT EXISTS "knowledge_bases_createdBy_idx" ON "knowledge_bases" ("createdBy");
CREATE INDEX IF NOT EXISTS "kb_docs_createdBy_idx" ON "kb_docs" ("createdBy");

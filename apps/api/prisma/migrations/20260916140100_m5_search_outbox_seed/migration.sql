-- M5/S1 迁移 #22：为存量活实体幂等播种 outbox（records 活行 + kb_docs 活行）。
--
-- 目的（§4.3/§5.1）：升级后空 search.db 首启即可由 worker 消化这些 upsert 事件
-- 自动建索引，不依赖管理员手工 reindex。纯 DML、集式 INSERT...SELECT，可重跑。
--
-- 纪律：
--   1. 只播活行（deletedAt IS NULL）；软删实体不入索引（对齐旧搜索手工过滤）。
--   2. 幂等：NOT EXISTS 按 (entityType,entityId) 判重——无论之前是本迁移播的、
--      还是接线后业务新写的事件，已存在即不重复插；确定性 id 仅用于同语句可追溯。
--   3. 不使用 SQLite 专有函数（保 PostgreSQL 平移通道，§3-3）：version 播种基线 0
--      （doc 用真实 contentVersion；record 运行时由 enqueue 写 updatedAt ms，
--      基线 0 之后任何编辑版本号都更大，单调不破）；时间默认走列 DEFAULT。
--   4. kb_docs.kind='canvas' -> entityType 'canvas'，其余 -> 'doc'。
--   5. 集式单语句即天然分批（无逐行绑定参数，不受参数上限约束）。

-- 1) 活记录 -> upsert 事件（id 前缀 cev_seed_rec_ 确定性）
INSERT INTO "change_events"
    ("id", "entityType", "entityId", "workspaceId", "version", "op", "status", "attempts")
SELECT 'cev_seed_rec_' || r."id", 'record', r."id", 'ws_default', 0, 'upsert', 'pending', 0
FROM "records" r
WHERE r."deletedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "change_events" e
      WHERE e."entityType" = 'record' AND e."entityId" = r."id"
  );

-- 2) 活文档/画布 -> upsert 事件（id 前缀 cev_seed_doc_ 确定性；version=contentVersion）
INSERT INTO "change_events"
    ("id", "entityType", "entityId", "workspaceId", "version", "op", "status", "attempts")
SELECT 'cev_seed_doc_' || d."id",
       CASE WHEN d."kind" = 'canvas' THEN 'canvas' ELSE 'doc' END,
       d."id", 'ws_default', d."contentVersion", 'upsert', 'pending', 0
FROM "kb_docs" d
WHERE d."deletedAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "change_events" e
      WHERE e."entityType" IN ('doc', 'canvas') AND e."entityId" = d."id"
  );

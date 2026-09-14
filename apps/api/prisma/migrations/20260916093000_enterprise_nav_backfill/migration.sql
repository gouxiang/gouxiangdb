-- M3/S2 迁移 B：实体节点与默认菜单幂等回填（纯 DML，全部 WHERE NOT EXISTS 防重）。
--
-- 纪律（M3-implementation-plan §5.2/§5.3，裁决 3/4）：
--   1. 只回填【活】实体：bases/kb_docs/knowledge_bases deletedAt IS NULL；views.order>=0
--      （table 软删时视图被置 order=-1 隐藏，见 tables.ts 软删）。
--   2. 节点六类 base/kb/table/view/doc/canvas；不建 field/记录/group 节点（group 无存量）。
--   3. 幂等：确定性 id（nav_<kind>_<rid> / menu_*）+ NOT EXISTS 按业务键判重，
--      手工重跑本文件行数零增长（migrate deploy 对已应用迁移本来就会跳过）。
--   4. 无 CTE、无递归、无 SQL 内 JSON 抽取；排序用相关子查询计数（兼容老 SQLite 与 PG）。
--   5. path：仅根节点（base/kb）在此给 '/<id>/'；非根 path/depth 留默认（''/0），
--      由部署后必跑的 scripts/nav/reconcile-nav.ts --apply（tsx 运行）的 rebuildPaths 全量重算
--      （派生数据，计划 §5.2-6 方案 i；doc 父在第 6 步才改挂，迁移内无法一次拼对）。
--   6. 默认菜单：每活 base 一个容器挂全部活 table shortcut；每活 kb 一个容器挂根级活 doc
--      （kb_docs.parentId IS NULL）+ 全部活 canvas shortcut；不生成 view shortcut，子文档不挂
--      （裁决 4：文档层级走 nav_nodes 子树，不在菜单层复刻）。
-- 单工作区固定 'ws_default'。

-- ===========================================================================
-- 一、实体节点
-- ===========================================================================

-- 1) base 根节点（ord 按 createdAt,id asc）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","path","depth","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_base_'||b."id", 'ws_default', NULL, 'base', 'base', b."id", b."name",
  (SELECT count(*) FROM "bases" b2 WHERE b2."deletedAt" IS NULL
     AND (b2."createdAt" < b."createdAt" OR (b2."createdAt" = b."createdAt" AND b2."id" < b."id"))),
  '/'||'nav_base_'||b."id"||'/', 1, 1, 1, b."createdAt", b."createdAt"
FROM "bases" b
WHERE b."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='base' AND n."resourceId"=b."id");

-- 2) kb 根节点（一级序：base 先 kb 后，常量偏移=活 base 数）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","path","depth","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_kb_'||k."id", 'ws_default', NULL, 'kb', 'kb', k."id", k."name",
  (SELECT count(*) FROM "bases" WHERE "deletedAt" IS NULL)
    + (SELECT count(*) FROM "knowledge_bases" k2 WHERE k2."deletedAt" IS NULL
         AND (k2."createdAt" < k."createdAt" OR (k2."createdAt" = k."createdAt" AND k2."id" < k."id"))),
  '/'||'nav_kb_'||k."id"||'/', 1, 1, 1, k."createdAt", k."createdAt"
FROM "knowledge_bases" k
WHERE k."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='kb' AND n."resourceId"=k."id");

-- 3) table 节点（父=同 base 的 base 节点；ord 同 base 内 createdAt,id asc）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_table_'||t."id", 'ws_default', nb."id", 'table', 'table', t."id", t."name",
  (SELECT count(*) FROM "tables" t2 WHERE t2."deletedAt" IS NULL AND t2."baseId"=t."baseId"
     AND (t2."createdAt" < t."createdAt" OR (t2."createdAt" = t."createdAt" AND t2."id" < t."id"))),
  1, 1, t."createdAt", t."createdAt"
FROM "tables" t
JOIN "nav_nodes" nb ON nb."resourceType"='base' AND nb."resourceId"=t."baseId" AND nb."deletedAt" IS NULL
WHERE t."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='table' AND n."resourceId"=t."id");

-- 4) view 节点（order>=0；父=同 table 的 table 节点；ord=views.order；path 待脚本重建）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_view_'||v."id", 'ws_default', nt."id", 'view', 'view', v."id", v."name", v."order",
  1, 1, v."createdAt", v."createdAt"
FROM "views" v
JOIN "tables" t ON t."id"=v."tableId" AND t."deletedAt" IS NULL
JOIN "nav_nodes" nt ON nt."resourceType"='table' AND nt."resourceId"=v."tableId" AND nt."deletedAt" IS NULL
WHERE v."order" >= 0
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='view' AND n."resourceId"=v."id");

-- 5a) doc 节点（先统一挂 kb 节点；第 6 步按 kb_docs.parentId 改挂活父 doc 节点）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_doc_'||d."id", 'ws_default', nk."id", 'doc', 'doc', d."id", d."title",
  (SELECT count(*) FROM "kb_docs" d2 WHERE d2."deletedAt" IS NULL AND d2."kbId"=d."kbId"
     AND (d2."updatedAt" > d."updatedAt" OR (d2."updatedAt" = d."updatedAt" AND d2."id" < d."id"))),
  1, 1, d."createdAt", d."updatedAt"
FROM "kb_docs" d
JOIN "nav_nodes" nk ON nk."resourceType"='kb' AND nk."resourceId"=d."kbId" AND nk."deletedAt" IS NULL
WHERE d."deletedAt" IS NULL AND d."kind"='doc'
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='doc' AND n."resourceId"=d."id");

-- 5b) canvas 节点（恒挂 kb 节点；ord 同 kb 内 updatedAt desc，与 doc 共用同一序空间）
INSERT INTO "nav_nodes"
  ("id","workspaceId","parentId","kind","resourceType","resourceId","name","ord","isSystem","inheritAncestors","createdAt","updatedAt")
SELECT 'nav_canvas_'||d."id", 'ws_default', nk."id", 'canvas', 'canvas', d."id", d."title",
  (SELECT count(*) FROM "kb_docs" d2 WHERE d2."deletedAt" IS NULL AND d2."kbId"=d."kbId"
     AND (d2."updatedAt" > d."updatedAt" OR (d2."updatedAt" = d."updatedAt" AND d2."id" < d."id"))),
  1, 1, d."createdAt", d."updatedAt"
FROM "kb_docs" d
JOIN "nav_nodes" nk ON nk."resourceType"='kb' AND nk."resourceId"=d."kbId" AND nk."deletedAt" IS NULL
WHERE d."deletedAt" IS NULL AND d."kind"='canvas'
  AND NOT EXISTS (SELECT 1 FROM "nav_nodes" n
                  WHERE n."workspaceId"='ws_default' AND n."resourceType"='canvas' AND n."resourceId"=d."id");

-- 6) doc 父二次映射：父文档活且其节点存在时，从 kb 节点改挂父 doc 节点（镜像 kb_docs.parentId）。
--    改挂后的 path/depth 由 reconcile --apply 重建；本迁移不做递归拼 path（方言纪律）。
UPDATE "nav_nodes" AS n
SET "parentId" = (
  SELECT p."id"
  FROM "kb_docs" c
  JOIN "kb_docs" pd ON pd."id"=c."parentId" AND pd."deletedAt" IS NULL AND pd."kind"='doc'
  JOIN "nav_nodes" p ON p."resourceType"='doc' AND p."resourceId"=pd."id" AND p."deletedAt" IS NULL
  WHERE c."id"=n."resourceId" AND n."resourceType"='doc'
)
WHERE n."kind"='doc' AND n."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "kb_docs" c
    JOIN "kb_docs" pd ON pd."id"=c."parentId" AND pd."deletedAt" IS NULL AND pd."kind"='doc'
    JOIN "nav_nodes" p ON p."resourceType"='doc' AND p."resourceId"=pd."id" AND p."deletedAt" IS NULL
    WHERE c."id"=n."resourceId"
  );

-- ===========================================================================
-- 二、默认菜单（零入口丢失：每活 table / 根级活 doc / 活 canvas 至少一条 shortcut）
-- ===========================================================================

-- 7) base 一级容器（label=base 名快照，icon database）
INSERT INTO "menu_items" ("id","workspaceId","parentId","type","nodeId","label","iconName","ord","createdAt","updatedAt")
SELECT 'menu_base_'||b."id", 'ws_default', NULL, 'container', 'nav_base_'||b."id", b."name", 'database',
  (SELECT count(*) FROM "bases" b2 WHERE b2."deletedAt" IS NULL
     AND (b2."createdAt" < b."createdAt" OR (b2."createdAt" = b."createdAt" AND b2."id" < b."id"))),
  b."createdAt", b."createdAt"
FROM "bases" b
WHERE b."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "menu_items" m WHERE m."id"='menu_base_'||b."id");

-- 8) kb 一级容器（label=kb 名快照，icon book；ord 接在 base 容器之后）
INSERT INTO "menu_items" ("id","workspaceId","parentId","type","nodeId","label","iconName","ord","createdAt","updatedAt")
SELECT 'menu_kb_'||k."id", 'ws_default', NULL, 'container', 'nav_kb_'||k."id", k."name", 'book',
  (SELECT count(*) FROM "bases" WHERE "deletedAt" IS NULL)
    + (SELECT count(*) FROM "knowledge_bases" k2 WHERE k2."deletedAt" IS NULL
         AND (k2."createdAt" < k."createdAt" OR (k2."createdAt" = k."createdAt" AND k2."id" < k."id"))),
  k."createdAt", k."createdAt"
FROM "knowledge_bases" k
WHERE k."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "menu_items" m WHERE m."id"='menu_kb_'||k."id");

-- 9) table shortcut（挂同名 base 容器；label/iconName NULL=展示回落实体真名与类型图标）
INSERT INTO "menu_items" ("id","workspaceId","parentId","type","nodeId","ord","createdAt","updatedAt")
SELECT 'menu_table_'||t."id", 'ws_default', 'menu_base_'||t."baseId", 'shortcut', 'nav_table_'||t."id",
  (SELECT count(*) FROM "tables" t2 WHERE t2."deletedAt" IS NULL AND t2."baseId"=t."baseId"
     AND (t2."createdAt" < t."createdAt" OR (t2."createdAt" = t."createdAt" AND t2."id" < t."id"))),
  t."createdAt", t."createdAt"
FROM "tables" t
JOIN "bases" b ON b."id"=t."baseId" AND b."deletedAt" IS NULL
WHERE t."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "menu_items" m
                  WHERE m."workspaceId"='ws_default' AND m."type"='shortcut' AND m."nodeId"='nav_table_'||t."id");

-- 10) 根级 doc shortcut（kb_docs.parentId IS NULL 的活 doc）
INSERT INTO "menu_items" ("id","workspaceId","parentId","type","nodeId","ord","createdAt","updatedAt")
SELECT 'menu_doc_'||d."id", 'ws_default', 'menu_kb_'||d."kbId", 'shortcut', 'nav_doc_'||d."id",
  (SELECT count(*) FROM "kb_docs" d2 WHERE d2."deletedAt" IS NULL AND d2."kbId"=d."kbId"
     AND (d2."updatedAt" > d."updatedAt" OR (d2."updatedAt" = d."updatedAt" AND d2."id" < d."id"))),
  d."createdAt", d."updatedAt"
FROM "kb_docs" d
JOIN "knowledge_bases" k ON k."id"=d."kbId" AND k."deletedAt" IS NULL
WHERE d."deletedAt" IS NULL AND d."kind"='doc' AND d."parentId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "menu_items" m
                  WHERE m."workspaceId"='ws_default' AND m."type"='shortcut' AND m."nodeId"='nav_doc_'||d."id");

-- 11) 全部活 canvas shortcut（恒顶级）
INSERT INTO "menu_items" ("id","workspaceId","parentId","type","nodeId","ord","createdAt","updatedAt")
SELECT 'menu_canvas_'||d."id", 'ws_default', 'menu_kb_'||d."kbId", 'shortcut', 'nav_canvas_'||d."id",
  (SELECT count(*) FROM "kb_docs" d2 WHERE d2."deletedAt" IS NULL AND d2."kbId"=d."kbId"
     AND (d2."updatedAt" > d."updatedAt" OR (d2."updatedAt" = d."updatedAt" AND d2."id" < d."id"))),
  d."createdAt", d."updatedAt"
FROM "kb_docs" d
JOIN "knowledge_bases" k ON k."id"=d."kbId" AND k."deletedAt" IS NULL
WHERE d."deletedAt" IS NULL AND d."kind"='canvas'
  AND NOT EXISTS (SELECT 1 FROM "menu_items" m
                  WHERE m."workspaceId"='ws_default' AND m."type"='shortcut' AND m."nodeId"='nav_canvas_'||d."id");

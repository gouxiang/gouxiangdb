-- shareEnabled 按存量分享状态回填（幂等，可重跑）。
--
-- 历史数据里建过分享链接但库/表的 shareEnabled 开关可能仍为 0（开关是后加的），
-- 导致「实际存在有效分享、开关却显示关闭」的不一致。按现有分享痕迹把开关置 1：
--   bases          —— share_links 中存在该 base 的链接（baseId 物理列）
--   knowledge_bases —— kb_docs 中存在 shareToken 非空的文档（kbId 物理列）
--   tables         —— share_links 中 objectType='table' 且 objectId 指向该表
-- 只置 1、不置 0（是否仍有有效链接由各自分享逻辑判定，回填不关闭任何开关）。
-- 物理列名照 schema.prisma：share_links(baseId/objectType/objectId)、kb_docs(kbId/shareToken)。

UPDATE "bases"
SET "shareEnabled" = 1
WHERE EXISTS (SELECT 1 FROM "share_links" s WHERE s."baseId" = "bases"."id");

UPDATE "knowledge_bases"
SET "shareEnabled" = 1
WHERE "id" IN (SELECT DISTINCT "kbId" FROM "kb_docs" WHERE "shareToken" IS NOT NULL);

UPDATE "tables"
SET "shareEnabled" = 1
WHERE "id" IN (
    SELECT DISTINCT "objectId"
    FROM "share_links"
    WHERE "objectType" = 'table' AND "objectId" IS NOT NULL
);

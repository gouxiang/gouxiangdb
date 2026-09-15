-- M4/S2 迁移 C：旧三表（members / kb_members / kb_doc_acls）-> auth_policies 幂等回填。
--
-- 权威规则（M4-implementation-plan §5.2；动作串与 packages/shared-types/src/authz.ts
-- resourceActionsForLegacyRole 逐字一致，由 backfill-literals.test.ts 交叉断言防漂移）：
--   1. 活行投影：base/knowledge_base/kb_doc deletedAt IS NULL，且对应 nav 节点存在且活
--      （M3 reconcile A/B=0 是本迁移前置门）；用户被物理删除时旧行经 FK cascade 已不存在，
--      status=DISABLED 的用户行【保留投影】（行仍在，停用由 tokenVersion/status 鉴权层拦）。
--   2. members 活行 -> base 节点 user 策略（五档，reason 'legacy:member'）。
--   3. kb_members 活行 -> kb【容器】节点【一行】（四档，reason 'legacy:kb_member'），
--      doc/canvas 不逐行物化（裁决 A-1：经 inheritAncestors 继承，省逐 doc 膨胀）。
--   4. kb_doc_acls 活行 -> 该 kb_doc 对应 nav 节点（doc/canvas 均覆盖，PUT /docs/:id/acl
--      不区分 kind，旧 requireDocAccess 对 canvas 同样读 acl）user 行（三档，reason 'legacy:acl'）。
--   5. owner 行【不】写 role_assignments（裁决 A-2：资源 owner 不等于工作区管理员），
--      只在本资源持 manage_share（base owner 另持 manage_schema）。
--   6. 只产 subjectType='user' 行；不产生任何 inheritAncestors=0 节点（继承开关 M3 恒 1）。
--   7. 幂等：确定性 id（pol_legacy_<src>_<oldrow.id>）+ 按唯一键 (nodeId,'user',subjectId)
--      NOT EXISTS；重跑零行增长。role 不在已知档位白名单内的行不投影（对账报 A3）。
--   8. createdBy 固定 'legacy-backfill'，单工作区 'ws_default'。
-- 动作串为 normalizeActions 后的字典序逗号串（见 §4.1 表）。

-- 1) members -> base 节点
INSERT INTO "auth_policies"
  ("id","workspaceId","nodeId","subjectType","subjectId","actions","reason","createdAt","createdBy")
SELECT 'pol_legacy_member_'||m."id", 'ws_default', nb."id", 'user', m."userId",
  CASE m."role"
    WHEN 'owner'     THEN 'c,comment,d,manage_schema,manage_share,r,u'
    WHEN 'creator'   THEN 'c,comment,d,manage_schema,r,u'
    WHEN 'editor'    THEN 'c,comment,d,r,u'
    WHEN 'commenter' THEN 'comment,r'
    WHEN 'viewer'    THEN 'r'
  END,
  'legacy:member', CURRENT_TIMESTAMP, 'legacy-backfill'
FROM "members" m
JOIN "bases" b       ON b."id"=m."baseId" AND b."deletedAt" IS NULL
JOIN "nav_nodes" nb ON nb."workspaceId"='ws_default' AND nb."resourceType"='base'
                       AND nb."resourceId"=b."id" AND nb."deletedAt" IS NULL
WHERE m."role" IN ('owner','creator','editor','commenter','viewer')
  AND NOT EXISTS (
    SELECT 1 FROM "auth_policies" p
    WHERE p."nodeId"=nb."id" AND p."subjectType"='user' AND p."subjectId"=m."userId");

-- 2) kb_members -> kb 容器节点（一行，不逐 doc 物化）
INSERT INTO "auth_policies"
  ("id","workspaceId","nodeId","subjectType","subjectId","actions","reason","createdAt","createdBy")
SELECT 'pol_legacy_kbmember_'||km."id", 'ws_default', nk."id", 'user', km."userId",
  CASE km."role"
    WHEN 'owner'     THEN 'c,comment,d,manage_share,r,u'
    WHEN 'editor'    THEN 'c,comment,d,r,u'
    WHEN 'commenter' THEN 'comment,r'
    WHEN 'viewer'    THEN 'r'
  END,
  'legacy:kb_member', CURRENT_TIMESTAMP, 'legacy-backfill'
FROM "kb_members" km
JOIN "knowledge_bases" k ON k."id"=km."kbId" AND k."deletedAt" IS NULL
JOIN "nav_nodes" nk      ON nk."workspaceId"='ws_default' AND nk."resourceType"='kb'
                            AND nk."resourceId"=k."id" AND nk."deletedAt" IS NULL
WHERE km."role" IN ('owner','editor','commenter','viewer')
  AND NOT EXISTS (
    SELECT 1 FROM "auth_policies" p
    WHERE p."nodeId"=nk."id" AND p."subjectType"='user' AND p."subjectId"=km."userId");

-- 3) kb_doc_acls -> doc/canvas 内容节点（按 docId 关联，覆盖两种 kind，一行/ACL 不膨胀）
INSERT INTO "auth_policies"
  ("id","workspaceId","nodeId","subjectType","subjectId","actions","reason","createdAt","createdBy")
SELECT 'pol_legacy_acl_'||a."id", 'ws_default', n."id", 'user', a."userId",
  CASE a."role"
    WHEN 'editor'    THEN 'c,comment,d,r,u'
    WHEN 'commenter' THEN 'comment,r'
    WHEN 'viewer'    THEN 'r'
  END,
  'legacy:acl', CURRENT_TIMESTAMP, 'legacy-backfill'
FROM "kb_doc_acls" a
JOIN "kb_docs" d     ON d."id"=a."docId" AND d."deletedAt" IS NULL
JOIN "nav_nodes" n   ON n."workspaceId"='ws_default'
                        AND n."resourceType"=d."kind" AND n."resourceId"=d."id"
                        AND n."deletedAt" IS NULL
WHERE a."role" IN ('editor','commenter','viewer')
  AND NOT EXISTS (
    SELECT 1 FROM "auth_policies" p
    WHERE p."nodeId"=n."id" AND p."subjectType"='user' AND p."subjectId"=a."userId");

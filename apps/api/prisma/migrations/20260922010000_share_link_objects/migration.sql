-- 分享链接指向具体对象：给 share_links 补 objectType / objectId / viewId / mode / createdBy 五列。
--
-- 为什么要加列而不是复用现有 role 列：现有 share_links.role（editor/commenter/viewer）是
-- 「库级成员档位」的旧语义，本次要加的是【链接级】的两档（只读 / 可编辑）。二者不是一个东西：
--   旧 role 描述的是"拿到链接的人在库里算什么角色"——与权限模型重构后的"所有权限只能按角色配"
--   直接冲突（外部人没有角色，也不该有），故旧列不动、不删、继续只被 /api/bases/:id/share
--   的库级链接沿用；新档位另起 mode 列，语义干净，也不会把历史库级链接悄悄升级成可编辑。
--
-- 为什么 createdBy 是硬需求：可编辑链接必须在【每次访问】按分享人当前的库权限重算
-- （分享人被降权/移出/库权限收回 -> 链接自动降级为只读）。没有分享人 id 就无从重算，
-- 只能在创建时判一次——那正是本次要避免的"残留写权限"。存量行 createdBy 为 NULL 时
-- 一律按只读处理（domain/share/shareCaps.ts），宁可窄，不凭空给写权限。
--
-- 实现纪律（照 20260920220000_org_directory_actions）：
--   1. 只增列、只增索引，不删列不改列类型不改数据归属；存量行全部回落 objectType='base'，
--      即与迁移前行为逐行一致（库级链接），零行为漂移。
--   2. 数据部分幂等：回填语句以前置条件"这列还没回填过"限定，连跑两次结果恒等
--      （与模板同源；模板之所以要这样是因为 json_insert 无去重，此处是 UPDATE 无副作用，
--      但保持同一套写法便于审计）。
--   3. DDL 部分无法像 UPDATE 那样加 WHERE 幂等：SQLite 没有 ADD COLUMN IF NOT EXISTS，
--      也没有可执行条件分支的过程语句。本仓库既有扩列迁移（20260915090000_enterprise_org_ddl
--      的 users ALTER、20260919102128_entity_icon_ddl）同为裸 ALTER，重复执行的保护来自
--      Prisma 的 _prisma_migrations 记录表（migrate deploy 对已应用迁移整体跳过），
--      口径一致，不另造一套。
--   4. 不新建表、不加外键：objectId 可能是 tableId 也可能是 docId，跨表多态引用无法用
--      单个 REFERENCES 表达；引用完整性由应用层在点查时校验（shareLinkLookup.ts 会确认
--      对象存在且未被软删，不存在即 404）。
--   5. 回滚演练：发布前快照为主路径；仅回退本迁移效果执行
--      prisma/docs/rollback/20260922010000_share_link_objects.down.sql
--      （SQLite 3.35+ 支持 DROP COLUMN；低于该版本请用快照恢复）。

-- ① 分享对象族：base（整库，存量默认）/ table（某张表）/ kb_doc（文档或画布）。
ALTER TABLE "share_links" ADD COLUMN "objectType" TEXT NOT NULL DEFAULT 'base';

-- ② 对象 id：table=tableId、kb_doc=docId、base=NULL。
ALTER TABLE "share_links" ADD COLUMN "objectId" TEXT;

-- ③ 锚定视图（仅 objectType=table 时有意义）：决定外部访问者看到哪一列的排布。
ALTER TABLE "share_links" ADD COLUMN "viewId" TEXT;

-- ④ 分享档位：view=只读（存量默认，不升级历史链接）/ edit=可编辑。
ALTER TABLE "share_links" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'view';

-- ⑤ 分享人：可编辑链接动态降级的判定主体；NULL（存量行）一律只读。
ALTER TABLE "share_links" ADD COLUMN "createdBy" TEXT;

-- ⑥ 文档/画布分享的「开分享的人」：与 share_links.createdBy 同一用途——可编辑文档分享的
--    动态降级按他当前的知识库权限重算。存量行为 NULL -> 一律只读（shareCaps.ts）。
ALTER TABLE "kb_docs" ADD COLUMN "shareCreatedBy" TEXT;

-- ⑦ 点查索引：按对象族 + 对象 id 取某张表/某篇文档的全部分享链接（列表与吊销路径）。
CREATE INDEX "share_links_object_type_object_id_idx" ON "share_links"("objectType", "objectId");

-- ⑦ 幂等回填：把所有显式标记为 edit 但无分享人的行压回 view（防御性——迁移前不存在这种行，
--    但若有人手工写过脏数据，没有分享人的可编辑链接是"永远无法降级"的残留写权限，必须清掉）。
UPDATE "share_links"
SET "mode" = 'view'
WHERE "mode" = 'edit'
  AND ("createdBy" IS NULL OR "createdBy" = '');

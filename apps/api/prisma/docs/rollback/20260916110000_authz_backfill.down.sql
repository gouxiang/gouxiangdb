-- 回滚 M4/S2 回填迁移 20260916110000_authz_policies_backfill。
--
-- 回滚定义（M4-implementation-plan §5.1）：回到旧三表权威，仅清除【回填/投影行】。
-- 回填行 reason 前缀 'legacy:'（legacy:member / legacy:kb_member / legacy:acl），
-- createdBy='legacy-backfill'。v1 手工策略（reason 不以 legacy: 开头）保留——
-- off 态其本不生效，保留无害，二次升级仍在（不按 createdBy 清，避免误删同作者的其他行）。
DELETE FROM "auth_policies" WHERE "reason" IN ('legacy:member','legacy:kb_member','legacy:acl');

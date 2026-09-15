-- 回滚演练用（非正式迁移）：撤销 20260916130000_owner_manage_share 的效果，
-- 把 role_owner 的第五枚组织动作 manage_share 移除，回到 M3/S6 四动作固定串。
-- 主回滚路径仍是发布前快照；代码若尚未消费组织空间 manage_share，多一枚无副作用，一般无需执行本文件。
-- 幂等：仅当当前恰为五动作串时改回，避免覆盖人工调整；自定义角色不触碰。
-- 注意：不影响 auth_policies 中资源空间的 manage_share（另一命名空间）。

UPDATE "roles"
SET "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu"]'
WHERE "id" = 'role_owner'
  AND "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]';

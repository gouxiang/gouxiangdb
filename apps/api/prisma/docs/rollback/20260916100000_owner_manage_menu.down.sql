-- 回滚演练用（非正式迁移）：撤销 20260916100000_owner_manage_menu 的效果，
-- 把 role_owner 的第四动作 manage_menu 移除，回到 M2 三动作固定串。
-- 主回滚路径仍是发布前快照；M2 代码不消费 manage_menu，多一枚无副作用，一般无需执行本文件。
-- 幂等：仅当当前恰为四动作串时改回，避免覆盖人工调整。

UPDATE "roles"
SET "permissions" = '["manage_departments","manage_members","manage_roles"]'
WHERE "id" = 'role_owner'
  AND "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu"]';

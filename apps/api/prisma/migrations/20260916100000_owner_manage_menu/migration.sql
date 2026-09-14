-- M3/S6：给系统角色 role_owner 补第四枚组织管理动作 manage_menu（导航菜单编排）。
--
-- 只增迁移纪律：
--   1. 只 UPDATE 固定 id 的 owner 行，且 WHERE 固定的旧三动作 JSON 串（与 M2 DDL
--      20260915090000_enterprise_org_ddl 种子 :122 逐字同序、无空格），保证幂等：
--      已含 manage_menu（本迁移重跑/人工提前补位）的行不被改写；自定义角色不触碰
--      （manage_menu 是否授予由管理员在角色编辑器自行勾选）。
--   2. 不改名/描述/系统标记等其余列；不 INSERT 新行（owner 行由 M2 迁移保证存在）。
--   3. 回滚演练：发布前快照为主路径；如需仅回退本迁移效果，可执行
--      UPDATE roles SET permissions='["manage_departments","manage_members","manage_roles"]'
--      WHERE id='role_owner';（down SQL 另存 prisma/docs/rollback）。

UPDATE "roles"
SET "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu"]'
WHERE "id" = 'role_owner'
  AND "permissions" = '["manage_departments","manage_members","manage_roles"]';

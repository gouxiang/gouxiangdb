-- 回滚：把 role_owner 的第六枚组织动作 create_library 移除，回到 M4-S5 五动作固定串。
-- 仅回退本迁移效果（发布前快照为主路径）；条件限定为"恰为六动作"，避免误伤已被管理员
-- 人工改写的行。执行后 create_library 权限门对 owner 失效，需重新评估建库能力分配。
UPDATE "roles"
SET "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]'
WHERE "id" = 'role_owner'
  AND "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library"]';

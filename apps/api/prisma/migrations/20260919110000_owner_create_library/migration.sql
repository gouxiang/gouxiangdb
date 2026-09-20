-- M6：给系统角色 role_owner 补第六枚组织管理动作 create_library（建库/建知识库权限门）。
--
-- 为什么必须补：roles.permissions 是运行期唯一读取源（domain/org/authorization.ts 的
-- effectiveRoleRows 直接解析该列，SYSTEM_ROLES 常量只用于对拍与展示）。若不补进种子，
-- role_owner 在运行期就拿不到 create_library，而建库守卫 assertCanCreateLibrary 在实例
-- 存在任一授予时即生效 —— 结果是把 owner 本人锁在建库门外。
--
-- 与资源空间动作同名不同命名空间（同 20260916130000 纪律）：本迁移写的是组织管理面
-- OrgAction（roles.permissions，真源 packages/shared-types/src/org.ts 的 ORG_ACTIONS
-- 第六枚）；auth_policies 里的资源动作是另一套（shared-types/src/authz.ts），二者不互写。
--
-- 只增迁移纪律（同 20260916100000_owner_manage_menu / 20260916130000_owner_manage_share）：
--   1. 只 UPDATE 固定 id 的 owner 行，且 WHERE 固定的旧五动作 JSON 串（与上一迁移
--      20260916130000 落表串逐字同序、无空格），保证幂等：
--      已含 create_library（本迁移重跑/人工提前补位）的行不被改写；自定义角色不触碰
--      （create_library 是否授予由管理员在角色编辑器自行勾选）。
--   2. 不改名/描述/系统标记等其余列；不 INSERT 新行（owner 行由 M2 迁移保证存在）。
--   3. 落位顺序照 ORG_ACTIONS 既有追加约定（非字典序）：manage_share 之后追加 create_library。
--   4. 回滚演练：发布前快照为主路径；如需仅回退本迁移效果，可执行
--      UPDATE roles SET permissions='["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]'
--      WHERE id='role_owner';（down SQL 另存 prisma/docs/rollback）。

UPDATE "roles"
SET "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library"]'
WHERE "id" = 'role_owner'
  AND "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]';

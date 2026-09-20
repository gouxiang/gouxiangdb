-- 企业化定位：给既有角色补第七至十一枚组织管理动作（通讯录五件套）：
--   view_directory / invite_users / create_users / disable_users / delete_users。
--
-- 为什么必须是迁移而不是只改常量：运行期权限唯一读取源是 roles.permissions 列
-- （domain/org/authorization.ts 的 effectiveRoleRows -> parseActions 直接解析该列），
-- domain/org/roles.ts 的 SYSTEM_ROLES 常量只用于列表排序与 system 标记，不参与鉴权判定。
-- 只改 shared-types 不动这列，等于新加的权限位对全库成员一律不生效
-- （owner 会被自己挡在通讯录门外——此前 20260919110000 修过的 owner 建库门是同款事故）。
--
-- 为什么要「按 manage_members 有无」分两档而不是统一给全量：
--   这些角色今天是凭一枚 manage_members 做邀请/建号/停用的。动作位拆细后，若只给它们
--   view_directory，等于在一次无人察觉的发布里悄悄收回管理员已经派出去的能力。
--   故"曾经能管成员"的角色按原能力面补满五枚；其余角色（含四枚资源锚点系统角色
--   creator/editor/commenter/viewer）只补读权限，不一次性派发写动作——
--   今天是所有登录用户都能读通讯录（GET /org/members 无守卫），补 view_directory 是为了
--   切到 view_directory 守卫后不出现"全站突然看不到"的收缩；写动作什么时候给，
--   由管理员在角色编辑器里逐枚勾选。
--
-- 为什么四枚资源锚点系统角色也补 view_directory：它们是资源授权策略（auth_policies）的
-- 合法主体，不会被删除；若被管理员授予给某成员，该成员今日能读通讯录，补这一枚是为了
-- 这部分人也不掉权限。
--
-- 实现纪律（照 20260919110000_owner_create_library 的只增模板）：
--   1. 全程 UPDATE，不 INSERT/DELETE 任何角色行；不改 name/description/isSystem 等列。
--   2. 幂等：两条语句都以"五枚新动作一枚都没出现"为前置条件，已迁移过的行不会重复追加
--      （json_insert 无去重能力，重复追加会写出 ["a","a"] 这种脏串）。连跑两次结果恒等。
--   3. 不用全等字面量比对 permissions（与早前迁移不同）：本次要覆盖管理员自建的任意
--      自定义角色，其 permissions 组合无法枚举，故改用 LIKE 子串判定 + json_insert 追加。
--      代价：若某角色已被人工补了其中一枚（其余四枚没有），本迁移会整体跳过它，
--      剩余几枚需管理员在角色编辑器补勾——这是为了避免写出重复项的取舍，不是遗漏。
--   4. json_insert(..., '$[#]', ...) 需要 SQLite JSON1 扩展（随 SQLite 3.38+ 默认内置，
--      better-sqlite3 与 Prisma 自带引擎均已编译该扩展；已在 better-sqlite3 上验过本脚本）。
--   5. 追加顺序照 ORG_ACTIONS 既有追加约定（非字典序），见 packages/shared-types/src/org.ts。
--   6. 回滚演练：发布前快照为主路径；仅回退本迁移效果执行
--      prisma/docs/rollback/20260920220000_org_directory_actions.down.sql。

-- ① 含 manage_members 的角色（role_owner + 管理员自建的管人角色）：补满五枚，保持原能力面不缩水。
UPDATE "roles"
SET "permissions" = json_insert(
  json_insert(
    json_insert(
      json_insert(
        json_insert("permissions", '$[#]', 'view_directory'),
        '$[#]', 'invite_users'),
      '$[#]', 'create_users'),
    '$[#]', 'disable_users'),
  '$[#]', 'delete_users')
WHERE "permissions" IS NOT NULL
  AND "permissions" LIKE '%"manage_members"%'
  AND NOT (
    "permissions" LIKE '%"view_directory"%'
    OR "permissions" LIKE '%"invite_users"%'
    OR "permissions" LIKE '%"create_users"%'
    OR "permissions" LIKE '%"disable_users"%'
    OR "permissions" LIKE '%"delete_users"%'
  );

-- ② 不含 manage_members 的角色（四枚资源锚点系统角色 + 只读型自定义角色）：只补读权限。
UPDATE "roles"
SET "permissions" = json_insert("permissions", '$[#]', 'view_directory')
WHERE "permissions" IS NOT NULL
  AND "permissions" NOT LIKE '%"manage_members"%'
  AND "permissions" NOT LIKE '%"view_directory"%';

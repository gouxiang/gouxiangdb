-- 迁移 #27：权限核心模型（一）——角色模型升级 + 通讯录十二枚细粒度权限。
--
-- 做什么：
--   ① roles 新增 immutable 列：1 = 连名称/说明都不许改、不许删；0 = 可编辑可删除。
--      与既有 isSystem 分离——isSystem=1 只表示「系统种子行」，不代表不可变更。
--      没有这一列就无法表达「管理员/受限成员是系统预置但可被超级管理员删改，
--      只有超级管理员钉死」这条产品规则。
--   ② role_owner 升格为「超级管理员」（systemKey owner -> super_admin，不可编辑不可删）。
--      【为什么不新建一行】既有部署里 role_assignments / auth_policies 都以硬 id
--      'role_owner' 指向这枚角色；新建 role_super_admin 而不迁数据 = 一次发布把全站
--      管理员变成零权限，且修不回来（没人有权恢复）。改同一行的 key 与名称是零迁移成本、
--      零锁风险的同义替换。代价：行 id 仍是 role_owner（见 domain/org/roles.ts 注释）。
--   ③ 新增两枚预设角色：role_admin「管理员」（与超级管理员同权，但可删可改）、
--      role_restricted「受限成员」（零通讯录权限，新建用户未指定角色时的默认值）。
--   ④ 既有持粗粒度动词的角色补新细分动词，能力面不缩水（同 20260920220000 的取舍）。
--   ⑤ 存量用户兜底：任何一个「直接授予」都没有的用户，补一枚受限成员。
--      为什么必须做：新模型里权限只从角色来。留着一个没有角色的用户，等于留着一个
--      「权限来源不明」的账号——它在旧模型下靠 members 表拿库权限，切换决策函数后会
--      突然变成什么都不能干，而管理员在通讯录里看不见它少了什么。
--
-- 纪律（照 20260920220000_org_directory_actions）：
--   1. ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语法（SQLite），依赖 _prisma_migrations
--      只执行一次；手写重放会报错属预期。
--   2. 插非幂等的行一律 INSERT ... SELECT ... WHERE NOT EXISTS（重跑结果恒等）。
--   3. 所有 UPDATE 都以「目标动作一枚都没出现」为前置条件，避免 json_insert 写出重复脏串。
--   4. 追加顺序照 ORG_ACTIONS 既有约定（末尾追加，非字典序）。
--   5. 回滚：prisma/docs/rollback/20260921010000_role_core_models.down.sql。

-- ① immutable 列
ALTER TABLE "roles" ADD COLUMN "immutable" INTEGER NOT NULL DEFAULT 0;

-- ② role_owner -> 超级管理员（全十八枚动作，不可编辑不可删）
UPDATE "roles"
SET "systemKey" = 'super_admin',
    "name" = '超级管理员',
    "description" = '系统最高权限角色：可见并管理全部库、可建库、可删库、可开关分享；本身不可编辑、不可删除',
    "immutable" = 1,
    "permissions" = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users","create_roles","edit_roles","delete_roles","assign_role_members","create_departments","edit_departments","delete_departments"]'
WHERE "id" = 'role_owner';

-- ③ 管理员：与超级管理员同权（含建库、进所有库），初始无成员，可被删除/编辑
INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions", "immutable")
SELECT 'role_admin', 'ws_default', 'admin', '管理员', '系统预置：通讯录与建库能力同超级管理员，但不参与「最后一位超级管理员」保护，可被删除', 1,
       '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users","create_roles","edit_roles","delete_roles","assign_role_members","create_departments","edit_departments","delete_departments"]', 0
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_admin');

-- ③ 受限成员：零通讯录权限、零库权限，仅可改自己的个人信息
INSERT INTO "roles"("id", "workspaceId", "systemKey", "name", "description", "isSystem", "permissions", "immutable")
SELECT 'role_restricted', 'ws_default', 'restricted', '受限成员', '系统预置：无通讯录权限、无任何库权限，仅可修改自己的个人信息；新建用户未指定角色时的默认值', 1, '[]', 0
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'role_restricted');

-- ④ isSystem=1 的历史种子行保持「不可编辑不可删」原行为（超级管理员同上，幂等重设）
UPDATE "roles"
SET "immutable" = 1
WHERE "isSystem" = 1
  AND "id" IN ('role_owner', 'role_creator', 'role_editor', 'role_commenter', 'role_viewer');

-- ⑤a 过去凭 manage_roles 做角色管理的角色：拆出的四枚同补，能力面不缩水
UPDATE "roles"
SET "permissions" = json_insert(
  json_insert(
    json_insert(
      json_insert("permissions", '$[#]', 'create_roles'),
      '$[#]', 'edit_roles'),
    '$[#]', 'delete_roles'),
  '$[#]', 'assign_role_members')
WHERE "permissions" IS NOT NULL
  AND "id" NOT IN ('role_owner', 'role_admin', 'role_restricted')
  AND "permissions" LIKE '%"manage_roles"%'
  AND "permissions" NOT LIKE '%"create_roles"%'
  AND "permissions" NOT LIKE '%"edit_roles"%'
  AND "permissions" NOT LIKE '%"delete_roles"%'
  AND "permissions" NOT LIKE '%"assign_role_members"%';

-- ⑤b 过去凭 manage_departments 做部门管理的角色：三枚同补
UPDATE "roles"
SET "permissions" = json_insert(
  json_insert(
    json_insert("permissions", '$[#]', 'create_departments'),
    '$[#]', 'edit_departments'),
  '$[#]', 'delete_departments')
WHERE "permissions" IS NOT NULL
  AND "id" NOT IN ('role_owner', 'role_admin', 'role_restricted')
  AND "permissions" LIKE '%"manage_departments"%'
  AND "permissions" NOT LIKE '%"create_departments"%'
  AND "permissions" NOT LIKE '%"edit_departments"%'
  AND "permissions" NOT LIKE '%"delete_departments"%';

-- ⑥ 存量用户兜底：没有任何 user 级直接授予的账号授予受限成员。
--    role_assignments 的业务唯一由表达式索引 (roleId,subjectType,subjectId,scopeType,
--    COALESCE(scopeNodeId,'')) 保证；这里的 NOT EXISTS 与其同口径，重跑不会重复插入。
INSERT INTO "role_assignments"("id", "roleId", "subjectType", "subjectId", "scopeType", "createdBy")
SELECT 'ra_seed_' || u."id", 'role_restricted', 'user', u."id", 'workspace', 'migration-20260921010000'
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "role_assignments" ra
  WHERE ra."subjectType" = 'user' AND ra."subjectId" = u."id"
);

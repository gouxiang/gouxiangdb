-- 回滚：收敛第七至十一枚组织管理动作（通讯录五件套），回到 M6 的六动作固定组合。
-- 仅回退本迁移效果（发布前快照为主路径）。SQL 无法知道某行迁移前到底是哪五档中的哪一档
-- （"有 manage_members 补五枚" / "没有只补读"），故回退按行的当前形态分两条语句处理：
--
--   ① 恰含五枚新动作（且有 manage_members）的行 -> 用 json_remove 逐个剔除（倒序下标不可用，
--      每剔除一次重新取长度，故写成嵌套的 json_remove(..., '$[#-1]') 五次：从尾部删五次，
--      正好删掉末尾连续追加的五枚，不依赖顺序知识）；
--   ② 只含 view_directory（且无 manage_members）的行 -> 剔除一枚。
--
-- 前置条件都限定为"五枚全部在场 / 只有 view_directory"，避免误伤已被管理员人工改写的行。
-- 执行后的影响：切到 view_directory 守卫前请勿回退本迁移——回退后除 owner 外所有成员
-- 都不再持有 view_directory，会被 GET /org/members 的守卫挡在通讯录门外。若要回退，
-- 必须与守卫挂载一起回退（否则是全站失读事故）。

-- ① 回滚「补满五枚」的那一档（含 manage_members 的角色，role_owner 与管理人角色）。
UPDATE "roles"
SET "permissions" = json_remove(json_remove(json_remove(json_remove(json_remove(
      "permissions", '$[#-1]'), '$[#-1]'), '$[#-1]'), '$[#-1]'), '$[#-1]')
WHERE "permissions" LIKE '%"manage_members"%'
  AND "permissions" LIKE '%"view_directory"%'
  AND "permissions" LIKE '%"invite_users"%'
  AND "permissions" LIKE '%"create_users"%'
  AND "permissions" LIKE '%"disable_users"%'
  AND "permissions" LIKE '%"delete_users"%';

-- ② 回滚「只补读权限」的那一档（四枚资源锚点系统角色 + 只读型自定义角色）。
UPDATE "roles"
SET "permissions" = json_remove("permissions", '$[#-1]')
WHERE "permissions" NOT LIKE '%"manage_members"%'
  AND "permissions" LIKE '%"view_directory"%'
  AND "permissions" NOT LIKE '%"invite_users"%'
  AND "permissions" NOT LIKE '%"create_users"%'
  AND "permissions" NOT LIKE '%"disable_users"%'
  AND "permissions" NOT LIKE '%"delete_users"%';

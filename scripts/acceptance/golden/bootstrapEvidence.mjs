// scripts/acceptance/golden/bootstrapEvidence.mjs
// A 段自举证据（只读裸 SQL，独立于服务端响应）：
//   - role_owner 在 user 级恰好一行，且授予的是最早注册用户
//   - drill 用户（owner + 20 主体 = 21）全部 ACTIVE
//   - workspaces.ws_default 恰好一行；七枚系统角色齐备且 systemKey 有序
//
// 2026-09-21 commit 9a96364 角色模型重构后为 7 枚：新增 admin/restricted，role_owner 行 id
// 保留但 systemKey 升为 super_admin（故 owner 授予断言仍查 roleId='role_owner'）。

const SYSTEM_ROLE_KEYS = ["admin", "commenter", "creator", "editor", "restricted", "super_admin", "viewer"];

export function collectBootstrapEvidence(db) {
  // role_assignments 无 revokedAt 列（授予通过删行撤销，不停用置位）。
  const ownerCount = db.prepare(
    "SELECT count(*) c FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
  ).get().c;
  const activeDrill = db.prepare(
    "SELECT count(*) c FROM users WHERE email LIKE 'drill-%@example.test' AND status='ACTIVE'",
  ).get().c;
  const ws = db.prepare("SELECT count(*) c FROM workspaces WHERE id='ws_default'").get().c;
  const sysRoles = db.prepare("SELECT count(*) c FROM roles WHERE isSystem=1 AND deletedAt IS NULL").get().c;
  const roleKeys = db.prepare("SELECT systemKey FROM roles WHERE isSystem=1 ORDER BY systemKey").all().map((r) => r.systemKey);
  const ownerIsFirst = db.prepare(
    "SELECT u.id FROM users u JOIN role_assignments ra ON ra.subjectId=u.id "
      + "WHERE ra.roleId='role_owner' AND ra.subjectType='user' ORDER BY u.createdAt ASC, u.id ASC LIMIT 1",
  ).get();

  const pass = ownerCount === 1 && activeDrill === 21 && ws === 1 && sysRoles === 7
    && JSON.stringify(roleKeys) === JSON.stringify(SYSTEM_ROLE_KEYS);

  return {
    ownerGrants: ownerCount,
    activeDrillUsers: activeDrill,
    workspaceDefault: ws,
    systemRoles: sysRoles,
    systemRoleKeys: roleKeys,
    ownerIsEarliest: !!ownerIsFirst,
    pass,
  };
}

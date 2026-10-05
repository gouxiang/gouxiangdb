// M2 组织管理动作鉴权与有效角色求值（S3 落地原语，S5 对齐 shared-types 契约并补全来源名）。
//
// 有效角色 = 直接授予（subjectType=user） ∪ 用户各【活部门】祖先闭包上的部门授予
// （subjectType=dept；授予某部门 = 其子树全体成员获得，与计划 §5-C/ARCH §5.1 一致）。
//
// 常量查询（与部门层数/兼岗数无关，S5 有计数测试）：
//   q1 一次取用户全部部门归属（含 department.path/deletedAt）；祖先闭包在应用层由 path 切出；
//   q2 一次取祖先部门名（含非本人所在的上层部门）；
//   q3 一次 OR 取 user 直接授予 + dept 祖先集合上的授予（include role 拿 actions/软删）。
// 软删部门不展开（归属被 deletedAt 过滤），软删角色不生效。

import type { OrgAction, EffectiveRoleDTO, EffectiveRoleSource } from "@gx/shared-types";
import { ORG_ACTIONS } from "@gx/shared-types";
import { prisma, type DbTx } from "../../db.js";

export type { OrgAction };
export { ORG_ACTIONS };

type Client = DbTx | typeof prisma;

/** 由物化路径切出祖先闭包（含自身）的部门 id："/a/b/" -> ["a","b"]。 */
function ancestorDeptIdsFromPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function parseActions(raw: string): OrgAction[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is OrgAction => typeof p === "string" && (ORG_ACTIONS as readonly string[]).includes(p));
  } catch {
    return [];
  }
}

/**
 * 解析用户有效组织角色（去重并合并来源）。定数查询（3 次），无 N+1。
 * 接受可选 tx（写事务内做最后 owner 保护时复用同一事务视图）。
 */
export async function effectiveRoleRows(
  userId: string,
  client: Client = prisma,
): Promise<EffectiveRoleDTO[]> {
  // q1：用户的部门归属（只取活部门）。
  const memberships = await client.deptMember.findMany({
    where: { userId },
    include: { department: { select: { id: true, name: true, path: true, deletedAt: true } } },
  });
  const activeDepts = memberships
    .map((m) => m.department)
    .filter((d): d is NonNullable<typeof d> => d !== null && d.deletedAt === null);

  // 祖先闭包：每个所在部门 path 的全部前缀段（含自身）。
  const ancestorIds = new Set<string>();
  for (const d of activeDepts) {
    for (const seg of ancestorDeptIdsFromPath(d.path)) ancestorIds.add(seg);
  }
  if (ancestorIds.size === 0) {
    // 无部门：仍可能有 user 直接授予，q3 照常；跳过 q2。
  }

  // q2：祖先部门名（含本人不在、但角色挂在其上层的部门）。
  const ancestorRows = ancestorIds.size
    ? await client.department.findMany({
      where: { id: { in: [...ancestorIds] } },
      select: { id: true, name: true, deletedAt: true },
    })
    : [];
  const deptNameById = new Map<string, string>();
  for (const d of ancestorRows) {
    if (d.deletedAt === null) deptNameById.set(d.id, d.name);
  }

  // q3：user 直接授予 + dept 祖先集合授予，一条 OR。
  const assignments = await client.roleAssignment.findMany({
    where: {
      OR: [
        { subjectType: "user", subjectId: userId },
        { subjectType: "dept", subjectId: { in: [...ancestorIds] } },
      ],
    },
    include: { role: true },
  });

  const byRole = new Map<string, EffectiveRoleDTO>();
  for (const a of assignments) {
    const role = a.role;
    if (!role || role.deletedAt !== null) continue;
    const source: EffectiveRoleSource =
      a.subjectType === "user"
        ? { type: "user", id: userId }
        : { type: "dept", id: a.subjectId, name: deptNameById.get(a.subjectId) };
    const existing = byRole.get(role.id);
    if (existing) {
      if (!existing.sources.some((s) => s.type === source.type && s.id === source.id)) {
        existing.sources.push(source);
      }
    } else {
      byRole.set(role.id, {
        roleId: role.id,
        systemKey: role.systemKey as EffectiveRoleDTO["systemKey"],
        name: role.name,
        isSystem: role.isSystem === 1,
        actions: parseActions(role.permissions),
        sources: [source],
      });
    }
  }
  return [...byRole.values()];
}

/** 用户是否持有某组织管理动作（任一有效角色的 actions 含该动作）。 */
export async function hasOrgAction(
  userId: string,
  action: OrgAction,
  client: Client = prisma,
): Promise<boolean> {
  const roles = await effectiveRoleRows(userId, client);
  return roles.some((r) => r.actions.includes(action));
}

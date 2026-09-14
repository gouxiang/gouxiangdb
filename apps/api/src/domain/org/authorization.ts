// M2/S3 组织管理动作鉴权原语（S5 的 roles.ts 在其上建 DTO/CRUD 与查询计数测试）。
//
// 从 S3 起写端点必须真正过动作判定，禁止"登录即放行"的临时放开（派工明示）。
// 有效角色 = 直接授予（subjectType=user） ∪ 用户各【活部门】祖先闭包上的部门授予
// （subjectType=dept；授予某部门 = 其子树全体成员获得，与计划 §5-C/ARCH §5.1 一致）。
//
// 查询为与部门层数/兼岗数无关的常量：
//   q1 一次取用户全部部门归属（含 department.path/deletedAt）；祖先闭包在应用层由 path 切出；
//   q2 一次 OR 取 user 直接授予 + dept 祖先集合上的授予（include role 拿 permissions/软删）。
// 软删部门不展开（归属被 deletedAt 过滤），软删角色不生效。

import { prisma, type DbTx } from "../../db.js";

export type OrgActionString = "manage_departments" | "manage_members" | "manage_roles";

export const ORG_ACTIONS: readonly OrgActionString[] = [
  "manage_departments",
  "manage_members",
  "manage_roles",
];

export interface EffectiveRoleSource {
  type: "user" | "dept";
  id: string;
  name?: string;
}

export interface EffectiveRoleRow {
  roleId: string;
  systemKey: string | null;
  name: string;
  isSystem: boolean;
  permissions: string[];
  sources: EffectiveRoleSource[];
}

type Client = DbTx | typeof prisma;

/** 由物化路径切出祖先闭包（含自身）的部门 id："/a/b/" -> ["a","b"]。 */
export function ancestorDeptIdsFromPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * 解析用户有效组织角色（去重并合并来源）。定数查询，无 N+1。
 * 接受可选 tx（在写事务内做保护判定时复用同一事务视图）。
 */
export async function effectiveRoleRows(
  userId: string,
  client: Client = prisma,
): Promise<EffectiveRoleRow[]> {
  // q1：用户的部门归属（只取活部门）。
  const memberships = await client.deptMember.findMany({
    where: { userId },
    include: { department: { select: { id: true, name: true, path: true, deletedAt: true } } },
  });
  const activeDepts = memberships
    .map((m) => m.department)
    .filter((d) => d !== null && d.deletedAt === null);

  // 祖先闭包：每个所在部门 path 的全部前缀段（含自身）。去重。
  const ancestorIds = new Set<string>();
  const deptNameById = new Map<string, string>();
  for (const d of activeDepts) {
    deptNameById.set(d.id, d.name);
    for (const seg of ancestorDeptIdsFromPath(d.path)) ancestorIds.add(seg);
  }

  // q2：user 直接授予 + dept 祖先集合授予，一条 OR。
  const assignments = await client.roleAssignment.findMany({
    where: {
      OR: [
        { subjectType: "user", subjectId: userId },
        { subjectType: "dept", subjectId: { in: [...ancestorIds] } },
      ],
    },
    include: { role: true },
  });

  const byRole = new Map<string, EffectiveRoleRow>();
  for (const a of assignments) {
    const role = a.role;
    if (!role || role.deletedAt !== null) continue;
    let perms: string[] = [];
    try {
      const parsed: unknown = JSON.parse(role.permissions);
      if (Array.isArray(parsed)) perms = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      perms = [];
    }
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
        systemKey: role.systemKey,
        name: role.name,
        isSystem: role.isSystem === 1,
        permissions: perms,
        sources: [source],
      });
    }
  }
  return [...byRole.values()];
}

/** 用户是否持有某组织管理动作（任一有效角色的 permissions 含该动作）。 */
export async function hasOrgAction(
  userId: string,
  action: OrgActionString,
  client: Client = prisma,
): Promise<boolean> {
  const roles = await effectiveRoleRows(userId, client);
  return roles.some((r) => r.permissions.includes(action));
}

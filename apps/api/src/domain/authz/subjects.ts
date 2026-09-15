// M4/S1 主体展开：薄封装 M2 effectiveRoleRows（禁止复制角色展开实现，避免两套语义漂移），
// 另查一次用户活部门（id+path），并由 path 切段求部门祖先闭包（dept 源 IN 查询用）。
//
// 纯域：只依赖注入 client，不 import Hono/guards，不查旧三表（members/kb_members/kb_doc_acls）。
// 定数往返（与部门层数/兼岗数无关）：effectiveRoleRows ≤3（其 q1 已查部门归属，但不回传
// department 投影）+ 本模块一次 deptMember include department = ≤4。

import { effectiveRoleRows } from "../org/authorization.js";
import type { AuthzClient, ResolvedSubject } from "./types.js";

/** 由部门物化路径切出祖先闭包（含自身）id："/a/b/" -> ["a","b"]。 */
export function ancestorDeptIds(paths: readonly string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    for (const seg of p.split("/").filter(Boolean)) set.add(seg);
  }
  return [...set];
}

/**
 * 解析决策主体：roleIds（含 user 直授 + 部门祖先继承的角色，M2 已求值）、
 * 各活部门 path、部门祖先闭包、workspace owner 标记（持 role_owner）。
 */
export async function resolveSubject(
  userId: string,
  client: AuthzClient,
): Promise<ResolvedSubject> {
  const roleDTOs = await effectiveRoleRows(userId, client);
  const roleIds = [...new Set(roleDTOs.map((r) => r.roleId))];

  const memberships = await client.deptMember.findMany({
    where: { userId },
    include: { department: { select: { id: true, path: true, deletedAt: true } } },
  });
  const departments = memberships
    .map((m) => m.department)
    .filter((d): d is { id: string; path: string; deletedAt: Date | null } =>
      d !== null && d.deletedAt === null)
    .map((d) => ({ id: d.id, path: d.path }));

  return {
    userId,
    roleIds,
    departments,
    deptAncestorIds: ancestorDeptIds(departments.map((d) => d.path)),
    isWorkspaceOwner: roleIds.includes("role_owner"),
  };
}

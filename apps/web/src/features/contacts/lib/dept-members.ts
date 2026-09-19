// M2/S7 通讯录纯函数：「添加已有成员」去重口径。
// 后端 POST /org/members/:id/departments 的 add 是 upsert（已归属保持原状、不报错），
// 但前端必须先把已在本部门的成员筛掉，避免「重复 add」这种无声写。

/** 只依赖成员的最小结构（OrgMemberDTO 的结构化子集，便于单测构造）。 */
export interface DeptMemberLike {
  id: string;
  deptMemberships: Array<{ departmentId: string }>;
}

/** 该成员是否已归属指定部门。 */
export function isInDept(member: DeptMemberLike, deptId: string): boolean {
  return member.deptMemberships.some((d) => d.departmentId === deptId);
}

/** 候选成员：过滤掉已在本部门的，剩下的才可勾选添加。 */
export function assignableMembers<T extends DeptMemberLike>(
  members: readonly T[],
  deptId: string,
): T[] {
  return members.filter((m) => !isInDept(m, deptId));
}

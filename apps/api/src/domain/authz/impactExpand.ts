// M4/S7 三源反向展开（计划 §4.5 impact 预览 / move-impact 升级共用）。
//
// 把"节点集上的 r 授予"展开为去重 ACTIVE 用户集，三源与 subjects.resolveSubject 互逆：
//   direct：subjectType=user 直授；
//   role：  role 授予 -> usersWithRole 同口径（user 直授 + 授予部门子树成员，仅 ACTIVE）；
//   dept：  dept 授予 -> 被授部门【子树】全体活部门成员（祖先授予荫及子树）。
// 与 S4 scope/S5 effective 同源同口径，impact 人数因此可与逐节点 decide/scope 对拍 0 差异。
// 行级谓词 conditions 不参与（A-7 顺延 P1，本期无行权限）。
//
// 纯域：只依赖注入 client，不 import Hono/guards/db 单例。角色/部门展开在单次预览内缓存，
// 供逐节点对称差复用（move-impact 对每个内容节点各算 before/after 两侧）。

import type { AuthzClient } from "./types.js";

/** 一条待展开的授予（auth_policies 行投影；动作过滤由调用方完成）。 */
export interface GrantRef {
  subjectType: "user" | "dept" | "role";
  subjectId: string;
  nodeId: string;
}

interface ActiveCache {
  /** 已确认 ACTIVE 的用户（惰性批量校验）。 */
  active: Set<string>;
  /** 已查过存在性的用户（含非 ACTIVE），避免重复 IN 查询。 */
  checked: Set<string>;
}

/** 三源授予展开器（单次 impact/move 预览生命期）：角色/部门子树展开全实例共享缓存。 */
export class GrantExpander {
  private readonly roleUsers = new Map<string, Set<string>>();
  private readonly deptUsers = new Map<string, Set<string>>();
  private readonly activeCache: ActiveCache = { active: new Set(), checked: new Set() };

  constructor(private readonly client: AuthzClient) {}

  /** 把一批授予展开进目标 map（userId -> 来源描述集）；同一实例多次调用共享角色/部门缓存。 */
  async expandInto(target: Map<string, Set<string>>, grants: readonly GrantRef[]): Promise<void> {
    const roleGrants: GrantRef[] = [];
    const deptGrants: GrantRef[] = [];
    for (const g of grants) {
      if (g.subjectType === "user") add(target, g.subjectId, `direct:${g.subjectId}@${g.nodeId}`);
      else if (g.subjectType === "role") roleGrants.push(g);
      else deptGrants.push(g);
    }
    for (const g of roleGrants) {
      const users = await this.roleMembers(g.subjectId);
      for (const uid of users) add(target, uid, `role:${g.subjectId}@${g.nodeId}`);
    }
    for (const g of deptGrants) {
      const users = await this.deptMembers(g.subjectId);
      for (const uid of users) add(target, uid, `dept:${g.subjectId}@${g.nodeId}`);
    }
  }

  /** 便捷封装：展开到新 map。 */
  async expand(grants: readonly GrantRef[]): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    await this.expandInto(map, grants);
    return map;
  }

  /** role 反向展开（与 org/roles.usersWithRole 同口径：直授 + 授予部门子树成员）。 */
  private async roleMembers(roleId: string): Promise<Set<string>> {
    const hit = this.roleUsers.get(roleId);
    if (hit) return hit;
    const assignments = await this.client.roleAssignment.findMany({
      where: { roleId },
      select: { subjectType: true, subjectId: true },
    });
    const direct = new Set<string>();
    const deptIds: string[] = [];
    for (const a of assignments) {
      if (a.subjectType === "user") direct.add(a.subjectId);
      else if (a.subjectType === "dept") deptIds.push(a.subjectId);
    }
    const subtree = await this.subtreeDeptUsers(deptIds);
    const merged = new Set([...direct, ...subtree]);
    this.roleUsers.set(roleId, merged);
    return merged;
  }

  private async deptMembers(deptId: string): Promise<Set<string>> {
    const hit = this.deptUsers.get(deptId);
    if (hit) return hit;
    const users = await this.subtreeDeptUsers([deptId]);
    this.deptUsers.set(deptId, users);
    return users;
  }

  /** 一批部门 -> 各自子树（path 前缀）活部门 -> 成员用户集。 */
  private async subtreeDeptUsers(rootDeptIds: string[]): Promise<Set<string>> {
    if (rootDeptIds.length === 0) return new Set();
    const roots = await this.client.department.findMany({
      where: { id: { in: rootDeptIds }, deletedAt: null },
      select: { path: true },
    });
    if (roots.length === 0) return new Set();
    const subtreeDepts = await this.client.department.findMany({
      where: { deletedAt: null, OR: roots.map((d) => ({ path: { startsWith: d.path } })) },
      select: { id: true },
    });
    const memberships = await this.client.deptMember.findMany({
      where: { departmentId: { in: subtreeDepts.map((d) => d.id) } },
      select: { userId: true },
    });
    return new Set(memberships.map((m) => m.userId));
  }

  /** 把候选集收敛为 ACTIVE 用户（惰性批量查，随用户数分批，规避超大 IN）。 */
  async activeOnly(candidates: ReadonlySet<string>): Promise<Set<string>> {
    const pending = [...candidates].filter((id) => !this.activeCache.checked.has(id));
    for (let i = 0; i < pending.length; i += 900) {
      const batch = pending.slice(i, i + 900);
      const rows = await this.client.user.findMany({
        where: { id: { in: batch }, status: "ACTIVE" },
        select: { id: true },
      });
      for (const r of rows) this.activeCache.active.add(r.id);
      for (const id of batch) this.activeCache.checked.add(id);
    }
    return new Set([...candidates].filter((id) => this.activeCache.active.has(id)));
  }
}

function add(map: Map<string, Set<string>>, userId: string, ref: string): void {
  const set = map.get(userId);
  if (set) set.add(ref);
  else map.set(userId, new Set([ref]));
}

/** 取工作区全部 ACTIVE owner（role_owner 持有者）。 */
export async function workspaceOwnerIds(client: AuthzClient): Promise<Set<string>> {
  const expander = new GrantExpander(client);
  const map = await expander.expand([{ subjectType: "role", subjectId: "role_owner", nodeId: "__workspace__" }]);
  return expander.activeOnly(new Set(map.keys()));
}

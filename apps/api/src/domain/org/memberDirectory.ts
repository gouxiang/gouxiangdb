// M2/S4 成员目录【只读】侧：分页/搜索/部门子树/状态过滤 + 单成员投影。
// 写侧（邀请/建号/多部门分配/自举）在 members.ts；拆分以守单文件 <=300 行纪律。
//
// N+1 收敛：成员列表 1 条（count+findMany），归属与直接角色各 1 条 IN 批量，共 3~4 次往返，
// 不随成员数增长。

import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { getDefaultWorkspaceId } from "./workspace.js";

export const MEMBER_PAGE_MAX = 100;

export interface DeptMembershipDTO {
  departmentId: string;
  isMain: boolean;
  joinedAt: string;
}

export interface OrgMemberDTO {
  id: string;
  email: string;
  displayName: string;
  status: string;
  avatarUrl: string | null;
  invitedAt: string | null;
  createdAt: string;
  deptMemberships: DeptMembershipDTO[];
  directRoles: Array<{ roleId: string; systemKey: string | null; name: string }>;
}

export interface MemberPage {
  items: OrgMemberDTO[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ListMembersFilter {
  page?: unknown;
  limit?: unknown;
  q?: unknown;
  deptId?: unknown;
  status?: unknown;
}

function posInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** LIKE 转义：% _ \\ 转义后配合 ESCAPE，保证 q 被当字面量（参数化，杜绝注入/通配穿透）。 */
function likeEscape(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function toMember(
  u: {
    id: string; email: string; displayName: string; status: string; avatarUrl: string | null;
    invitedAt: Date | null; createdAt: Date;
  },
  memberships: DeptMembershipDTO[],
  directRoles: OrgMemberDTO["directRoles"],
): OrgMemberDTO {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
    avatarUrl: u.avatarUrl,
    invitedAt: u.invitedAt ? u.invitedAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    deptMemberships: memberships,
    directRoles,
  };
}

/**
 * 成员目录：分页（page/limit<=100）+ q（email/displayName 参数化 LIKE）+ deptId（含子树，
 * path 前缀一条解析）+ status。
 */
export async function listMembers(filter: ListMembersFilter): Promise<MemberPage> {
  const workspaceId = await getDefaultWorkspaceId();
  const page = posInt(filter.page, 1, Number.MAX_SAFE_INTEGER);
  const limit = posInt(filter.limit, 20, MEMBER_PAGE_MAX);

  const where: Prisma.UserWhereInput = { workspaceId };

  if (typeof filter.status === "string" && ["INVITED", "ACTIVE", "DISABLED"].includes(filter.status)) {
    where.status = filter.status;
  }
  if (typeof filter.q === "string" && filter.q.trim() !== "") {
    const needle = `%${likeEscape(filter.q.trim())}%`;
    where.OR = [{ email: { contains: needle } }, { displayName: { contains: needle } }];
  }
  if (typeof filter.deptId === "string" && filter.deptId !== "") {
    const root = await prisma.department.findFirst({
      where: { id: filter.deptId, workspaceId, deletedAt: null },
      select: { path: true },
    });
    if (!root) return { items: [], total: 0, page, limit, hasMore: false };
    const subtree = await prisma.department.findMany({
      where: { workspaceId, deletedAt: null, path: { startsWith: root.path } },
      select: { id: true },
    });
    const deptIds = subtree.map((d) => d.id);
    where.deptMemberships = { some: { departmentId: { in: deptIds } } };
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, email: true, displayName: true, status: true,
        avatarUrl: true, invitedAt: true, createdAt: true,
      },
    }),
  ]);

  const userIds = users.map((u) => u.id);
  const [allMemberships, allAssignments] = await Promise.all([
    userIds.length
      ? prisma.deptMember.findMany({
        where: { userId: { in: userIds } },
        include: { department: { select: { deletedAt: true } } },
      })
      : [],
    userIds.length
      ? prisma.roleAssignment.findMany({
        where: { subjectType: "user", subjectId: { in: userIds } },
        include: { role: { select: { id: true, systemKey: true, name: true, deletedAt: true } } },
      })
      : [],
  ]);

  const memByUser = new Map<string, DeptMembershipDTO[]>();
  for (const m of allMemberships) {
    if (m.department?.deletedAt) continue;
    const list = memByUser.get(m.userId) ?? [];
    list.push({ departmentId: m.departmentId, isMain: m.isMain === 1, joinedAt: m.joinedAt.toISOString() });
    memByUser.set(m.userId, list);
  }
  const roleByUser = new Map<string, OrgMemberDTO["directRoles"]>();
  for (const a of allAssignments) {
    if (a.role.deletedAt) continue;
    const list = roleByUser.get(a.subjectId) ?? [];
    list.push({ roleId: a.role.id, systemKey: a.role.systemKey, name: a.role.name });
    roleByUser.set(a.subjectId, list);
  }

  const items = users.map((u) => toMember(u, memByUser.get(u.id) ?? [], roleByUser.get(u.id) ?? []));
  return { items, total, page, limit, hasMore: page * limit < total };
}

/** 单成员（含活部门归属与直接角色）；不存在或跨工作区返回 null。 */
export async function getMemberById(userId: string): Promise<OrgMemberDTO | null> {
  const workspaceId = await getDefaultWorkspaceId();
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, displayName: true, status: true, workspaceId: true,
      avatarUrl: true, invitedAt: true, createdAt: true,
    },
  });
  if (!u || u.workspaceId !== workspaceId) return null;

  const [memRows, assignments] = await Promise.all([
    prisma.deptMember.findMany({
      where: { userId },
      include: { department: { select: { deletedAt: true } } },
    }),
    prisma.roleAssignment.findMany({
      where: { subjectType: "user", subjectId: userId },
      include: { role: { select: { id: true, systemKey: true, name: true, deletedAt: true } } },
    }),
  ]);
  const deptMemberships: DeptMembershipDTO[] = memRows
    .filter((m) => !m.department.deletedAt)
    .map((m) => ({
      departmentId: m.departmentId,
      isMain: m.isMain === 1,
      joinedAt: m.joinedAt.toISOString(),
    }));
  const directRoles = assignments
    .filter((a) => !a.role.deletedAt)
    .map((a) => ({ roleId: a.role.id, systemKey: a.role.systemKey, name: a.role.name }));
  return toMember(u, deptMemberships, directRoles);
}

// apps/api/src/domain/authz/libraryVisibility.ts
// 「这个库谁能进来」的只读视图。
//
// 取代旧的逐库逐人成员名册（members / kb_members CRUD）：权限既然只能按角色配，
// 那么成员管理页能回答的问题就只剩一个——"哪些角色覆盖到这个库、覆盖到多少人"。
// 名单不再是授权入口，写接口（加人/改档位/踢人）随之全部下线；
// 要改谁能进来，去通讯录改角色的库视野，或改这个人属于哪个角色。
//
// 超级管理员与管理员不配库视野也能进，所以必须单独列出人数——
// 否则页面会显示"没有任何角色能访问本库"，而事实上这两类人全都能进，
// 管理员会照着错误的结论去"补授权"，越补越乱。

import { prisma } from "../../db.js";
import type { LibraryKind, LibraryVisibilityResponse } from "@gx/shared-types";
import { usersWithRole, ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID } from "../org/roles.js";

/**
 * 全量在岗（ACTIVE）成员数：直接授予 ∪ 被授部门的整个子树（与 effectiveRoleRows 同口径的
 * 反方向展开）。停用/待激活账号不计。
 */
async function liveCount(roleId: string): Promise<number> {
  return (await usersWithRole(roleId)).length;
}

export async function libraryVisibility(
  libraryKind: LibraryKind,
  libraryId: string,
): Promise<LibraryVisibilityResponse> {
  const [scopes, shareEnabled] = await Promise.all([
    prisma.roleLibraryScope.findMany({
      where: { libraryKind, libraryId },
      select: { roleId: true, canManage: true, visible: true },
    }),
    readShareEnabled(libraryKind, libraryId),
  ]);

  const live = scopes.filter((s) => s.visible === 1 || s.canManage === 1);
  const roles = live.length
    ? await prisma.role.findMany({
      where: { id: { in: live.map((s) => s.roleId) }, deletedAt: null },
      select: { id: true, name: true, systemKey: true },
    })
    : [];
  const byId = new Map(roles.map((r) => [r.id, r]));

  const out: LibraryVisibilityResponse = {
    libraryKind,
    libraryId,
    roles: [],
    implicitAdminCount: await liveCount(ADMIN_ROLE_ID),
    implicitSuperAdminCount: await liveCount(SUPER_ADMIN_ROLE_ID),
    shareEnabled,
  };

  for (const s of live) {
    const role = byId.get(s.roleId);
    // 角色被软删了：这条视野已经不可能生效，列出来只会误导，直接跳过。
    if (!role) continue;
    out.roles.push({
      roleId: role.id,
      roleName: role.name,
      systemKey: role.systemKey,
      canManage: s.canManage === 1,
      visible: s.visible === 1,
      memberCount: await liveCount(role.id),
    });
  }
  out.roles.sort((a, b) => Number(b.canManage) - Number(a.canManage) || a.roleName.localeCompare(b.roleName));
  return out;
}

export async function readShareEnabled(libraryKind: LibraryKind, libraryId: string): Promise<boolean> {
  if (libraryKind === "kb") {
    const kb = await prisma.knowledgeBase.findUnique({
      where: { id: libraryId },
      select: { shareEnabled: true },
    });
    return kb?.shareEnabled === 1;
  }
  const base = await prisma.base.findUnique({
    where: { id: libraryId },
    select: { shareEnabled: true },
  });
  return base?.shareEnabled === 1;
}

/** 开关某个库的「允许分享」（调用方必须先过 requireCanToggleShare）。 */
export async function setShareEnabled(
  libraryKind: LibraryKind,
  libraryId: string,
  enabled: boolean,
): Promise<boolean> {
  const v = enabled ? 1 : 0;
  if (libraryKind === "kb") {
    await prisma.knowledgeBase.update({ where: { id: libraryId }, data: { shareEnabled: v } });
  } else {
    await prisma.base.update({ where: { id: libraryId }, data: { shareEnabled: v } });
  }
  return enabled;
}

/** 表级允许分享开关：库级开了还不够，表也得开。 */
export async function setTableShareEnabled(tableId: string, enabled: boolean): Promise<boolean> {
  await prisma.table.update({ where: { id: tableId }, data: { shareEnabled: enabled ? 1 : 0 } });
  return enabled;
}

/** 某张表是否可外发分享（库级 && 表级两个开关都开）。 */
export async function tableShareAllowed(tableId: string): Promise<boolean> {
  const t = await prisma.table.findUnique({
    where: { id: tableId },
    select: { shareEnabled: true, base: { select: { shareEnabled: true } } },
  });
  return t?.shareEnabled === 1 && t?.base.shareEnabled === 1;
}

// apps/api/src/domain/authz/libraryScopeSeed.ts
// 新建库/知识库时，同事务给超级管理员与管理员各落一条角色视野行。
//
// 为什么必须有这一步：本次重构【取消了库主】——库不再属于任何个人，建库人的权力
// 来自他持有的角色，不来自"这是我建的"。于是建库落地的瞬间，库对所有人都是"没配
// 过视野"的状态；管理员若只有硬编码的"进得去"而没有 canManage，建完库立刻就连
// 一张表都加不上去，产品当场不可用。故在建库事务里补这两行：
//   - 超级管理员：行只是台账，放行仍走 libraryPolicy 的硬短路（硬规则不落库）；
//   - 管理员：canManage=1 是它唯一的来源（管理员的管理权不靠硬编码推导）。
//
// 存量库由迁移 20260921020000 一次性回填；此后每个新建库自带这两行。

import type { Prisma } from "@prisma/client";
import type { LibraryKind } from "@gx/shared-types";
import { ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID } from "../org/roles.js";

/** 建库/建知识库事务内调用；已存在则不动（PUT 语义与管理员手工勾选的旧值都不覆盖）。 */
export async function seedAdminScopeTx(
  tx: Prisma.TransactionClient,
  kind: LibraryKind,
  libraryId: string,
): Promise<void> {
  for (const roleId of [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID]) {
    await tx.roleLibraryScope.upsert({
      where: { roleId_libraryKind_libraryId: { roleId, libraryKind: kind, libraryId } },
      create: { roleId, libraryKind: kind, libraryId, canManage: 1, visible: 1 },
      update: {},
    });
  }
}

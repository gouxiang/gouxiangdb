// apps/api/src/domain/authz/scopeDoubleWrite.ts
// P1/S5：第二代 role_library_scope 变更 -> auth_policies 投影的【同事务双写】。
// 只依赖注入 client，不 import 全局 db；由路由/seed 在写事务内调用。引擎仍 off，投影只写不读。
//
// 删除口径：rebuild 走 replaceScopePoliciesTx（精确替换、只删 scope:role）；
// 新库 seed 只 upsert、绝不删除（不得影响管理员在其他库的存量投影）。

import type { AuthzClient } from "./types.js";
import { upsertPolicyTx } from "./repository.js";
import {
  projectScopeRow,
  projectImplicitAdmin,
  type ProjectedPolicy,
  type ScopeProjectionInput,
} from "./scopeProjection.js";
import { loadLiveShape, replaceScopePoliciesTx } from "./scopeProjectionTx.js";
import { nodeId } from "../nav/backfill.js";

/** scope 行快照（写后 role_library_scope 行的形状）。 */
export interface SavedScopeRow {
  roleId: string;
  libraryKind: string;
  libraryId: string;
  canManage: number;
  visible: number;
  canShare: number;
  config: string;
}

const SUPER_ADMIN_ROLE_ID = "role_owner";
const ADMIN_ROLE_ID = "role_admin";
const EMPTY_SHAPE = { tableIds: [], fieldIdsByTable: new Map<string, readonly string[]>() };

function toProjectionInput(row: SavedScopeRow): ScopeProjectionInput {
  return {
    roleId: row.roleId,
    libraryKind: row.libraryKind === "kb" ? "kb" : "base",
    libraryId: row.libraryId,
    canManage: row.canManage,
    visible: row.visible,
    canShare: row.canShare,
    config: row.config,
  };
}

/** role_admin：覆盖全部活库（含未提交库），避免其隐含只读策略被当孤儿删除。 */
async function rebuildAdmin(
  client: AuthzClient,
  savedRows: readonly SavedScopeRow[],
): Promise<ProjectedPolicy[]> {
  const [bases, kbs] = await Promise.all([
    client.base.findMany({ where: { deletedAt: null }, select: { id: true } }),
    client.knowledgeBase.findMany({ where: { deletedAt: null }, select: { id: true } }),
  ]);
  const baseInputs = await Promise.all(
    bases.map(async ({ id }) => ({ libraryId: id, shape: await loadLiveShape(client, id) })),
  );
  return projectImplicitAdmin({
    bases: baseInputs,
    kbs: kbs.map(({ id }) => ({ libraryId: id })),
    adminScopeRows: savedRows.map(toProjectionInput),
  });
}

/** 普通角色：逐 base 取形状投影，kb 行用空形状；被删 scope 行对应投影随之精确删除。 */
async function rebuildRole(
  client: AuthzClient,
  savedRows: readonly SavedScopeRow[],
): Promise<ProjectedPolicy[]> {
  const out: ProjectedPolicy[] = [];
  for (const row of savedRows) {
    if (row.libraryKind === "base") {
      const shape = await loadLiveShape(client, row.libraryId);
      out.push(...projectScopeRow(toProjectionInput(row), shape));
    } else {
      out.push(...projectScopeRow(toProjectionInput(row), EMPTY_SHAPE));
    }
  }
  return out;
}

/**
 * 写后按该角色完整 scope 行集重建投影。role_owner 跳过（只走硬短路，不生成策略）。
 */
export async function rebuildScopePoliciesTx(
  client: AuthzClient,
  roleId: string,
  savedRows: readonly SavedScopeRow[],
  operatorUserId: string,
): Promise<{ upserted: number; deleted: number }> {
  if (roleId === SUPER_ADMIN_ROLE_ID) return { upserted: 0, deleted: 0 };
  const projected =
    roleId === ADMIN_ROLE_ID
      ? await rebuildAdmin(client, savedRows)
      : await rebuildRole(client, savedRows);
  return replaceScopePoliciesTx(client, roleId, projected, operatorUserId);
}

/**
 * 新库 seed：为 role_admin 仅投影这一个新库，只 upsert 不删除。
 * base（零表）预期仅库节点 manage_share+manage_table；
 * kb 预期 kb 节点 content 全权 + comment + manage_share + manage_table。
 */
export async function projectAdminForNewLibraryTx(
  client: AuthzClient,
  kind: "base" | "kb",
  newLibraryId: string,
  operatorUserId: string,
): Promise<void> {
  const adminScopeRow: ScopeProjectionInput = {
    roleId: ADMIN_ROLE_ID,
    libraryKind: kind,
    libraryId: newLibraryId,
    canManage: 1,
    visible: 1,
    canShare: 0,
    config: JSON.stringify({ tables: {}, fields: {} }),
  };
  const projected =
    kind === "base"
      ? projectImplicitAdmin({
          bases: [{ libraryId: newLibraryId, shape: await loadLiveShape(client, newLibraryId) }],
          kbs: [],
          adminScopeRows: [adminScopeRow],
        })
      : projectImplicitAdmin({
          bases: [],
          kbs: [{ libraryId: newLibraryId }],
          adminScopeRows: [adminScopeRow],
        });

  for (const p of projected) {
    await upsertPolicyTx(client, {
      nodeId: p.nodeId,
      subjectType: "role",
      subjectId: ADMIN_ROLE_ID,
      actions: p.actions,
      fieldMask: p.fieldMask,
      reason: p.reason,
      createdBy: operatorUserId,
    });
  }
}

/**
 * 建表 seed：为 role_admin 仅补这张新表节点的隐含策略，只 upsert 这一条、不删除任何行。
 * 建库时 base 节点策略已建，建表只需补表节点——漏补会让管理员对新表 OVERDENY。
 * role_admin 可能没有该库 scope 行（管理员覆盖本就不依赖行存在），空行集也能跑：
 * projectImplicitAdmin 对空行给出隐含只读。
 */
export async function projectAdminForNewTableTx(
  client: AuthzClient,
  baseId: string,
  newTableId: string,
  operatorUserId: string,
): Promise<void> {
  const adminScopeRows = await client.roleLibraryScope.findMany({
    where: { libraryKind: "base", libraryId: baseId, roleId: ADMIN_ROLE_ID },
  });
  const projected = projectImplicitAdmin({
    bases: [{ libraryId: baseId, shape: await loadLiveShape(client, baseId) }],
    kbs: [],
    adminScopeRows: adminScopeRows.map(toProjectionInput),
  });
  const one = projected.find((p) => p.nodeId === nodeId("table", newTableId));
  if (!one) return;
  await upsertPolicyTx(client, {
    nodeId: one.nodeId,
    subjectType: "role",
    subjectId: ADMIN_ROLE_ID,
    actions: one.actions,
    fieldMask: one.fieldMask,
    reason: one.reason,
    createdBy: operatorUserId,
  });
}

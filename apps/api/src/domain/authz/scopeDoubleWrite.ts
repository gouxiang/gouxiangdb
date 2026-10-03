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
  type ProjectedPolicy,
  type ScopeProjectionInput,
} from "./scopeProjection.js";
import { projectImplicitAdmin } from "./implicitAdminProject.js";
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
async function expectedAdmin(
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

/**
 * 普通角色：逐 base 取形状投影，kb 行用空形状；被删 scope 行对应投影随之精确删除。
 *
 * 【非活库一律不投影】ADR-0056 实施时坐实的前置缺口：库软删/不存在时 `loadLiveShape` 返回空形状，
 * 早先因为「零表 + 非管理位 -> 库节点策略行根本不生成」而侥幸不产生任何行；新增 `enter` 聚合位后
 * 仅 visible=1 也会生成一条指向死节点的孤儿策略（nav 节点软删或压根不存在）。
 * 故在此显式按活库过滤——这不是新增规则，而是把「已删库不投影」这条既有语义钉死。
 * 实测量级（dev.db 副本）：203 条 scope 行中 164 条指向非活库（82 个死库 id，其 nav 节点
 * 41 个存在但已软删、其余不存在），全部属于 role_owner/role_admin，两条路径本就不投影，
 * 故对本库零影响；但普通角色一旦出现同类行就会写出孤儿。
 */
async function expectedRole(
  client: AuthzClient,
  savedRows: readonly SavedScopeRow[],
): Promise<ProjectedPolicy[]> {
  if (savedRows.length === 0) return [];
  const liveBaseIds = new Set(
    (await client.base.findMany({ where: { deletedAt: null }, select: { id: true } })).map((b) => b.id),
  );
  const liveKbIds = new Set(
    (await client.knowledgeBase.findMany({ where: { deletedAt: null }, select: { id: true } })).map((k) => k.id),
  );
  const out: ProjectedPolicy[] = [];
  for (const row of savedRows) {
    const live = row.libraryKind === "base"
      ? liveBaseIds.has(row.libraryId)
      : liveKbIds.has(row.libraryId);
    if (!live) continue;
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
 * 计算某角色【当前应有】的 scope:role 投影集（只读，不落库）。
 * savedRows 缺省时自行查该角色全部活 scope 行（reconcile 只读路径）；
 * PUT 主路径应传写后行集以复用同事务快照、避免二次查库。
 * role_owner 只走硬短路、不投影 -> 空数组。
 */
export async function expectedScopePoliciesForRole(
  client: AuthzClient,
  roleId: string,
  savedRows?: readonly SavedScopeRow[],
): Promise<ProjectedPolicy[]> {
  if (roleId === SUPER_ADMIN_ROLE_ID) return [];
  const rows = savedRows
    ?? await client.roleLibraryScope.findMany({ where: { roleId } });
  return roleId === ADMIN_ROLE_ID
    ? expectedAdmin(client, rows)
    : expectedRole(client, rows);
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
  const projected = await expectedScopePoliciesForRole(client, roleId, savedRows);
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

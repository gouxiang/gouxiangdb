// apps/api/src/domain/authz/scopeProjectionTx.ts
// P1 §5.2：scope -> auth_policies 投影的【事务原语】。只依赖注入 client，不 import 全局 db、
// 不自行开事务（由调用方/测试包事务）；不接 HTTP/路由，不改现有生产调用点。
//
// 删除口径硬约束（关键防线）：只删 reason='scope:role' 的行，绝不触碰 subjectType 非 role、
// 或 reason 为 legacy:* / policy:v1 / null 的行。deletePolicyTx 按三元组删不看 reason，
// 故所有删除候选必须先 where reason="scope:role" 过滤。

import type { AuthzClient } from "./types.js";
import { deletePolicyTx, upsertPolicyTx } from "./repository.js";
import {
  projectScopeRow,
  buildFieldMask,
  type LiveSchemaShape,
  type ProjectedPolicy,
  type ScopeProjectionInput,
} from "./scopeProjection.js";
import { nodeId } from "../nav/backfill.js";
import { parseConfig } from "./libraryScopeConfig.js";

/** 取 base 活 schema 形状（活表 + 每表活字段），用于 add / mask 重算。 */
export async function loadLiveShape(
  client: AuthzClient,
  libraryId: string,
): Promise<LiveSchemaShape> {
  const tables = await client.table.findMany({
    where: { baseId: libraryId, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const fieldIdsByTable = new Map<string, readonly string[]>();
  for (const { id } of tables) {
    const fields = await client.field.findMany({
      where: { tableId: id, deletedAt: null },
      select: { id: true },
      orderBy: { order: "asc" },
    });
    fieldIdsByTable.set(id, fields.map((f) => f.id));
  }
  return { tableIds: tables.map((t) => t.id), fieldIdsByTable };
}

/**
 * 用期望投影集【精确替换】某角色在受影响节点的 scope:role 策略。
 * projected 内各行直接展开 upsert，不在此重算；期望集之外的现存 scope:role 行删除。
 */
export async function replaceScopePoliciesTx(
  client: AuthzClient,
  roleId: string,
  projected: readonly ProjectedPolicy[],
  operatorUserId: string,
): Promise<{ upserted: number; deleted: number }> {
  for (const p of projected) {
    await upsertPolicyTx(client, {
      nodeId: p.nodeId,
      subjectType: "role",
      subjectId: roleId,
      actions: p.actions,
      fieldMask: p.fieldMask,
      reason: p.reason,
      createdBy: operatorUserId,
    });
  }

  const existing = await client.authPolicy.findMany({
    where: { subjectType: "role", subjectId: roleId, reason: "scope:role" },
    select: { nodeId: true },
  });
  const wanted = new Set(projected.map((p) => p.nodeId));
  let deleted = 0;
  for (const { nodeId: existingNode } of existing) {
    if (wanted.has(existingNode)) continue;
    const result = await deletePolicyTx(client, {
      nodeId: existingNode, subjectType: "role", subjectId: roleId,
    });
    if (result.deleted) deleted += 1;
  }
  return { upserted: projected.length, deleted };
}

function toScopeInput(row: {
  roleId: string; libraryKind: string; libraryId: string;
  canManage: number; visible: number; canShare: number; config: string;
}): ScopeProjectionInput {
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

/**
 * 建表/删表：为库内全部命中角色补/删该表投影。
 * add：projectScopeRow 后只挑目标节点那条 upsert；remove：仅删 reason=scope:role 的行。
 * kb 场景 tableId=null（content 伪表挂 kb 节点）。
 */
export async function syncTableForAllScopesTx(
  client: AuthzClient,
  libraryKind: "base" | "kb",
  libraryId: string,
  tableId: string | null,
  op: "add" | "remove",
  operatorUserId: string,
): Promise<void> {
  const targetNode =
    libraryKind === "kb"
      ? nodeId("kb", libraryId)
      : nodeId("table", tableId as string);
  const rows = await client.roleLibraryScope.findMany({
    where: { libraryKind, libraryId },
  });
  const shape = libraryKind === "base" ? await loadLiveShape(client, libraryId) : undefined;

  for (const row of rows) {
    if (op === "add") {
      const projected = projectScopeRow(toScopeInput(row), shape as LiveSchemaShape);
      const one = projected.find((p) => p.nodeId === targetNode);
      if (!one) continue;
      await upsertPolicyTx(client, {
        nodeId: one.nodeId, subjectType: "role", subjectId: row.roleId,
        actions: one.actions, fieldMask: one.fieldMask, reason: one.reason,
        createdBy: operatorUserId,
      });
    } else {
      const found = await client.authPolicy.findFirst({
        where: { nodeId: targetNode, subjectType: "role", subjectId: row.roleId },
        select: { reason: true },
      });
      if (found?.reason !== "scope:role") continue;
      await deletePolicyTx(client, {
        nodeId: targetNode, subjectType: "role", subjectId: row.roleId,
      });
    }
  }
}

/**
 * 字段结构变更后重算受影响表 mask。仅更新该表节点上【已有 scope:role 行】的角色，
 * 保持原 actions 不变、只改 fieldMask；无现存行则跳过（mask 不能凭空让表可见）。
 */
export async function resyncTableMaskTx(
  client: AuthzClient,
  tableId: string,
  operatorUserId: string,
): Promise<void> {
  const table = await client.table.findUnique({
    where: { id: tableId }, select: { baseId: true },
  });
  if (!table) return;
  const fields = await client.field.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true }, orderBy: { order: "asc" },
  });
  const liveFieldIds = fields.map((f) => f.id);
  const rows = await client.roleLibraryScope.findMany({
    where: { libraryKind: "base", libraryId: table.baseId },
  });

  for (const row of rows) {
    const existing = await client.authPolicy.findFirst({
      where: {
        nodeId: nodeId("table", tableId),
        subjectType: "role", subjectId: row.roleId, reason: "scope:role",
      },
      select: { actions: true },
    });
    if (!existing) continue;
    const mask = buildFieldMask(
      tableId, liveFieldIds, parseConfig(row.config).fields,
    );
    await upsertPolicyTx(client, {
      nodeId: nodeId("table", tableId), subjectType: "role", subjectId: row.roleId,
      actions: existing.actions, fieldMask: mask ? JSON.stringify(mask) : null,
      reason: "scope:role", createdBy: operatorUserId,
    });
  }
}

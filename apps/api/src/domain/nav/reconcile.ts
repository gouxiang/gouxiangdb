// M3 nav 对账主编排：A/B 类差异计算 + 幂等修复（计划 §5.4）。
//
// C 类菜单差异与默认菜单补齐在 reconcile-menu.ts；实体存活表在 reconcile-state.ts；
// 修复与迁移/S3 sync 共用 backfill.ts 的期望集与原语，不另写一套规则。

import type { DbTx } from "../../db.js";
import {
  buildExpectedNodes,
  reconcileNodesTx,
  rebuildPathsTx,
} from "./backfill.js";
import { computePaths } from "./tree.js";
import { loadEntityState } from "./reconcile-state.js";
import { diffMenu, ensureDefaultMenuTx, type SystemNodeRow } from "./reconcile-menu.js";
import {
  emptyReport,
  finalize,
  type ApplyOptions,
  type ApplyResult,
  type ReconcileReport,
} from "./reconcile-types.js";

export type { ReconcileReport, ApplyResult } from "./reconcile-types.js";

/** 只读差异报告。 */
export async function computeDiffs(tx: DbTx): Promise<ReconcileReport> {
  const report = emptyReport();
  const expected = await buildExpectedNodes(tx);
  const nodes = await tx.navNode.findMany() as unknown as SystemNodeRow[];
  const aliveNodes = nodes.filter((n) => !n.deletedAt);

  // ---- A 类：实体 -> 节点 ----
  const liveById = new Map(aliveNodes.map((n) => [n.id, n]));
  for (const e of expected) {
    const hits = aliveNodes.filter((n) => n.resourceType === e.kind && n.resourceId === e.resourceId);
    const n = liveById.get(e.id);
    if (hits.length === 0 || !n) {
      // 软删节点占位算 B3，缺失算 A1。
      if (nodes.some((x) => x.id === e.id)) report.B.push({ code: "B3", message: `实体活但节点软删: ${e.kind}:${e.resourceId}`, ref: e.id });
      else report.A.push({ code: "A1", message: `活实体缺节点: ${e.kind}:${e.resourceId}`, ref: e.id });
      continue;
    }
    if (hits.length > 1) report.A.push({ code: "A2", message: `同一实体多个活节点: ${e.kind}:${e.resourceId}`, ref: e.id });
    if (n.parentId !== e.parentId) report.A.push({ code: "A3", message: `父节点错: ${e.kind}:${e.resourceId}`, ref: n.id });
    if (n.name !== e.name) report.A.push({ code: "A4", message: `name 不一致: ${e.kind}:${e.resourceId}`, ref: n.id });
    if (n.ord !== e.ord) report.A.push({ code: "A5", message: `ord 不符: ${e.kind}:${e.resourceId}`, ref: n.id });
  }
  const computedPaths = computePaths(aliveNodes.map((n) => ({ id: n.id, parentId: n.parentId })));
  for (const n of aliveNodes) {
    const want = computedPaths.get(n.id);
    if (want && (n.path !== want.path || n.depth !== want.depth)) {
      report.A.push({ code: "A6", message: `path/depth 与 parentId 链不一致: ${n.id}`, ref: n.id });
    }
  }

  // ---- B 类：系统节点 -> 实体悬挂 ----
  const { aliveId, softId } = await loadEntityState(tx);
  for (const n of nodes.filter((x) => x.isSystem === 1 && x.resourceType)) {
    if (aliveId.has(n.id)) continue;
    if (softId.has(n.id)) {
      if (!n.deletedAt) report.B.push({ code: "B2", message: `实体软删而节点活: ${n.resourceType}:${n.resourceId}`, ref: n.id });
    } else if (!n.deletedAt) {
      report.B.push({ code: "B1", message: `实体行不存在(broken): ${n.resourceType}:${n.resourceId}`, ref: n.id });
    }
  }

  // ---- C 类：菜单引用 ----
  await diffMenu(tx, aliveNodes, expected, report);
  return finalize(report);
}

/** 修复 A/B3/C4；B1/C1 broken 仅在 purgeBroken 时物理清理；B2/C1 soft 软删对齐。 */
export async function applyFixesTx(tx: DbTx, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const expected = await buildExpectedNodes(tx);
  const nodes = await reconcileNodesTx(tx, expected);
  // path 重建在节点对齐后统一执行一次（reconcileNodesTx 自身不重建，避免重复全表扫描）。
  const pathsRebuilt = await rebuildPathsTx(tx);

  const purged: { shortcuts: number; nodes: number } = { shortcuts: 0, nodes: 0 };
  const softDeleted = { nodes: 0, shortcuts: 0 };

  // B2：实体软删而节点活 -> 软删节点。
  const { softId, aliveId } = await loadEntityState(tx);
  for (const nid of softId) {
    const n = await tx.navNode.findUnique({ where: { id: nid } });
    if (n && !n.deletedAt) {
      await tx.navNode.update({ where: { id: nid }, data: { deletedAt: new Date() } });
      softDeleted.nodes++;
    }
  }

  // C1 soft：shortcut 指向软删节点 -> 软删 shortcut（恢复实体时由 C4 补回默认引用）。
  const shortcuts = await tx.menuItem.findMany({ where: { type: "shortcut", deletedAt: null } });
  for (const s of shortcuts) {
    if (!s.nodeId) continue;
    const target = await tx.navNode.findUnique({ where: { id: s.nodeId } });
    if (target?.deletedAt || softId.has(s.nodeId)) {
      await tx.menuItem.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
      softDeleted.shortcuts++;
    }
  }

  // B1/C1 broken：仅 purgeBroken。先删 shortcut 再删节点（FK RESTRICT 顺序）。
  if (opts.purgeBroken) {
    const brokenNodeIds = new Set<string>();
    for (const n of await tx.navNode.findMany({ where: { deletedAt: null, isSystem: 1 } })) {
      if (n.resourceType && !aliveId.has(n.id) && !softId.has(n.id)) brokenNodeIds.add(n.id);
    }
    for (const s of shortcuts) {
      if (s.nodeId && brokenNodeIds.has(s.nodeId)) {
        await tx.menuItem.delete({ where: { id: s.id } });
        purged.shortcuts++;
      }
    }
    for (const id of brokenNodeIds) {
      await tx.navNode.delete({ where: { id } });
      purged.nodes++;
    }
  }

  // C4：补默认菜单（容器 + 缺失 shortcut）。
  const menus = await ensureDefaultMenuTx(tx, expected);

  return { nodes: { ...nodes, pathsRebuilt }, menus, purged, softDeleted };
}

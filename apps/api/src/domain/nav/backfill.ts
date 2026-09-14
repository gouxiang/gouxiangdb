// M3 nav 回填/修复的单一规则源：期望实体节点计算 + 幂等 upsert 原语。
//
// 迁移 20260916093000_*_backfill 的 SQL 负责存量首跑（同规则的 SQL 镜像）；
// 运行期（S3 sync.ts 写点同步）与上线后兜底（scripts/nav/reconcile-nav.ts --apply）
// 都只调用本文件原语，禁止另写一套映射（M3 计划 §4.3/§5.4）。
//
// 规则（与迁移 SQL 注释逐条对应）：
//  - 活实体：deletedAt IS NULL；view 额外要求 order>=0；doc 父镜像 kb_docs.parentId（活父 doc 才挂）；
//  - 确定性 id：nav_<kind>_<resourceId>，一资源一节点；
//  - ord：L0 按 (kind base 先 kb 后, createdAt,id)；table/view 同父 createdAt/order；doc/canvas 同父 updatedAt desc；
//  - group 节点不由本文件生成（管理员手工建），扫描/修复时原样保留。

import type { DbTx } from "../../db.js";
import { computePaths } from "./tree.js";

export const WS_ID = "ws_default";

export type NavKind = "base" | "kb" | "table" | "view" | "doc" | "canvas";

export function nodeId(kind: NavKind, resourceId: string): string {
  return `nav_${kind}_${resourceId}`;
}

/** 期望实体节点（父用确定性节点 id 表达；path 由 computePaths 统一重算）。 */
export interface ExpectedNode {
  id: string;
  kind: NavKind;
  resourceId: string;
  parentId: string | null;
  name: string;
  ord: number;
}

/** 计算当前库【应有】的全部实体节点（不含 group）。单一事实源。 */
export async function buildExpectedNodes(tx: DbTx): Promise<ExpectedNode[]> {
  const bases = await tx.base.findMany({ where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const kbs = await tx.knowledgeBase.findMany({ where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const out: ExpectedNode[] = [];

  bases.forEach((b, i) =>
    out.push({ id: nodeId("base", b.id), kind: "base", resourceId: b.id, parentId: null, name: b.name, ord: i }));
  kbs.forEach((k, i) =>
    out.push({ id: nodeId("kb", k.id), kind: "kb", resourceId: k.id, parentId: null, name: k.name, ord: bases.length + i }));

  for (const b of bases) {
    const tables = await tx.table.findMany({
      where: { baseId: b.id, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    tables.forEach((t, i) =>
      out.push({ id: nodeId("table", t.id), kind: "table", resourceId: t.id, parentId: nodeId("base", b.id), name: t.name, ord: i }));
    for (const t of tables) {
      const views = await tx.view.findMany({ where: { tableId: t.id, order: { gte: 0 } }, orderBy: [{ order: "asc" }, { id: "asc" }] });
      for (const v of views) {
        out.push({ id: nodeId("view", v.id), kind: "view", resourceId: v.id, parentId: nodeId("table", t.id), name: v.name, ord: v.order });
      }
    }
  }

  for (const k of kbs) {
    const docs = await tx.kbDoc.findMany({
      where: { kbId: k.id, deletedAt: null }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    docs.forEach((d, i) => {
      const parentId =
        d.kind === "doc" && d.parentId && docs.some((x) => x.id === d.parentId && x.kind === "doc")
          ? nodeId("doc", d.parentId!)
          : nodeId("kb", k.id);
      out.push({
        id: nodeId(d.kind === "canvas" ? "canvas" : "doc", d.id),
        kind: d.kind === "canvas" ? "canvas" : "doc",
        resourceId: d.id,
        parentId,
        name: d.title,
        ord: i,
      });
    });
  }
  return out;
}

/**
 * 幂等对齐实体节点（不删多余节点——悬挂由 reconcile B 类报告/按 flag 清理）：
 * 缺则建、在但 name/parent/ord 不符则原地更新、软删的系统节点复活。
 * 注意：本函数【不】重算 path/depth——path 重建由编排方（reconcile applyFixesTx /
 * S3 sync 原语）在节点对齐完成后显式统一调用 rebuildPathsTx 一次，避免重复全表扫描。
 * group 节点不被本函数改写。返回 upsert/update 计数。
 */
export async function reconcileNodesTx(
  tx: DbTx,
  expected: ExpectedNode[],
): Promise<{ created: number; updated: number; revived: number }> {
  let created = 0;
  let updated = 0;
  let revived = 0;

  for (const e of expected) {
    const existing = await tx.navNode.findUnique({ where: { id: e.id } });
    if (!existing) {
      await tx.navNode.create({
        data: {
          id: e.id, workspaceId: WS_ID, parentId: e.parentId, kind: e.kind,
          resourceType: e.kind, resourceId: e.resourceId, name: e.name, ord: e.ord,
          isSystem: 1, inheritAncestors: 1,
        },
      });
      created++;
      continue;
    }
    const changed =
      existing.name !== e.name ||
      existing.parentId !== e.parentId ||
      existing.ord !== e.ord ||
      existing.resourceType !== e.kind ||
      existing.resourceId !== e.resourceId;
    if (changed || existing.deletedAt) {
      await tx.navNode.update({
        where: { id: e.id },
        data: { name: e.name, parentId: e.parentId, ord: e.ord, resourceType: e.kind, resourceId: e.resourceId, deletedAt: null },
      });
      if (existing.deletedAt) revived++;
      else if (changed) updated++;
    }
  }

  return { created, updated, revived };
}

/** 全量重算所有活节点 path/depth（含 group）。断链/环按根处理（差异另行报告）。 */
export async function rebuildPathsTx(tx: DbTx): Promise<number> {
  const rows = await tx.navNode.findMany({
    where: { deletedAt: null }, select: { id: true, parentId: true, path: true, depth: true },
  });
  const computed = computePaths(rows.map((r) => ({ id: r.id, parentId: r.parentId })));
  let changed = 0;
  for (const r of rows) {
    const want = computed.get(r.id)!;
    if (r.path !== want.path || r.depth !== want.depth) {
      await tx.navNode.update({ where: { id: r.id }, data: { path: want.path, depth: want.depth } });
      changed++;
    }
  }
  return changed;
}

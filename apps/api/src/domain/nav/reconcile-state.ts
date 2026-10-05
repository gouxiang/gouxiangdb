// M3 nav 对账：实体存活状态表（供 B 类悬挂判定）。
//
// view 没有 deletedAt 列，存活需【同时】满足 order>=0 且所属 table 未软删：
// table 软删时视图被置 order=-1 隐藏（见 S0 characterization）；而 base 软删只级联
// tables.deletedAt、不碰 views.order，不校验 table 存活会误判这些 view 为 B3。
// doc 与 canvas 同表（kb_docs.kind），按 kind 分别注册。

import type { DbTx } from "../../db.js";
import { nodeId, type ExpectedNode } from "./backfill.js";

interface EntityState {
  aliveId: Set<string>;
  softId: Set<string>;
  nameOf: Map<string, string>;
}

/** 计算实体存活表（含 view order<0 的软隐藏态），供 B 类悬挂判定。 */
export async function loadEntityState(tx: DbTx): Promise<EntityState> {
  const bases = await tx.base.findMany({ select: { id: true, name: true, deletedAt: true } });
  const kbs = await tx.knowledgeBase.findMany({ select: { id: true, name: true, deletedAt: true } });
  const tables = await tx.table.findMany({ select: { id: true, name: true, deletedAt: true } });
  const views = await tx.view.findMany({ select: { id: true, name: true, order: true, tableId: true } });
  const docs = await tx.kbDoc.findMany({ select: { id: true, kind: true, title: true, deletedAt: true } });
  const aliveId = new Set<string>();
  const softId = new Set<string>();
  const nameOf = new Map<string, string>();
  const register = (
    kind: string,
    rows: Array<{ id: string; name?: string; title?: string; deletedAt?: Date | null }>,
  ) => {
    for (const r of rows) {
      const nid = nodeId(kind as ExpectedNode["kind"], r.id);
      nameOf.set(nid, r.name ?? r.title ?? "");
      if (r.deletedAt) softId.add(nid);
      else aliveId.add(nid);
    }
  };
  register("base", bases);
  register("kb", kbs);
  register("table", tables);
  // view 存活口径：order>=0（table 软删时视图被置 -1 隐藏）【且】其 table 活。
  // base 软删只级联 tables.deletedAt、不碰 views.order（S0 实测），若不检查 table 存活，
  // 已随 base 子树软删的 view 节点会被误判成 B3（实体活但节点软删）。
  const aliveTableIds = new Set(tables.filter((t) => !t.deletedAt).map((t) => t.id));
  const tableIdOfView = new Map(views.map((v) => [v.id, v.tableId] as const));
  for (const v of views) {
    nameOf.set(nodeId("view", v.id), v.name);
    const nid = nodeId("view", v.id);
    if (v.order < 0 || !aliveTableIds.has(tableIdOfView.get(v.id)!)) softId.add(nid);
    else aliveId.add(nid);
  }
  // doc 与 canvas 同表，按 kind 分别注册到两种节点命名空间。
  register("doc", docs.filter((d) => d.kind === "doc"));
  register("canvas", docs.filter((d) => d.kind === "canvas"));
  return { aliveId, softId, nameOf };
}

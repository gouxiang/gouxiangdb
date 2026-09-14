// M3 nav 对账：C 类菜单差异计算（C1-C5）与默认菜单幂等补齐。
//
// 规则（裁决 4，计划 §5.3）：
//  - shortcut.nodeId 是真实 FK ON DELETE RESTRICT，资源物理删不联动删菜单，broken 只报告（purge 才清）；
//  - 不生成 view shortcut；子文档不挂菜单（文档层级走 nav_nodes 子树）；
//  - 每活 table / 根级活 doc / 活 canvas 至少一条活 shortcut（C4 零入口丢失）；
//  - 容器嵌套应用层限 2 层，成环报 C2；同父 ord 重复为 warning（C5，不阻断）。

import type { DbTx } from "../../db.js";
import { nodeId, WS_ID, type ExpectedNode } from "./backfill.js";
import { MENU_ICONS, type ReconcileReport } from "./reconcile-types.js";

export interface SystemNodeRow {
  id: string;
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  name: string;
  parentId: string | null;
  ord: number;
  path: string;
  depth: number;
  isSystem: number;
  deletedAt: Date | null;
}

/** 计算 C 类菜单差异，写入 report。 */
export async function diffMenu(
  tx: DbTx,
  aliveNodes: SystemNodeRow[],
  expected: ExpectedNode[],
  report: ReconcileReport,
): Promise<void> {
  const menus = await tx.menuItem.findMany();
  const liveMenus = menus.filter((m) => !m.deletedAt);
  const nodeById = new Map(aliveNodes.map((n) => [n.id, n]));

  for (const m of liveMenus) {
    if (m.type === "shortcut") {
      if (!m.nodeId) {
        report.C.push({ code: "C1", message: "shortcut 缺少 nodeId", ref: m.id });
      } else if (!nodeById.has(m.nodeId)) {
        const soft = await tx.navNode.findUnique({ where: { id: m.nodeId }, select: { deletedAt: true } });
        report.C.push({
          code: "C1",
          message: soft?.deletedAt
            ? "shortcut 指向软删节点(soft_dangling)"
            : "shortcut 指向缺失节点(broken)",
          ref: m.id,
        });
      }
    }
    if (m.iconName && !MENU_ICONS.has(m.iconName)) {
      report.C.push({ code: "C3", message: `iconName 不在白名单: ${m.iconName}`, ref: m.id });
    }
  }

  // C2 容器环 / 层级 >2（沿 parentId 向上）。
  const menuById = new Map(liveMenus.map((m) => [m.id, m]));
  for (const m of liveMenus.filter((x) => x.type === "container")) {
    let cur: string | null = m.parentId;
    let depth = 1;
    const seen = new Set<string>([m.id]);
    while (cur) {
      if (seen.has(cur)) { report.C.push({ code: "C2", message: "菜单容器成环", ref: m.id }); break; }
      seen.add(cur);
      depth++;
      cur = menuById.get(cur)?.parentId ?? null;
    }
    if (depth > 2) report.C.push({ code: "C2", message: `容器嵌套 ${depth} 层超过 2 层上限`, ref: m.id });
  }

  // C4 零入口丢失：活 table / 根级活 doc / 活 canvas 至少一条活 shortcut。
  const referenced = new Set(liveMenus.filter((m) => m.type === "shortcut").map((m) => m.nodeId));
  const required = await requiredDefaultShortcuts(tx, expected);
  for (const node of required) {
    if (!referenced.has(node)) {
      report.C.push({ code: "C4", message: `活实体无任何菜单 shortcut（零入口丢失）: ${node}`, ref: node });
    }
  }

  // C5 同父 ord 重复（warning）。
  const ordGroups = new Map<string, number[]>();
  for (const m of liveMenus) {
    const key = m.parentId ?? "__root__";
    const arr = ordGroups.get(key) ?? [];
    arr.push(m.ord);
    ordGroups.set(key, arr);
  }
  for (const [, ords] of ordGroups) {
    if (ords.length !== new Set(ords).size) {
      report.warnings.push({ code: "C5", message: "同父菜单 ord 存在重复（拖拽并发可产生，不阻断）" });
      break;
    }
  }
}

/** 默认菜单必须存在的 shortcut 节点集：活 table、根级活 doc、活 canvas。 */
async function requiredDefaultShortcuts(tx: DbTx, expected: ExpectedNode[]): Promise<string[]> {
  const rootDocs = await tx.kbDoc.findMany({
    where: { deletedAt: null, kind: "doc", parentId: null }, select: { id: true },
  });
  const rootDocNodes = new Set(rootDocs.map((d) => nodeId("doc", d.id)));
  return expected
    .filter((e) => e.kind === "table" || e.kind === "canvas" || (e.kind === "doc" && rootDocNodes.has(e.id)))
    .map((e) => e.id);
}

/** 幂等补齐默认容器与零入口 shortcut；不删除、不动用户自定义项。 */
export async function ensureDefaultMenuTx(
  tx: DbTx,
  expected: ExpectedNode[],
): Promise<{ shortcutAdded: number }> {
  let shortcutAdded = 0;
  await tx.workspace.upsert({
    where: { id: WS_ID }, update: {}, create: { id: WS_ID, name: "默认工作区" },
  });

  const bases = expected.filter((e) => e.kind === "base");
  const kbs = expected.filter((e) => e.kind === "kb");
  for (const b of bases) {
    const containerId = `menu_base_${b.resourceId}`;
    await tx.menuItem.upsert({
      where: { id: containerId },
      update: {},
      create: { id: containerId, workspaceId: WS_ID, type: "container", nodeId: b.id, label: b.name, iconName: "database", ord: b.ord },
    });
  }
  for (const k of kbs) {
    const containerId = `menu_kb_${k.resourceId}`;
    await tx.menuItem.upsert({
      where: { id: containerId },
      update: {},
      create: { id: containerId, workspaceId: WS_ID, type: "container", nodeId: k.id, label: k.name, iconName: "book", ord: k.ord },
    });
  }

  const has = async (nodeIdValue: string) =>
    (await tx.menuItem.count({ where: { workspaceId: WS_ID, type: "shortcut", nodeId: nodeIdValue, deletedAt: null } })) > 0;

  for (const t of expected.filter((e) => e.kind === "table")) {
    if (await has(t.id)) continue;
    await tx.menuItem.create({
      data: { workspaceId: WS_ID, parentId: `menu_base_${(await tx.table.findUniqueOrThrow({ where: { id: t.resourceId }, select: { baseId: true } })).baseId}`,
        type: "shortcut", nodeId: t.id, ord: t.ord },
    });
    shortcutAdded++;
  }
  for (const d of expected.filter((e) => e.kind === "doc" || e.kind === "canvas")) {
    const doc = await tx.kbDoc.findUnique({ where: { id: d.resourceId }, select: { kbId: true, parentId: true, kind: true } });
    if (!doc) continue;
    if (d.kind === "doc" && doc.parentId) continue; // 仅根级 doc 入默认菜单
    if (await has(d.id)) continue;
    await tx.menuItem.create({
      data: { workspaceId: WS_ID, parentId: `menu_kb_${doc.kbId}`, type: "shortcut", nodeId: d.id, ord: d.ord },
    });
    shortcutAdded++;
  }
  return { shortcutAdded };
}

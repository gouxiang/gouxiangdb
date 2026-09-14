// M3 nav 对账：C 类菜单差异计算（C1-C5）。
//
// 分级（2026-09-12 方案 A 裁决，计划 §5.4/§7-S3）：
//  - 阻断（push C）：C1 shortcut broken/soft_dangling；C2 菜单容器环或嵌套 >2；C3 坏图标；
//  - warning（push warnings，--apply 不修、不影响 exit code）：
//      C4 未收纳：活 table/根级活 doc/活 canvas 无任何活 shortcut——这是正常编排态，
//         实体可达性由 nav_nodes 权威树 + 二级"全部"列表保证；零入口全收纳仅约束 S2
//         存量迁移基线（见 M3 计划 §5.4），运行期写点禁止自动写 menu_items；
//      C5 同父菜单 ord 重复（拖拽并发可产生）。
// 其他规则（裁决 4，计划 §5.3）：shortcut.nodeId 真实 FK ON DELETE RESTRICT，资源物理删
// 不联动删菜单；不生成 view shortcut；子文档不挂菜单（文档层级走 nav_nodes 子树）；
// 容器嵌套应用层限 2 层。

import type { DbTx } from "../../db.js";
import { nodeId, type ExpectedNode } from "./backfill.js";
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
        // 节点存在但软删 = soft_dangling：裁决 6 的正常悬挂态（随实体恢复自动还原），
        // shortcut 必须保留、读接口给 state、前端隐藏；不阻断，仅 warning 留痕。
        // 节点行彻底不存在才是 broken（C1 阻断，需 --purge-broken 显式清理）。
        const soft = await tx.navNode.findUnique({ where: { id: m.nodeId }, select: { deletedAt: true } });
        if (soft?.deletedAt) {
          report.warnings.push({ code: "C1S", message: "shortcut 指向软删节点(soft_dangling，正常悬挂态)", ref: m.id });
        } else {
          report.C.push({ code: "C1", message: "shortcut 指向缺失节点(broken)", ref: m.id });
        }
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

  // C4 未收纳（warning，不阻断、--apply 不修）：活 table / 根级活 doc / 活 canvas 无任何活
  // shortcut 是正常编排态，实体经 nav_nodes 权威树与二级"全部"列表可达；运行期禁止自动收纳。
  const referenced = new Set(liveMenus.filter((m) => m.type === "shortcut").map((m) => m.nodeId));
  const required = await requiredDefaultShortcuts(tx, expected);
  for (const node of required) {
    if (!referenced.has(node)) {
      report.warnings.push({ code: "C4", message: `未收纳（可经全部列表到达）: ${node}`, ref: node });
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

/** C4 检查集：活 table、根级活 doc、活 canvas 的节点 id。 */
async function requiredDefaultShortcuts(tx: DbTx, expected: ExpectedNode[]): Promise<string[]> {
  const rootDocs = await tx.kbDoc.findMany({
    where: { deletedAt: null, kind: "doc", parentId: null }, select: { id: true },
  });
  const rootDocNodes = new Set(rootDocs.map((d) => nodeId("doc", d.id)));
  return expected
    .filter((e) => e.kind === "table" || e.kind === "canvas" || (e.kind === "doc" && rootDocNodes.has(e.id)))
    .map((e) => e.id);
}

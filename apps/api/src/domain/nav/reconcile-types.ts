// M3 nav 对账：报告类型与公共常量（计划 §5.4，2026-09-12 方案 A 裁决后分级）。
//
// 只读默认；--apply 修复节点；--purge-broken 才物理清理 broken shortcut/节点。
// 阻断类（非零即 exit 1，--apply 须修复）：A1-A6、B1-B3、C1-C3。
// warning 类（计数报告、不影响 exit code、--apply 不自动修）：
//   C4 未收纳（活 table/根级活 doc/活 canvas 无活 shortcut，正常编排态，可经"全部"列表到达；
//      零入口全收纳仅约束 S2 存量基线）；C5 同父菜单 ord 重复。

import { NAV_ICONS } from "@gx/shared-types";

// 图标白名单单一真源在 shared-types（NAV_ICONS，与 web icons.tsx 镜像）；
// reconcile 以 Set 形态消费。只增不删：新增菜单图标先在 icons.tsx 落地再进 NAV_ICONS。
export const MENU_ICONS = new Set<string>(NAV_ICONS);

interface DiffEntry {
  code: string;
  message: string;
  ref?: string;
}

export interface ReconcileReport {
  A: DiffEntry[]; // 实体 -> 节点（A1-A6，阻断）
  B: DiffEntry[]; // 节点 -> 实体悬挂（B1-B3，阻断）
  C: DiffEntry[]; // 菜单引用阻断项（仅 C1-C3）
  warnings: DiffEntry[]; // C4 未收纳 / C5 ord 重复（不阻断）
  summary: { A: number; B: number; C: number; warnings: number };
}

export function emptyReport(): ReconcileReport {
  return { A: [], B: [], C: [], warnings: [], summary: { A: 0, B: 0, C: 0, warnings: 0 } };
}

export function finalize(r: ReconcileReport): ReconcileReport {
  r.summary = { A: r.A.length, B: r.B.length, C: r.C.length, warnings: r.warnings.length };
  return r;
}

export interface ApplyOptions {
  purgeBroken?: boolean;
}

export interface ApplyResult {
  nodes: { created: number; updated: number; revived: number; pathsRebuilt: number };
  purged: { shortcuts: number; nodes: number };
  softDeleted: { nodes: number; shortcuts: number };
}

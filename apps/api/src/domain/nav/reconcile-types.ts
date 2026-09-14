// M3 nav 对账：报告类型与公共常量（计划 §5.4）。
//
// 只读默认；--apply 修复节点/菜单；--purge-broken 才物理清理 broken shortcut/节点。
// 0 差异：A/B/C 计数全 0（C5 同父 ord 重复为 warning，不阻断）。

// S5 会把图标白名单下沉 shared-types 单一真源；S2/S4 脚本先用与 icons.tsx 对齐的最小集合。
export const MENU_ICONS = new Set(["database", "book", "table", "doc", "canvas", "folder", "folderOpen"]);

export interface DiffEntry {
  code: string;
  message: string;
  ref?: string;
}

export interface ReconcileReport {
  A: DiffEntry[]; // 实体 -> 节点
  B: DiffEntry[]; // 节点 -> 实体悬挂
  C: DiffEntry[]; // 菜单引用
  warnings: DiffEntry[]; // C5 等
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
  menus: { shortcutAdded: number };
  purged: { shortcuts: number; nodes: number };
  softDeleted: { nodes: number; shortcuts: number };
}

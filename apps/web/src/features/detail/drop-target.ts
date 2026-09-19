// apps/web/src/features/detail/drop-target.ts
// 表单设计器落点判定的纯逻辑层（可单测，无 React / 无 DOM 依赖）
//
// 修的缺陷（P2 · 落点高亮与实际落点不一致）：
//   旧代码在**松手之后**才发现「选项卡不能套选项卡」，然后**静默**把落点改写成
//   「顶层末尾新建一行」—— 拖拽过程中高亮明明在选项卡内，松手后字段跑到表单最末尾，
//   没有任何提示。这里把判定提前到「计算落点」那一层，产出 allowed / rejected，
//   高亮渲染与松手处理都消费同一份结论，禁止的落点根本不会被接受。

import type { FieldIdT, FieldType } from "@gx/shared-types";

/** 拖放目标：插到某行（card）、在 rowIndex 处新建一行（gap）、放进选项卡某行（tab）、在选项卡内新建一行（tabLine） */
export type DropTarget =
  | { kind: "row"; rowIndex: number; beforeIndex: number }
  | { kind: "line"; rowIndex: number }
  | { kind: "tab"; containerFieldId: FieldIdT; tabId: string; rowIndex: number; beforeIndex: number }
  | { kind: "tabLine"; containerFieldId: FieldIdT; tabId: string; rowIndex: number };

/** 选项卡类落点的联合类型（带 containerFieldId / tabId） */
export type TabDropTarget = Extract<DropTarget, { kind: "tab" | "tabLine" }>;

/** 落点是否落在某个选项卡容器内（顶层行间带 / 顶层字段卡都属于顶层）。类型守卫，便于调用方直接取 tabId。 */
export function isTabDrop(target: DropTarget | null): target is TabDropTarget {
  return !!target && (target.kind === "tab" || target.kind === "tabLine");
}

/** 落点浅比较用的稳定键：dragover 高频触发时用它判断「落点没变就不重渲染」 */
export function targetKey(t: DropTarget | null): string {
  if (!t) return "";
  if (t.kind === "line") return `line:${t.rowIndex}`;
  if (t.kind === "row") return `row:${t.rowIndex}:${t.beforeIndex}`;
  if (t.kind === "tabLine") return `tabLine:${t.containerFieldId}:${t.tabId}:${t.rowIndex}`;
  return `tab:${t.containerFieldId}:${t.tabId}:${t.rowIndex}:${t.beforeIndex}`;
}

/** 禁放提示文案：用户读到就知道为什么放不进去，而不是看到字段莫名跑到末尾 */
export const TABS_NEST_MESSAGE = "选项卡内不能再放选项卡";

export interface DropVerdict {
  /** true = 可以放；false = 禁放（松手不移动，且高亮渲染为禁放样式） */
  allowed: boolean;
  /** allowed=false 时的可读原因；allowed=true 恒为 null */
  reason: string | null;
}

const ALLOWED: DropVerdict = { allowed: true, reason: null };

/**
 * 判定某个落点能不能放这个字段。
 *
 * 当前唯一约束：选项卡（tabs）容器不能嵌套进选项卡 —— 选项卡是纯视觉容器，
 * 嵌套后渲染层（TabsPanel / tabToRows）会直接丢弃内层容器，字段凭空消失。
 *
 * @param draggingType 正在被拖动的字段类型（从字段库拖出的新字段也传类型）；未知传 null
 * @param target 计算出的落点；null 表示不在任何有效区域内（视为可放，交由调用方兜底）
 */
export function evaluateDrop(
  draggingType: FieldType | null | undefined,
  target: DropTarget | null,
): DropVerdict {
  if (!draggingType || !target) return ALLOWED;
  if (draggingType === "tabs" && isTabDrop(target)) {
    return { allowed: false, reason: TABS_NEST_MESSAGE };
  }
  return ALLOWED;
}

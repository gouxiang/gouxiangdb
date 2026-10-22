// v6 #984 筛选条件 chips 的纯派生层（底板 data-table.html .s-grp/.fchip 993-1001）。
//
// 只做「树 → chip 列表」与「按路径不可变删除」两件事，不改筛选数据结构 / 求值 / 面板。
// 纯函数、不引 React，SSR 单测可直接值断言（与 lib/route-crumb、filterParts 同纪律）。
//
// 嵌套口径（刻意保守，避免嵌套语义风险）：组（and/or/not）只展一层——
//   直属 condition 出「字段 操作符 值」chip；直属子组 / not 出整组 chip（可整体单删，不下钻）；
//   formula 出一个「高级筛选条件」chip（× = 清空全部）。

import type { FieldDTO, FilterNode, FilterCondition } from "@gx/shared-types";
import { operatorsForFieldType, operatorNeedsValue } from "@gx/shared-types";

export interface FilterChip {
  /** 列表 key（kind+path，唯一稳定）。 */
  key: string;
  /** 删除路径：根直属节点为 [i]；formula 固定 [0]。 */
  path: number[];
  label: string;
  opLabel?: string;
  valueText?: string;
  kind: "cond" | "group" | "formula";
  /** formula chip 的 × 语义是清空全部筛选（而非删一个节点）。 */
  clearAll?: boolean;
}

function isGroup(node: FilterNode): node is Extract<FilterNode, { kind: "and" | "or" }> {
  return node.kind === "and" || node.kind === "or";
}

/** 统计一棵子树里的叶子条件数（chip 上「条件组（N 项）」用）。 */
export function countLeafConditions(node: FilterNode): number {
  if (node.kind === "condition" || node.kind === "formula") return 1;
  if (node.kind === "not") return countLeafConditions(node.child);
  return node.children.reduce<number>((s, c) => s + countLeafConditions(c), 0);
}

function fieldName(fields: FieldDTO[], id: string): string {
  return fields.find((f) => f.id === id)?.name ?? "未命名字段";
}

function conditionText(
  cond: FilterCondition,
  fields: FieldDTO[],
): Pick<FilterChip, "label" | "opLabel" | "valueText"> {
  const field = fields.find((f) => f.id === cond.fieldId);
  const label = field?.name ?? "未命名字段";
  const type = field?.type ?? "text";
  const opLabel = operatorsForFieldType(type).find((o) => o.id === cond.op)?.label ?? "";

  let valueText: string | undefined;
  if (cond.valueType === "dynamic") {
    // 当前唯一动态变量是 currentUser
    valueText = "当前登录用户";
  } else if (cond.valueType === "field") {
    valueText = cond.valueFieldId ? fieldName(fields, cond.valueFieldId) : "另一字段";
  } else if (operatorNeedsValue(cond.op)) {
    const raw = (cond.value ?? "").trim();
    if (!raw) {
      valueText = undefined;
    } else if ((type === "singleSelect" || type === "multiSelect") && field?.options) {
      // 多选筛选值是逗号分隔的 option.id；单选同口径（见 filterParts ValueInput 注释）。
      // 逐个映射选项名，找不到的 id 原样兜底，不丢信息。
      const ids = type === "multiSelect" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw];
      const names = ids.map((id) => field.options!.find((o) => o.id === id)?.name ?? id);
      valueText = names.join("、");
    } else {
      valueText = cond.value;
    }
  }
  return { label, opLabel, valueText };
}

/**
 * 过滤树 → 顶层 chips。
 * null → []；formula 根 → 单个 formula chip；and/or 根只展直属一层。
 */
export function deriveFilterChips(node: FilterNode | null, fields: FieldDTO[]): FilterChip[] {
  if (!node) return [];
  if (node.kind === "formula") {
    return [{ key: "formula-0", path: [0], kind: "formula", label: "高级筛选条件", clearAll: true }];
  }
  if (node.kind === "not") {
    // 根就是 not：按一个整组 chip 处理（path [0] 经 removeFilterCondition 归一为清空）。
    return [{ key: "not-0", path: [0], kind: "group", label: "排除条件" }];
  }
  if (node.kind === "condition") {
    // 理论上 UI 总写组根，单条件根做防御性渲染。
    return [{ key: "cond-0", path: [0], kind: "cond", ...conditionText(node, fields) }];
  }

  const chips: FilterChip[] = [];
  node.children.forEach((child, i) => {
    if (child.kind === "condition") {
      chips.push({ key: `cond-${i}`, path: [i], kind: "cond", ...conditionText(child, fields) });
    } else if (child.kind === "not") {
      chips.push({ key: `not-${i}`, path: [i], kind: "group", label: "排除条件" });
    } else if (child.kind === "formula") {
      // 组内公式节点也按整组 chip 删除（不展平），文案标明是高级条件。
      chips.push({ key: `formula-${i}`, path: [i], kind: "group", label: "高级筛选条件" });
    } else {
      chips.push({
        key: `group-${i}`,
        path: [i],
        kind: "group",
        label: `条件组（${countLeafConditions(child)} 项）`,
      });
    }
  });
  return chips;
}

/** 组节点删除一个直属子节点后的归一（空 and → null）。 */
function removeChild(group: Extract<FilterNode, { kind: "and" | "or" }>, index: number): FilterNode | null {
  const children = group.children.filter((_, i) => i !== index);
  // 口径照 filterParts.tsx updateRoot：children.length>0 || kind!=="and" 才保留。
  if (children.length === 0 && group.kind === "and") return null;
  return { ...group, children };
}

/**
 * 按索引路径不可变删除筛选节点。
 * chips 只产一层 path（删根直属条件/子组）；更深路径做防御性下钻，契约完整但当前 UI 不产生。
 * 删后空 and 根归一 null（与 filterParts.tsx:92 同口径）；绝不原地改入参。
 */
export function removeFilterCondition(node: FilterNode | null, path: number[]): FilterNode | null {
  if (!node || path.length === 0) return node;
  const [head, ...rest] = path;

  // 非组根（formula / 单条件 / not 根）：顶层删除即整棵清空。
  if (node.kind === "formula" || node.kind === "condition" || node.kind === "not") {
    return null;
  }
  if (rest.length === 0) {
    return removeChild(node, head);
  }

  // 深层：路径必须落在组 / not 上，否则路径非法，原样返回不毁数据。
  const target = node.children[head];
  if (!target) return node;
  if (target.kind === "not") {
    const inner = removeFilterCondition(target.child, rest);
    const children = inner
      ? node.children.map((c, i) => (i === head ? ({ kind: "not", child: inner } as FilterNode) : c))
      : node.children.filter((_, i) => i !== head);
    if (children.length === 0 && node.kind === "and") return null;
    return { ...node, children };
  }
  if (isGroup(target)) {
    const inner = removeFilterCondition(target, rest);
    const children = inner
      ? node.children.map((c, i) => (i === head ? inner : c))
      : node.children.filter((_, i) => i !== head);
    if (children.length === 0 && node.kind === "and") return null;
    return { ...node, children };
  }
  return node;
}

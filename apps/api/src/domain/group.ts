// apps/api/src/domain/group.ts
// 分组引擎（v1 Features/Grid/GridGrouping.swift TS 同构）
//
// 分组键规则：
//   singleSelect → 按选项分组，保留选项顺序与颜色
//   checkbox     → 「已勾选」/「未勾选」
//   multiSelect  → 一条记录可出现在多个桶（按每个选项）
//   links        → 按每条关联记录的 title 分组
//   其余         → 文本化后的值；空值归入「(空白)」

import type { GroupBucket } from "@gx/shared-types";
import { toComparableText } from "./filter.js";

export const EMPTY_GROUP_KEY = "__empty__";
export const EMPTY_GROUP_LABEL = "(空白)";

export interface GroupInput {
  recordIds: string[];
  get: (recordId: string, fieldId: string) => unknown;
}

export interface GroupFieldInfo {
  id: string;
  type: string;
  options?: { id: string; name: string; color: string }[] | null;
}

function optionColor(info: GroupFieldInfo, name: string): string | null {
  const opt = info.options?.find((o) => o.name === name);
  return opt?.color ?? null;
}

/**
 * 计算分组桶。返回按「字段选项顺序 → 其余按出现顺序」排列的桶。
 */
export function computeGroups(
  input: GroupInput,
  field: GroupFieldInfo,
  aggregator: (recordIds: string[]) => Record<string, number | null>,
): GroupBucket[] {
  const buckets = new Map<string, { label: string; color: string | null; ids: string[]; seq: number }>();
  let seq = 0;

  const push = (key: string, label: string, color: string | null, id: string) => {
    const b = buckets.get(key);
    if (b) {
      if (!b.ids.includes(id)) b.ids.push(id);
    } else {
      buckets.set(key, { label, color, ids: [id], seq: seq++ });
    }
  };

  for (const rid of input.recordIds) {
    const v = input.get(rid, field.id);

    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
      push(EMPTY_GROUP_KEY, EMPTY_GROUP_LABEL, null, rid);
      continue;
    }

    if (field.type === "checkbox") {
      const on = v === true || v === 1 || String(v) === "true";
      push(on ? "true" : "false", on ? "已勾选" : "未勾选", on ? "#1D9E75" : "#888780", rid);
      continue;
    }

    if (field.type === "multiSelect" && Array.isArray(v)) {
      for (const item of v as string[]) {
        push(`opt:${item}`, String(item), optionColor(field, String(item)), rid);
      }
      continue;
    }

    if (field.type === "links" && Array.isArray(v)) {
      const refs = v as { tableId: string; recordId: string; title: string }[];
      if (refs.length === 0) {
        push(EMPTY_GROUP_KEY, EMPTY_GROUP_LABEL, null, rid);
        continue;
      }
      for (const r of refs) {
        push(`link:${r.recordId}`, r.title, "#0F6E56", rid);
      }
      continue;
    }

    const text = toComparableText(v);
    push(`val:${text}`, text, optionColor(field, text), rid);
  }

  // 排序：单选按 options 顺序，其余按出现顺序（seq），空白桶永远最后
  let ordered: { key: string; b: { label: string; color: string | null; ids: string[]; seq: number } }[];
  const arr = [...buckets.entries()].map(([key, b]) => ({ key, b }));
  if (field.type === "singleSelect" && field.options?.length) {
    const rank = new Map(field.options.map((o, i) => [o.name, i]));
    ordered = arr.sort((x, y) => {
      if (x.key === EMPTY_GROUP_KEY) return 1;
      if (y.key === EMPTY_GROUP_KEY) return -1;
      const rx = rank.get(x.b.label) ?? 999;
      const ry = rank.get(y.b.label) ?? 999;
      return rx - ry;
    });
  } else if (field.type === "checkbox") {
    ordered = arr.sort((x, y) => (x.key === "true" ? -1 : y.key === "true" ? 1 : 0));
  } else {
    ordered = arr.sort((x, y) => {
      if (x.key === EMPTY_GROUP_KEY) return 1;
      if (y.key === EMPTY_GROUP_KEY) return -1;
      return x.b.seq - y.b.seq;
    });
  }

  return ordered.map(({ key, b }) => ({
    key,
    label: b.label,
    color: b.color,
    recordIds: b.ids,
    aggregations: aggregator(b.ids),
  }));
}

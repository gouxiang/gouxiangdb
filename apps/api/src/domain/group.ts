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

type GroupOption = NonNullable<GroupFieldInfo["options"]>[number];

/**
 * 按存储值找选项：**id 优先、name 兜底**。
 * 选择类字段的落库值是选项 id（如 opt_xxx），但历史数据里也可能已经存了选项名，
 * 故两路都认；两路都不命中返回 null（调用方按原值退化成文本，绝不崩）。
 */
function resolveOption(info: GroupFieldInfo, value: string): GroupOption | null {
  const opts = info.options;
  if (!opts || opts.length === 0) return null;
  return opts.find((o) => o.id === value) ?? opts.find((o) => o.name === value) ?? null;
}

function optionColor(info: GroupFieldInfo, value: string): string | null {
  return resolveOption(info, value)?.color ?? null;
}

/** 选择类字段的分组三元组：key/label/color 全部由解析出的选项派生。 */
function selectTriple(info: GroupFieldInfo, raw: string): { key: string; label: string; color: string | null } {
  const opt = resolveOption(info, raw);
  return { key: `opt:${opt?.id ?? raw}`, label: opt?.name ?? raw, color: opt?.color ?? null };
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

    // singleSelect：存储值是选项 id，必须先按选项解析出「名称 + 颜色」再建桶，
    // 否则分组标题会是 opt_xxx 且颜色圆点恒空（走兜底分支的后果）。
    if (field.type === "singleSelect") {
      const t = selectTriple(field, String(v));
      push(t.key, t.label, t.color, rid);
      continue;
    }

    if (field.type === "multiSelect" && Array.isArray(v)) {
      for (const item of v as unknown[]) {
        const t = selectTriple(field, String(item));
        push(t.key, t.label, t.color, rid);
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
    // rank 同时容纳 id 与 name（键可能是 "opt:<id>"，也可能是解析失败时的 "opt:<原值>"，
    // 而原值在历史数据里可能是选项名），保证两种落库形态都按 options 顺序排。
    const rank = new Map<string, number>();
    field.options.forEach((o, i) => {
      rank.set(o.id, i);
      rank.set(o.name, i);
    });
    const optionRank = (key: string, label: string): number => {
      const raw = key.startsWith("opt:") ? key.slice("opt:".length) : label;
      return rank.get(raw) ?? rank.get(label) ?? 999;
    };
    ordered = arr.sort((x, y) => {
      if (x.key === EMPTY_GROUP_KEY) return 1;
      if (y.key === EMPTY_GROUP_KEY) return -1;
      const rx = optionRank(x.key, x.b.label);
      const ry = optionRank(y.key, y.b.label);
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

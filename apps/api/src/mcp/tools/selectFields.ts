// MCP 出口的「选择类字段可读化」纯函数层（M7 真机缺陷：optionId 泄漏到服务端出口）。
//
// 纪律：
//   1. **不改 fields 语义**——存储值恒为选项 id，写工具（record.update_record）依赖回传 id，
//      一旦把 fields 换成名称就会破坏回写；故本文件只产生**附加**的可读镜像。
//   2. 未知 id / 已删除选项：原值透传，绝不抛错、绝不臆造名称（客户端可据此识别脏数据）。
//   3. 纯函数、零 IO，供 record.tools 与 table.tools 共用，单测直接覆盖。

import type { FieldMeta } from "../../domain/types.js";

/** 值域由选项定义的字段类型（其落库值为选项 id 或选项名）。 */
export const SELECT_FIELD_TYPES = new Set(["singleSelect", "multiSelect"]);

/**
 * 字段 id → 「候选 key → 选项名」映射，候选 key 同时容纳**选项 id 与选项名**
 * （历史数据里可能已经落库了选项名，两路都要可读）。
 */
export type SelectDisplayIndex = Map<string, Map<string, string>>;

/** 建索引只需这三个键，放宽入参类型便于上层传部分构造的字段对象（含单测夹具）。 */
export type SelectFieldLike = Pick<FieldMeta, "id" | "type" | "options">;

/**
 * 按可见字段集建立 id→名索引；表内没有选择类字段时返回 null
 * ——调用方据此**完全不输出** fieldsDisplay（避免无选择列时的无效膨胀）。
 */
export function indexSelectOptions(fields: readonly SelectFieldLike[]): SelectDisplayIndex | null {
  const index: SelectDisplayIndex = new Map();
  for (const f of fields) {
    if (!SELECT_FIELD_TYPES.has(f.type)) continue;
    const opts = f.options;
    if (!opts || opts.length === 0) continue;
    const byKey = new Map<string, string>();
    for (const o of opts) {
      byKey.set(o.id, o.name);
      byKey.set(o.name, o.name);
    }
    index.set(f.id, byKey);
  }
  return index.size > 0 ? index : null;
}

/** 把单个值按映射换成选项名；数组逐项换。未命中返回原值（含原值本身不是字符串的情形）。 */
export function displaySelectValue(value: unknown, byKey: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => byKey.get(String(item)) ?? item);
  return byKey.get(String(value)) ?? value;
}

/** get_schema 的字段元数据投影：选择类字段附 options，其余字段不带该键。 */
export function withSelectOptions<T extends SelectFieldLike>(
  field: T,
  base: Record<string, unknown>,
): Record<string, unknown> {
  if (!SELECT_FIELD_TYPES.has(field.type)) return base;
  const opts = field.options ?? [];
  return { ...base, options: opts.map((o) => ({ id: o.id, name: o.name, color: o.color })) };
}

// apps/api/src/domain/authz/fieldScope.ts
// 「字段权限」在读出口的落地——与 libraryPolicy 共用同一份裁决（role_library_scope.config.fields），
// 不引入第二套判断口径。
//
// 为什么需要这一层：写侧早已收口（libraryPolicy.fieldWriteGate 在事务前挡掉仅可见/隐藏字段的写入），
// 但读侧此前没有任何一处读 config.fields —— 管理员把字段配成「隐藏」后，列表/详情照样把它吐出来，
// 等于一个配了不生效的死开关。本模块补上读侧，让三档语义闭合：
//   editable —— 可读可写；
//   visible  —— 可读不可写（写侧已挡）；
//   hidden   —— 不可读也不可写：从出口【整体缺席】。
//
// 刻意不采用「置空」：置空等于承认"这里有个字段，只是不给你看"，隐藏的意图（连存在性都不暴露）
// 会落空；且前端拿空值仍会渲染表头。
//
// 零变化承诺：该表一条 hidden 都没配时 active=false，调用方必须走原路径——
// 不动字段数组、不脱敏视图配置、不重写记录，响应与加本模块前逐字节一致。

import type { LibraryAccessDTO } from "@gx/shared-types";
import { fieldAccessOf } from "./libraryPolicy.js";

/** 一张表对某人的字段读侧视野。 */
export interface FieldScope<T> {
  /** active=true 时为「去掉 hidden」的新数组；active=false 时是入参同一引用（不复制）。 */
  fields: T[];
  /** 允许出现的字段 id 集（active 时用于视图配置脱敏）。 */
  visibleIds: ReadonlySet<string>;
  /** 被隐藏的字段 id；active=false 时为空集。 */
  hiddenIds: ReadonlySet<string>;
  /** 该表是否配了至少一个 hidden。false 时调用方一律走原路径。 */
  active: boolean;
}

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * 计算该表对某人的字段读侧视野。
 * @param access 守卫已算好的库裁决（requireCanView 的返回值里就有，不额外查库）
 * @param tableId 表实体 id
 * @param fields loadTableFields 得到的全字段定义
 */
export function fieldScopeOf<T extends { id: string }>(
  access: LibraryAccessDTO | null | undefined,
  tableId: string,
  fields: T[],
): FieldScope<T> {
  if (!access) return { fields, visibleIds: NONE, hiddenIds: NONE, active: false };

  // 先扫一遍判断是否真的配了 hidden：绝大多数表一条都没配，这里短路后
  // 调用方不复制数组、不重写记录、不脱敏配置（零分配、零行为变化）。
  const hiddenIds = new Set<string>();
  for (const f of fields) if (fieldAccessOf(access, tableId, f.id) === "hidden") hiddenIds.add(f.id);
  if (hiddenIds.size === 0) return { fields, visibleIds: NONE, hiddenIds: NONE, active: false };

  const visibleIds = new Set<string>();
  const kept: T[] = [];
  for (const f of fields) {
    if (hiddenIds.has(f.id)) continue;
    visibleIds.add(f.id);
    kept.push(f);
  }
  return { fields: kept, visibleIds, hiddenIds, active: true };
}

/** 抹掉被隐藏字段的键（返回新对象；hiddenIds 为空时原样返回入参）。 */
export function stripHiddenKeys<V extends Record<string, unknown>>(
  values: V,
  hiddenIds: ReadonlySet<string>,
): V {
  if (hiddenIds.size === 0) return values;
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (hiddenIds.has(k)) { touched = true; continue; }
    out[k] = v;
  }
  return (touched ? out : values) as V;
}

/** 批量抹键（列表出口用）。hiddenIds 为空时返回入参同一引用。 */
export function stripHiddenFromRecords<R extends { fields: Record<string, unknown> }>(
  records: readonly R[],
  hiddenIds: ReadonlySet<string>,
): R[] {
  if (hiddenIds.size === 0) return records as R[];
  return records.map((r) => ({ ...r, fields: stripHiddenKeys(r.fields, hiddenIds) }));
}

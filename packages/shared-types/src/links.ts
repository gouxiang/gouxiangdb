// packages/shared-types/src/links.ts
// 关联值引用（从 v1 GXLinkRef 1:1 移植）
// v1 是结构化 [GXLinkRef{tableId,recordId,title}]
// v2 保留结构化，便于 hydration 现算

import type { TableIdT, RecordIdT } from "./ids.js";

export interface LinkRef {
  readonly tableId: TableIdT;
  readonly recordId: RecordIdT;
  readonly title: string; // 关联记录的显示字段值（hydration 时现算）
}

// 兼容旧版本（v1 早期是 [string] 数组）
export type LinkValue = readonly LinkRef[] | readonly string[];

export function isStructuredLinks(
  v: LinkValue | undefined,
): v is readonly LinkRef[] {
  if (!v || v.length === 0) return false;
  const first = v[0];
  return typeof first === "object" && first !== null && "tableId" in first;
}

// 提取关联记录 ID 集合（用于跨表查询）
export function linkRecordIds(v: LinkValue | undefined): readonly RecordIdT[] {
  if (!v) return [];
  if (isStructuredLinks(v)) {
    return v.map((r) => r.recordId);
  }
  // 旧字符串格式直接当 recordId
  return v as readonly RecordIdT[];
}
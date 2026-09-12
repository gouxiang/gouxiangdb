// M1/S0 characterization 共享夹具：queryRecords 的内存字段/行定义（不含 vi.mock）

import type { FieldMeta } from "../../types.js";

export const T1 = "T1";

export function field(
  p: Partial<FieldMeta> & Pick<FieldMeta, "id" | "name" | "type" | "order">,
): FieldMeta {
  return {
    tableId: T1,
    description: "",
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    recordFilter: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...p,
  } as FieldMeta;
}

export const F_NAME = field({ id: "f_name", name: "名称", type: "singleLineText", order: 0 });
export const F_AGE = field({ id: "f_age", name: "年龄", type: "number", order: 1, precision: 0 });
export const F_STATUS = field({
  id: "f_status",
  name: "状态",
  type: "singleSelect",
  order: 2,
  options: [
    { id: "s_todo", name: "待办", color: "#FF0000" },
    { id: "s_done", name: "完成", color: "#00FF00" },
  ],
});
export const F_TAGS = field({
  id: "f_tags",
  name: "标签",
  type: "multiSelect",
  order: 3,
  options: [
    { id: "t_a", name: "标签A", color: "#111111" },
    { id: "t_b", name: "标签B", color: "#222222" },
  ],
});
export const F_CHECK = field({ id: "f_check", name: "勾选", type: "checkbox", order: 4 });

export const FIELDS: FieldMeta[] = [F_NAME, F_AGE, F_STATUS, F_TAGS, F_CHECK];

export interface FakeRow {
  id: string;
  tableId: string;
  fields: Record<string, unknown> | string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: Date | null;
}

export function row(
  id: string,
  fields: Record<string, unknown>,
  createdAt: string,
  deletedAt: string | null = null,
): FakeRow {
  const t = new Date(createdAt);
  return {
    id,
    tableId: T1,
    fields,
    createdAt: t,
    updatedAt: t,
    createdBy: null,
    updatedBy: null,
    deletedAt: deletedAt ? new Date(deletedAt) : null,
  };
}

/** 标准四活行 + 一软删行（给定顺序刻意打乱，验证 DB 层排序） */
export function standardRows(): FakeRow[] {
  return [
    row("r3", { f_name: "丙", f_age: 30, f_status: "s_done", f_tags: ["t_b"], f_check: true }, "2026-03-03T00:00:00Z"),
    row("r1", { f_name: "甲", f_age: 10, f_status: "s_todo", f_tags: ["t_a", "t_b"], f_check: false }, "2026-01-01T00:00:00Z"),
    row("r2", { f_name: "乙", f_age: 20, f_status: "s_todo", f_tags: [], f_check: true }, "2026-02-01T00:00:00Z"),
    row("r4", { f_name: "丁", f_age: null, f_status: null, f_tags: null, f_check: false }, "2026-04-01T00:00:00Z"),
    row("r9", { f_name: "已删", f_age: 99, f_status: "s_done", f_tags: [], f_check: true }, "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z"),
  ];
}

/** 镜像 prisma record.findMany：tableId + deletedAt:null 过滤，(createdAt,id) 升序 */
export function recordFindMany(rows: FakeRow[], args: { where?: { tableId?: string; deletedAt?: unknown } }) {
  const where = args.where ?? {};
  const filterDeleted = "deletedAt" in where;
  const out = rows
    .filter(
      (r) =>
        (!where.tableId || r.tableId === where.tableId) &&
        (!filterDeleted || where.deletedAt === null ? r.deletedAt === null : true),
    )
    .map((r) => ({ ...r }));
  out.sort((a, b) => {
    const ca = a.createdAt.getTime();
    const cb = b.createdAt.getTime();
    return ca !== cb ? ca - cb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return Promise.resolve(out);
}

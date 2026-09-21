// 嵌入数据表预览的只读/可编辑分档回归（硬约束）：
//   canEdit=false → 纯只读：预览区**不得出现任何编辑入口**（无新增、无删除、单元格不可点开编辑）
//   canEdit=true  → 才允许增删改
// 生效写权限取「调用方裁决 ∧ 后端响应」(fail-closed)：任一侧只读即只读。

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";

const h = vi.hoisted(() => ({
  serverCanEdit: false as boolean | null,
}));

function field(id: string, name: string, order: number): FieldDTO {
  return {
    id,
    tableId: "tbl1",
    name,
    type: "singleLineText",
    description: "",
    order,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
  } as unknown as FieldDTO;
}

const FIELDS = [field("f1", "客户", 0), field("f2", "城市", 1)];
const RECORDS: RecordDTO[] = [
  {
    id: "r1",
    tableId: "tbl1",
    fields: { f1: "张三", f2: "深圳" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdBy: "u1",
    updatedBy: "u1",
  } as unknown as RecordDTO,
];

vi.mock("../table-embed-data", () => ({
  EMBED_PAGE_LIMIT: 50,
  cellValueOf: (rec: RecordDTO, fieldId: string) => rec.fields?.[fieldId] ?? null,
  useEmbedWrites: () => ({
    create: async () => undefined,
    update: async () => undefined,
    remove: async () => undefined,
  }),
  useEmbedTable: () => ({
    title: "客户台账",
    viewName: "看板",
    fields: FIELDS,
    allFields: FIELDS,
    records: RECORDS,
    total: 1,
    filteredTotal: 1,
    serverCanEdit: h.serverCanEdit,
    degraded: false,
    isLoading: false,
    isError: false,
  }),
}));

import { TableEmbedPreview } from "../TableEmbedPreview";

function render(canEdit: boolean) {
  return renderToString(
    <TableEmbedPreview tableId="tbl1" publicToken="tok" canEdit={canEdit} fallbackTitle="客户台账" />,
  );
}

describe("TableEmbedPreview：编辑入口按档位出现", () => {
  it("canEdit=false → 没有任何编辑入口，但记录照常可见", () => {
    h.serverCanEdit = false;
    const html = render(false);
    expect(html).toContain("张三");
    expect(html).toContain("深圳");
    expect(html).toContain("只读");
    // 三个编辑入口一个都不能有
    expect(html).not.toContain("新增记录");
    expect(html).not.toContain("删除记录");
    // 只读态下整块预览不应出现任何 button（单元格不可点开编辑、无操作按钮）
    expect(html).not.toContain("<button");
  });

  it("canEdit=true 且后端允许 → 三个编辑入口都在", () => {
    h.serverCanEdit = true;
    const html = render(true);
    expect(html).toContain("新增记录");
    expect(html).toContain("删除记录");
    expect(html).not.toContain("只读");
  });

  it("fail-closed：调用方说可编辑、后端说只读 → 仍然只读", () => {
    h.serverCanEdit = false;
    const html = render(true);
    expect(html).not.toContain("新增记录");
    expect(html).not.toContain("删除记录");
  });
});

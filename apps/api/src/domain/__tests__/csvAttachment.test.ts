// apps/api/src/domain/__tests__/csvAttachment.test.ts
// CSV 导出附件列：附件单元格 {id,name,size,mime,url}[] 必须导出为文件名，
// 多值 "; " 连接，绝不能落进通用 links 分支变 [object Object]。纯函数单测，无 DB。

import { describe, it, expect } from "vitest";
import { recordToRow, recordsToCSV } from "../csv.js";
import type { FieldMeta, HydratedRecord } from "../types.js";

function field(over: Partial<FieldMeta> & Pick<FieldMeta, "id" | "type">): FieldMeta {
  return {
    tableId: "t1",
    name: over.id,
    description: "",
    order: 0,
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
    ...over,
  };
}

function record(fields: HydratedRecord["fields"]): HydratedRecord {
  return {
    id: "r1",
    tableId: "t1",
    fields,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    createdBy: "u1",
    updatedBy: "u1",
  };
}

const att = (name: string) => ({ id: `id-${name}`, name, size: 10, mime: "text/plain", url: `u-${name}` });

describe("recordToRow 附件列导出文件名", () => {
  const f = field({ id: "files", name: "附件", type: "attachment" });

  it("单附件导出文件名，不含 [object Object]", () => {
    const [cell] = recordToRow(record({ files: [att("合同.pdf")] }), [f]);
    expect(cell).toBe("合同.pdf");
    expect(cell).not.toContain("[object Object]");
  });

  it("多附件用 '; ' 连接文件名", () => {
    const [cell] = recordToRow(record({ files: [att("a.pdf"), att("b.png"), att("c.docx")] }), [f]);
    expect(cell).toBe("a.pdf; b.png; c.docx");
  });

  it("过滤空名元素；非对象/无 name 元素不产生 [object Object]", () => {
    const [cell] = recordToRow(
      record({ files: [att("ok.txt"), { id: "x", name: "  ", size: 1, mime: "", url: "" }] }),
      [f],
    );
    expect(cell).toBe("ok.txt");
  });

  it("空数组导出空串", () => {
    const [cell] = recordToRow(record({ files: [] }), [f]);
    expect(cell).toBe("");
  });

  it("完整 CSV 输出附件列为文件名（含表头，无 [object Object]）", () => {
    const csv = recordsToCSV([record({ files: [att("一.pdf"), att("二.xlsx")] })], [f]);
    expect(csv).toContain("一.pdf; 二.xlsx");
    expect(csv).not.toContain("[object Object]");
  });
});

describe("recordToRow 附件专支不影响既有分支", () => {
  it("links 字段仍按 title 导出（无 title 回落 String）", () => {
    const lf = field({ id: "links", name: "关联", type: "links" });
    const [cell] = recordToRow(
      record({ links: [{ tableId: "t2", recordId: "r2", title: "关联标题" }] }),
      [lf],
    );
    expect(cell).toBe("关联标题");
  });

  it("multiSelect 仍映射选项名并 '; ' 连接", () => {
    const mf = field({
      id: "ms",
      name: "多选",
      type: "multiSelect",
      options: [
        { id: "o1", name: "选项甲", color: "blue" },
        { id: "o2", name: "选项乙", color: "red" },
      ] as FieldMeta["options"],
    });
    const [cell] = recordToRow(record({ ms: ["o1", "o2"] }), [mf]);
    expect(cell).toBe("选项甲; 选项乙");
  });
});

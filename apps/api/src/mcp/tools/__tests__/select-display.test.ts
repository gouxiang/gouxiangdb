// M7 真机缺陷回归：MCP 只读出口必须让外部 AI 客户端【看得懂】选择类字段。
//
// 契约（双键方案）：
//   - fields 里的 singleSelect/multiSelect 值**维持选项 id**（写工具 record.update_record 回写依赖它）；
//   - 同记录增补 fieldsDisplay：选择类字段换成选项名，其余字段原样；
//   - 表内无选择类字段时完全不输出 fieldsDisplay（避免无谓膨胀）；
//   - table.get_schema 给选择类字段附 options:[{id,name,color}]，客户端可自行映射；
//   - 未知 id（已删选项/脏数据）在 fieldsDisplay 里原样保留，不臆造名称、不抛错。

import { describe, expect, it, vi } from "vitest";
import type { FieldMeta } from "../../../domain/types.js";
import type { McpPermissionPort } from "../../permissions/types.js";
import type { ToolCtx } from "../types.js";

const OPTIONS = [
  { id: "opt_todo", name: "待办", color: "#B58900" },
  { id: "opt_doing", name: "进行中", color: "#2684FF" },
];

/** vi.mock 工厂被提升，故被工厂闭包引用的状态必须由 hoisted 创建。 */
const store = vi.hoisted(() => ({
  fields: [] as unknown[],
  rows: [] as unknown[],
}));

const FIELD_STUBS = {
  name: { id: "f_name", name: "名称", type: "singleLineText", options: null },
  status: { id: "f_status", name: "状态", type: "singleSelect", options: OPTIONS },
  tags: { id: "f_tags", name: "标签", type: "multiSelect", options: OPTIONS },
};

store.fields = [FIELD_STUBS.name, FIELD_STUBS.status, FIELD_STUBS.tags];
store.rows = [
  { id: "rec1", fields: { f_name: "甲", f_status: "opt_doing", f_tags: ["opt_doing", "opt_todo"] } },
  { id: "rec2", fields: { f_name: "乙", f_status: "opt_ghost" } },
];

vi.mock("../../../domain/recordService.js", () => ({
  loadTableFields: vi.fn(async () => store.fields as FieldMeta[]),
  parseViewConfig: vi.fn(() => ({})),
  queryRecords: vi.fn(async () => ({
    records: store.rows, total: store.rows.length, filteredTotal: store.rows.length,
    nextCursor: null, hasMore: false,
  })),
}));
vi.mock("../../../domain/mcpSearchBridge.js", () => ({ runMcpUnifiedSearch: vi.fn() }));
vi.mock("../../../domain/mcpReadModels.js", () => ({
  recordBriefById: vi.fn(async () => ({ id: "rec1", tableId: "t1", deletedAt: null })),
  listBasesByIds: vi.fn(async () => []),
  listTablesUnderBases: vi.fn(async () => [{ id: "t1", name: "表一" }]),
}));
vi.mock("../../../domain/recordWrite.js", () => ({
  createRecordTx: vi.fn(), updateRecordTx: vi.fn(), softDeleteRecordTx: vi.fn(),
}));
vi.mock("../../../domain/defaults.js", () => ({
  applyCreateDefaults: vi.fn(), applyEditDefaults: vi.fn(), applyReverseDefaultsForChild: vi.fn(),
}));
vi.mock("../../../db.js", () => ({ withWriteTx: vi.fn(), runWrite: vi.fn() }));

import { recordListRecords, recordQueryRecords } from "../record.tools.js";
import { tableGetSchema } from "../table.tools.js";

function portWith(visibleFields: string[] | null): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(async () => ({ byKind: { base: ["b1"], table: ["t1"] }, truncated: false })),
    can: vi.fn(async () => true),
    fieldCapability: vi.fn(),
    fieldCapabilityOf: vi.fn(async () => ({
      visible: true, visibleAll: visibleFields === null, visibleFields, writableAll: true,
    })),
    writeFieldCapabilityOf: vi.fn(async () => ({ matched: true, writableAll: true, writableFields: [] })),
  };
}

const ctxWith = (visibleFields: string[] | null): ToolCtx => ({
  subject: { userId: "u1", patId: "p1", scopes: ["record:read"] as never },
  port: portWith(visibleFields),
});

interface OutRecord {
  fields: Record<string, unknown>;
  fieldsDisplay?: Record<string, unknown>;
}

async function readRecords(
  tool: typeof recordListRecords,
  visibleFields: string[] | null = null,
): Promise<OutRecord[]> {
  const r = await tool(ctxWith(visibleFields), { tableId: "t1", limit: 10 });
  expect(r.isError).toBeUndefined();
  const payload = JSON.parse(r.content[0]!.text) as { records: OutRecord[] };
  return payload.records;
}

describe("record.list_records / query_records 的 fieldsDisplay", () => {
  it("fields 仍是选项 id（写入契约不回归），fieldsDisplay 是选项名", async () => {
    for (const tool of [recordListRecords, recordQueryRecords]) {
      const rows = await readRecords(tool);
      // fields：保持可回写的原始 id
      expect(rows[0]!.fields.f_status).toBe("opt_doing");
      // fieldsDisplay：外部客户端可读的名称
      expect(rows[0]!.fieldsDisplay).toEqual({
        f_name: "甲", f_status: "进行中", f_tags: ["进行中", "待办"],
      });
    }
  });

  it("未知 optionId 在 fieldsDisplay 里原样保留，不臆造名称、不抛错", async () => {
    const rows = await readRecords(recordListRecords);
    expect(rows[1]!.fieldsDisplay!.f_status).toBe("opt_ghost");
    expect(rows[1]!.fields.f_status).toBe("opt_ghost");
  });

  it("表内无选择类字段时完全不输出 fieldsDisplay 键（避免膨胀）", async () => {
    store.fields = [FIELD_STUBS.name];
    try {
      const rows = await readRecords(recordListRecords);
      for (const row of rows) expect("fieldsDisplay" in row).toBe(false);
      expect(rows[0]!.fields.f_name).toBe("甲");
    } finally {
      store.fields = [FIELD_STUBS.name, FIELD_STUBS.status, FIELD_STUBS.tags];
    }
  });

  it("掩码下 fieldsDisplay 与 fields 同步裁剪（不含不可见字段）", async () => {
    const rows = await readRecords(recordListRecords, ["f_name", "f_status"]);
    expect(Object.keys(rows[0]!.fields).sort()).toEqual(["f_name", "f_status"]);
    expect(rows[0]!.fieldsDisplay).toEqual({ f_name: "甲", f_status: "进行中" });
    expect("f_tags" in rows[0]!.fieldsDisplay!).toBe(false);
  });
});

describe("table.get_schema 的 options", () => {
  it("选择类字段附 options；其余字段不带该键", async () => {
    const r = await tableGetSchema(ctxWith(null), { baseId: "b1" });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0]!.text) as {
      tables: Array<{ tableId: string; fields: Array<Record<string, unknown>> }>;
    };
    const fields = payload.tables[0]!.fields;
    const byId = new Map(fields.map((f) => [String(f.fieldId), f]));
    expect(byId.get("f_status")!.options).toEqual(OPTIONS);
    expect(byId.get("f_tags")!.options).toEqual(OPTIONS);
    expect("options" in byId.get("f_name")!).toBe(false);
  });
});

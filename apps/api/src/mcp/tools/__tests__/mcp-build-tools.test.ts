// MCP 搭建工具对抗单测：table.create/update/delete、field.create/update/delete。
//
// mock 掉所有触库模块（tableService/fieldService/fieldValidation/mcpReadModels），不 migrate；
// 权限端口用替身按动作放行/拒绝，事务/服务捕获器确认「越权整单不开写」。
// 覆盖：manage_schema/manage_table 闸门二、空名、confirm 已由 zod 强制（此处验服务捕获）、
// 写而无 r 时的精简回执。

import { describe, expect, it, vi } from "vitest";
import type { McpPermissionPort } from "../../permissions/types.js";

const svcSpy = vi.fn();

vi.mock("../../../domain/tableService.js", () => ({
  createTable: vi.fn(async (i: { name: string }) => { svcSpy("createTable", i.name); return { tableId: "tNew", primaryFieldId: "fP", createdAt: new Date() }; }),
  updateTable: vi.fn(async (id: string, _b: unknown, p: Record<string, unknown>) => {
    svcSpy("updateTable", id); return { id, name: p.name ?? "表", primaryFieldId: "fP", icon: null, iconColor: null };
  }),
  softDeleteTable: vi.fn(async (id: string) => { svcSpy("softDeleteTable", id); }),
}));
vi.mock("../../../domain/fieldService.js", () => ({
  createField: vi.fn(async (i: { name: string }) => { svcSpy("createField", i.name); return { field: { id: "fNew" } }; }),
  updateField: vi.fn(async (id: string) => { svcSpy("updateField", id); return { id, name: "x" }; }),
  deleteField: vi.fn(async (id: string) => { svcSpy("deleteField", id); return { deleted: [id] }; }),
}));
vi.mock("../../../domain/fieldValidation.js", () => ({ validateFieldConfig: vi.fn(async () => null) }));
vi.mock("../../../domain/mcpReadModels.js", () => ({
  tableBriefById: vi.fn(async (id: string) => ({ id, baseId: "b1", name: "表" })),
  fieldBriefById: vi.fn(async (id: string) => ({ id, tableId: "t1" })),
  fieldConfigById: vi.fn(async (id: string) => ({
    id, tableId: "t1", type: "singleLineText", formula: null, lookupFieldId: null,
    rollupFunction: null, linkDisplayFieldId: null, relatedTableId: null, linkFieldId: null,
  })),
}));

import { tableCreateTable, tableUpdateTable, tableDeleteTable } from "../tableBuild.tools.js";
import { fieldCreateField, fieldUpdateField, fieldDeleteField } from "../fieldBuild.tools.js";

/** 替身端口：allowed 集合决定哪些动作放行；canRead 决定写后回执形态。 */
function portFor(opts: { allow: string[]; canRead?: boolean }): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(),
    can: vi.fn(async (action: string) => {
      if (action === "r") return opts.canRead ?? true;
      return opts.allow.includes(action);
    }),
    fieldCapability: vi.fn(),
    fieldCapabilityOf: vi.fn(),
    writeFieldCapabilityOf: vi.fn(),
    canCreateLibrary: vi.fn(async () => true),
  };
}
const ctx = (port: McpPermissionPort) => ({
  subject: { userId: "u1", patId: "pat1", scopes: ["record:write"] as never },
  port,
});
function codeOf(r: { content: Array<{ text: string }> }): string {
  return (JSON.parse(r.content[0]!.text) as { code?: string }).code ?? "";
}
function bodyOf(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("table 搭建工具：闸门二 manage_schema/manage_table", () => {
  it("create_table：无 manage_schema -> FORBIDDEN_RESOURCE 且不调服务", async () => {
    svcSpy.mockClear();
    const r = await tableCreateTable(ctx(portFor({ allow: [] })), { baseId: "b1", name: "新表" });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_table：manage_schema 放行 + 空名 -> INVALID_PARAMS 不开写", async () => {
    svcSpy.mockClear();
    const r = await tableCreateTable(ctx(portFor({ allow: ["manage_schema"] })), { baseId: "b1", name: "   " });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("INVALID_PARAMS");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_table：成功；无 r 时回精简 {ok:true}", async () => {
    svcSpy.mockClear();
    const port = portFor({ allow: ["manage_schema"], canRead: false });
    const r = await tableCreateTable(ctx(port), { baseId: "b1", name: "新表" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("createTable", "新表");
  });

  it("create_table：有 r 时回 tableId/primaryFieldId", async () => {
    const r = await tableCreateTable(ctx(portFor({ allow: ["manage_schema"], canRead: true })), { baseId: "b1", name: "新表" });
    expect(bodyOf(r)).toMatchObject({ ok: true, tableId: "tNew", primaryFieldId: "fP" });
  });

  it("update_table：无 manage_table -> 拒绝", async () => {
    svcSpy.mockClear();
    const r = await tableUpdateTable(ctx(portFor({ allow: [] })), { tableId: "t1", name: "x" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("update_table：manage_table 放行 -> 调服务；无 r 回精简", async () => {
    const port = portFor({ allow: ["manage_table"], canRead: false });
    const r = await tableUpdateTable(ctx(port), { tableId: "t1", name: "改名" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("updateTable", "t1");
  });

  it("delete_table：无 manage_table -> 拒绝不开写", async () => {
    svcSpy.mockClear();
    const r = await tableDeleteTable(ctx(portFor({ allow: [] })), { tableId: "t1" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("delete_table：manage_table 放行 -> 软删；有 r 回 deleted:true", async () => {
    const r = await tableDeleteTable(ctx(portFor({ allow: ["manage_table"], canRead: true })), { tableId: "t1" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ ok: true, tableId: "t1", deleted: true });
    expect(svcSpy).toHaveBeenCalledWith("softDeleteTable", "t1");
  });
});

describe("field 搭建工具：闸门二 manage_schema", () => {
  it("create_field：无 manage_schema -> FORBIDDEN_RESOURCE", async () => {
    svcSpy.mockClear();
    const r = await fieldCreateField(ctx(portFor({ allow: [] })), { tableId: "t1", name: "x", type: "number" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_field：manage_schema 放行 -> 建字段；无 r 回精简", async () => {
    const port = portFor({ allow: ["manage_schema"], canRead: false });
    const r = await fieldCreateField(ctx(port), { tableId: "t1", name: "新列", type: "number" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("createField", "新列");
  });

  it("update_field：manage_schema 放行 -> 更新；有 r 回 field", async () => {
    const r = await fieldUpdateField(ctx(portFor({ allow: ["manage_schema"], canRead: true })), { fieldId: "f1", name: "改" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ ok: true, field: { id: "f1" } });
    expect(svcSpy).toHaveBeenCalledWith("updateField", "f1");
  });

  it("delete_field：无 manage_schema -> 拒绝", async () => {
    svcSpy.mockClear();
    const r = await fieldDeleteField(ctx(portFor({ allow: [] })), { fieldId: "f1" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("delete_field：manage_schema 放行 -> 级联软删；有 r 回 deleted 列表", async () => {
    const r = await fieldDeleteField(ctx(portFor({ allow: ["manage_schema"], canRead: true })), { fieldId: "f1" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ ok: true, deleted: ["f1"] });
    expect(svcSpy).toHaveBeenCalledWith("deleteField", "f1");
  });
});

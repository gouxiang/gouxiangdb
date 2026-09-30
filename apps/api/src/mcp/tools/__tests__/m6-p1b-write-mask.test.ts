// P1-B 对抗单测：record.create_record / update_record 的字段掩码必须 fail-closed。
//
// 缺陷（已坐实）：旧守卫 `!writableAll && visibleFields!==null` 用 read-capability 顶替写判定。
// 管理员下发 actions:["c"], fieldMask:{allowFields:[fA]}（合法，不要求含 r）的窄策略时，主体无
// r 来源 -> fieldCapability.visibleFields===null -> 白名单整段跳过 -> 可写掩码外任意物理列（fail-open），
// 且即使生效也只查 allowFields、不查 readOnlyFields。
//
// 本文件 mock 掉所有触库模块（recordService/recordWrite/defaults/db/mcpReadModels/桥），不 migrate；
// 权限端口用替身按用例返回【纯写能力】，事务捕获器确认「越界整单不开事务」。fieldMask 判定走真代码。

import { describe, expect, it, vi } from "vitest";
import type { McpPermissionPort, McpWriteFieldCapability } from "../../permissions/types.js";

const txSpy = vi.fn();

vi.mock("../../../domain/recordService.js", () => ({
  loadTableFields: vi.fn(async () => [
    { id: "fA", name: "甲", type: "singleLineText" },
    { id: "fB", name: "乙", type: "singleLineText" },
    { id: "fR", name: "只读列", type: "singleLineText" },
    { id: "fFx", name: "公式列", type: "formula" },
  ]),
  parseViewConfig: vi.fn(() => ({})),
  queryRecords: vi.fn(),
}));
vi.mock("../../../domain/mcpSearchBridge.js", () => ({ runMcpUnifiedSearch: vi.fn() }));
vi.mock("../../../domain/mcpReadModels.js", () => ({ recordBriefById: vi.fn(async () => ({ id: "rec1", tableId: "t1", deletedAt: null })) }));
vi.mock("../../../domain/recordWrite.js", () => ({
  createRecordTx: vi.fn(async (_tx: unknown, a: { payloadFields: unknown }) => { txSpy("create", a.payloadFields); return { id: "rec1" }; }),
  updateRecordTx: vi.fn(async (_tx: unknown, a: { patch: unknown }) => { txSpy("update", a.patch); return { id: "rec1" }; }),
  softDeleteRecordTx: vi.fn(),
}));
vi.mock("../../../domain/defaults.js", () => ({
  applyCreateDefaults: vi.fn(async () => {}),
  applyEditDefaults: vi.fn(async () => {}),
  applyReverseDefaultsForChild: vi.fn(async () => {}),
}));
vi.mock("../../../db.js", () => ({
  withWriteTx: vi.fn(async (_label: string, fn: (tx: unknown) => unknown) => fn({})),
  runWrite: vi.fn(async (_label: string, fn: () => unknown) => fn()),
}));

import { recordCreateRecord, recordUpdateRecord } from "../record.tools.js";

function portFor(write: McpWriteFieldCapability): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(),
    can: vi.fn(async (action: string) => action === "c" || action === "u" || action === "r" ? true : false),
    fieldCapability: vi.fn(),
    fieldCapabilityOf: vi.fn(),
    writeFieldCapabilityOf: vi.fn(async () => write),
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

describe("P1-B create_record 字段掩码 fail-closed", () => {
  it("(b1) 窄 c allowFields:[fA]、无 r：payload 带 fB -> FORBIDDEN_FIELD 且不开事务", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "ok", fB: "越界" } });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_FIELD");
    expect(txSpy).not.toHaveBeenCalled(); // 整单拒绝，事务不开
  });

  it("(b2) readOnlyFields 中的键（即使在 allow 内）也拒绝", async () => {
    txSpy.mockClear();
    // fR 已在 m4Adapter 经 fieldWritableInMask 排除，故可写并集只有 fA
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fR: "x" } });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_FIELD");
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("(b3) 宽 c（mask=null -> writableAll）：fA/fB 任意物理键成功、开事务（只写身份不回归）", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: true, writableFields: [] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "a", fB: "b" } });
    expect(r.isError).toBeUndefined();
    expect(txSpy).toHaveBeenCalledWith("create", { fA: "a", fB: "b" });
  });

  it("(b4) 窄 c 下，公式/系统键不在物理可写校验范围（applyFieldWrites 本就跳过），不误拒", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "a", fFx: "ignored" } });
    expect(r.isError).toBeUndefined();
    expect(txSpy).toHaveBeenCalledWith("create", { fA: "a", fFx: "ignored" });
  });

  it("窄 c 合规载荷（仅 fA）成功", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "only-a" } });
    expect(r.isError).toBeUndefined();
    expect(txSpy).toHaveBeenCalledTimes(1);
  });

  it("(b6 回归) 窄 c 下，载荷含【本表无定义的未知键】必须整单拒绝，不得静默丢弃（S4 白名单外字段）", async () => {
    txSpy.mockClear();
    // loadTableFields 只定义 fA/fB/fR/fFx；fUnknown 不在其中 -> 未知键 -> FORBIDDEN_FIELD。
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "ok", fUnknown: "x" } });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_FIELD");
    expect(txSpy).not.toHaveBeenCalled(); // 整单拒绝，事务不开
  });

  it("(b7) 宽 c（writableAll）下未知键也不逐键拦（宽授权保持可用，语义同 applyFieldWrites 跳过未知键）", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: true, writableFields: [] });
    const r = await recordCreateRecord(ctx(port), { tableId: "t1", fields: { fA: "a", fUnknown: "x" } });
    expect(r.isError).toBeUndefined();
    expect(txSpy).toHaveBeenCalledWith("create", { fA: "a", fUnknown: "x" });
  });
});

describe("P1-B update_record 字段掩码 fail-closed", () => {
  it("窄 u allowFields:[fA]：patch 带 fB -> FORBIDDEN_FIELD 不开事务", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: false, writableFields: ["fA"] });
    const r = await recordUpdateRecord(ctx(port), { tableId: "t1", recordId: "rec1", fields: { fB: "x" } });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_FIELD");
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("宽 u（writableAll）：patch 多键成功", async () => {
    txSpy.mockClear();
    const port = portFor({ matched: true, writableAll: true, writableFields: [] });
    const r = await recordUpdateRecord(ctx(port), { tableId: "t1", recordId: "rec1", fields: { fA: 1, fB: 2 } });
    expect(r.isError).toBeUndefined();
    expect(txSpy).toHaveBeenCalledWith("update", { fA: 1, fB: 2 });
  });
});

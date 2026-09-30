// MCP 搭建工具对抗单测（第二批）：view.create/update/delete、doc.create、canvas.create。
//
// mock 掉触库编排（viewService/contentService/mcpReadModels），不 migrate；
// 权限端口替身按动作放行/拒绝，服务捕获器确认「越权整单不开写」。
// parseViewConfig 是纯函数，直接用真实实现。
// 覆盖：manage_schema（view）/ c（doc、canvas 在 kb 节点）闸门二、空名、
// 空 patch、写而无 r 的精简回执。

import { describe, expect, it, vi } from "vitest";
import type { McpPermissionPort } from "../../permissions/types.js";

const svcSpy = vi.fn();

vi.mock("../../../domain/viewService.js", () => ({
  createView: vi.fn(async (i: { name: string }) => { svcSpy("createView", i.name); return { id: "vNew", createdAt: new Date() }; }),
  updateView: vi.fn(async (id: string, p: { data: Record<string, unknown> }) => {
    svcSpy("updateView", id);
    return { id, name: p.data.name ?? "视图", type: "grid", lockMode: "collaborative", order: 0 };
  }),
  purgeView: vi.fn(async (id: string) => { svcSpy("purgeView", id); }),
}));
vi.mock("../../../domain/contentService.js", () => ({
  createContent: vi.fn(async (i: { kind: string }) => {
    svcSpy("createContent", i.kind);
    return { id: i.kind === "canvas" ? "cNew" : "dNew" };
  }),
}));
vi.mock("../../../domain/mcpReadModels.js", () => ({
  viewBriefById: vi.fn(async (id: string) => ({ id, tableId: "t1", type: "grid", config: "{}", lockMode: "collaborative" })),
  kbBriefById: vi.fn(async (id: string) => ({ id })),
}));

import { viewCreateView, viewUpdateView, viewDeleteView } from "../viewBuild.tools.js";
import { docCreateDoc, canvasCreateCanvas } from "../contentBuild.tools.js";

/** 替身端口：resourceOverrides 可按 (action,kind) 精细控制；默认 allow 集 + canRead。 */
function portFor(opts: {
  allow: string[];
  canRead?: boolean;
  denyKbC?: boolean;
}): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(),
    can: vi.fn(async (action: string, resource?: { kind: string }) => {
      if (opts.denyKbC && action === "c" && resource?.kind === "kb") return false;
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
const codeOf = (r: { content: Array<{ text: string }> }): string =>
  (JSON.parse(r.content[0]!.text) as { code?: string }).code ?? "";
const bodyOf = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("view 搭建工具：闸门二 manage_schema", () => {
  it("create_view：无 manage_schema -> FORBIDDEN_RESOURCE 且不调服务", async () => {
    svcSpy.mockClear();
    const r = await viewCreateView(ctx(portFor({ allow: [] })), { tableId: "t1", name: "新视图", type: "grid" });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_view：manage_schema 放行 + 空名 -> INVALID_PARAMS 不开写", async () => {
    svcSpy.mockClear();
    const r = await viewCreateView(ctx(portFor({ allow: ["manage_schema"] })), { tableId: "t1", name: "  ", type: "grid" });
    expect(codeOf(r)).toBe("INVALID_PARAMS");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_view：manage_schema 放行 + 缺类型 -> INVALID_PARAMS", async () => {
    svcSpy.mockClear();
    const r = await viewCreateView(ctx(portFor({ allow: ["manage_schema"] })), { tableId: "t1", name: "x" });
    expect(codeOf(r)).toBe("INVALID_PARAMS");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("create_view：成功；无 r 回精简 {ok:true}", async () => {
    const port = portFor({ allow: ["manage_schema"], canRead: false });
    const r = await viewCreateView(ctx(port), { tableId: "t1", name: "新视图", type: "kanban" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("createView", "新视图");
  });

  it("create_view：有 r 回 viewId", async () => {
    const r = await viewCreateView(ctx(portFor({ allow: ["manage_schema"], canRead: true })), { tableId: "t1", name: "x", type: "grid" });
    expect(bodyOf(r)).toMatchObject({ ok: true, viewId: "vNew" });
  });

  it("update_view：无 manage_schema -> 拒绝不开写", async () => {
    svcSpy.mockClear();
    const r = await viewUpdateView(ctx(portFor({ allow: [] })), { viewId: "v1", name: "改名" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("update_view：空修改 -> INVALID_PARAMS（不白调一次写）", async () => {
    svcSpy.mockClear();
    const r = await viewUpdateView(ctx(portFor({ allow: ["manage_schema"] })), { viewId: "v1" });
    expect(codeOf(r)).toBe("INVALID_PARAMS");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("update_view：manage_schema 放行 -> 调服务；无 r 回精简", async () => {
    const port = portFor({ allow: ["manage_schema"], canRead: false });
    const r = await viewUpdateView(ctx(port), { viewId: "v1", name: "改名" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("updateView", "v1");
  });

  it("update_view：config 非对象 -> INVALID_PARAMS", async () => {
    svcSpy.mockClear();
    const r = await viewUpdateView(ctx(portFor({ allow: ["manage_schema"] })), { viewId: "v1", config: "bad" });
    expect(codeOf(r)).toBe("INVALID_PARAMS");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("delete_view：无 manage_schema -> 拒绝", async () => {
    svcSpy.mockClear();
    const r = await viewDeleteView(ctx(portFor({ allow: [] })), { viewId: "v1" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("delete_view：manage_schema 放行 -> 删；有 r 回 deleted:true", async () => {
    const r = await viewDeleteView(ctx(portFor({ allow: ["manage_schema"], canRead: true })), { viewId: "v1" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ ok: true, viewId: "v1", deleted: true });
    expect(svcSpy).toHaveBeenCalledWith("purgeView", "v1");
  });
});

describe("doc.create / canvas.create：闸门二 kb 节点 c", () => {
  it("doc.create_doc：kb 无 c -> FORBIDDEN_RESOURCE 且不调服务", async () => {
    svcSpy.mockClear();
    const r = await docCreateDoc(ctx(portFor({ allow: [], denyKbC: true })), { kbId: "kb1" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("doc.create_doc：c 放行 -> 建文档；无 r 回精简", async () => {
    const port = portFor({ allow: ["c"], canRead: false });
    const r = await docCreateDoc(ctx(port), { kbId: "kb1", title: "新文档" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toEqual({ ok: true });
    expect(svcSpy).toHaveBeenCalledWith("createContent", "doc");
  });

  it("doc.create_doc：有 doc r 回 docId", async () => {
    const r = await docCreateDoc(ctx(portFor({ allow: ["c"], canRead: true })), { kbId: "kb1" });
    expect(bodyOf(r)).toMatchObject({ ok: true, docId: "dNew" });
  });

  it("canvas.create_canvas：kb 无 c -> 拒绝", async () => {
    svcSpy.mockClear();
    const r = await canvasCreateCanvas(ctx(portFor({ allow: [], denyKbC: true })), { kbId: "kb1" });
    expect(codeOf(r)).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });

  it("canvas.create_canvas：c 放行 -> 建画布；有 canvas r 回 canvasId", async () => {
    const r = await canvasCreateCanvas(ctx(portFor({ allow: ["c"], canRead: true })), { kbId: "kb1" });
    expect(r.isError).toBeUndefined();
    expect(bodyOf(r)).toMatchObject({ ok: true, canvasId: "cNew" });
    expect(svcSpy).toHaveBeenCalledWith("createContent", "canvas");
  });
});

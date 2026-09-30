// #623 base.create_base / kb.create_kb handler 对抗单测：
//  无引擎 / 无 create_library 拒绝且不开写、空名拒绝、成功回执、服务参数捕获。
// mock domain/libraryService，不 migrate；判定走替身端口。

import { describe, expect, it, vi } from "vitest";
import type { McpPermissionPort } from "../../permissions/types.js";

const svcSpy = vi.fn();

vi.mock("../../../domain/libraryService.js", () => ({
  createBase: vi.fn(async (i: { name: string }) => { svcSpy("createBase", i); return { id: "bNew", name: i.name }; }),
  createKb: vi.fn(async (i: { name: string }) => { svcSpy("createKb", i); return { id: "kNew", name: i.name }; }),
}));

import { baseCreateBase, kbCreateKb } from "../libraryBuild.tools.js";

function portFor(canCreate: boolean): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(),
    can: vi.fn(),
    fieldCapability: vi.fn(),
    fieldCapabilityOf: vi.fn(),
    writeFieldCapabilityOf: vi.fn(),
    canCreateLibrary: vi.fn(async () => canCreate),
  };
}
const ctxOf = (port: McpPermissionPort | null) => ({
  subject: { userId: "u1", patId: "p1", scopes: [] as never },
  port,
});
const bodyOf = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("base.create_base", () => {
  it("端口缺失 -> FORBIDDEN_RESOURCE", async () => {
    const r = await baseCreateBase(ctxOf(null), { name: "新库", confirm: true });
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
  });
  it("无 create_library -> FORBIDDEN_RESOURCE 且不调服务", async () => {
    svcSpy.mockClear();
    const r = await baseCreateBase(ctxOf(portFor(false)), { name: "新库", confirm: true });
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });
  it("空名（含纯空格）-> INVALID_PARAMS", async () => {
    for (const name of ["", "   "]) {
      const r = await baseCreateBase(ctxOf(portFor(true)), { name, confirm: true });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("INVALID_PARAMS");
    }
  });
  it("成功 -> baseId 回执，trim 后的名字传给服务", async () => {
    const r = await baseCreateBase(ctxOf(portFor(true)), { name: "  新库  ", withStarter: false, confirm: true });
    expect(r.isError ?? false).toBe(false);
    expect(bodyOf(r)).toEqual({ ok: true, baseId: "bNew", name: "新库" });
    expect(svcSpy).toHaveBeenCalledWith("createBase", expect.objectContaining({ name: "新库", withStarter: false }));
  });
});

describe("kb.create_kb", () => {
  it("无 create_library -> FORBIDDEN_RESOURCE 不开写", async () => {
    svcSpy.mockClear();
    const r = await kbCreateKb(ctxOf(portFor(false)), { name: "新知识库", confirm: true });
    expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
    expect(svcSpy).not.toHaveBeenCalled();
  });
  it("空名 -> INVALID_PARAMS；成功 -> kbId 回执", async () => {
    const bad = await kbCreateKb(ctxOf(portFor(true)), { name: " ", confirm: true });
    expect(bodyOf(bad).code).toBe("INVALID_PARAMS");
    const r = await kbCreateKb(ctxOf(portFor(true)), { name: "知识库甲", confirm: true });
    expect(bodyOf(r)).toEqual({ ok: true, kbId: "kNew", name: "知识库甲" });
  });
});

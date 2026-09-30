// #622 canvas.commit_elements handler 对抗单测：
//  闸门二 u、doc 前置、存量损坏拒写、UNSUPPORTED 错误码、写后回执分流、VERSION_CONFLICT。
// mock 掉 withWriteTx/saveDocContentTx/docBriefById，不 migrate；图元规则走真实 @gx/canvas。

import { describe, expect, it, vi } from "vitest";
import type { McpPermissionPort } from "../../permissions/types.js";

let nextVersion = 5;
const saveSpy = vi.fn();

vi.mock("../../../db.js", () => ({
  withWriteTx: vi.fn(async (_name: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock("../../../domain/kbDocWrite.js", () => ({
  VersionConflictError: class VersionConflictError extends Error {
    currentVersion: number;
    constructor(message: string, currentVersion: number) {
      super(message);
      this.currentVersion = currentVersion;
    }
  },
  saveDocContentTx: vi.fn(async () => {
    saveSpy();
    return { contentVersion: ++nextVersion };
  }),
}));
vi.mock("../../../domain/mcpDocModels.js", () => ({
  docBriefById: vi.fn(async (id: string) =>
    id === "c1"
      ? { id, kind: "canvas", contentVersion: nextVersion, content: "[]" }
      : id === "broken"
        ? { id, kind: "canvas", contentVersion: 1, content: "{bad json" }
        : null,
  ),
}));

import { canvasCommitElements } from "../canvasWrite.tools.js";

function portFor(opts: { canU?: boolean; canRead?: boolean }): McpPermissionPort {
  return {
    listAccessibleResources: vi.fn(),
    can: vi.fn(async (action: string) => (action === "u" ? opts.canU ?? true : opts.canRead ?? true)),
    fieldCapability: vi.fn(),
    fieldCapabilityOf: vi.fn(),
    writeFieldCapabilityOf: vi.fn(),
  };
}
const ctxOf = (port: McpPermissionPort | null) => ({
  subject: { userId: "u1", patId: "pat1", scopes: ["canvas:write"] as never },
  port,
});
const bodyOf = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const goodArgs = {
  docId: "c1",
  ops: [{ op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [10, 10]] } }],
  confirm: true,
};

describe("canvas.commit_elements：前置闸门", () => {
  it("端口缺失 -> FORBIDDEN_RESOURCE", async () => {
    const r = await canvasCommitElements(ctxOf(null), goodArgs);
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
  });
  it("无 u 权限 -> FORBIDDEN_RESOURCE 且不落盘", async () => {
    saveSpy.mockClear();
    const r = await canvasCommitElements(ctxOf(portFor({ canU: false })), goodArgs);
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
    expect(saveSpy).not.toHaveBeenCalled();
  });
  it("画布不存在 / 类型不符 -> FORBIDDEN_RESOURCE", async () => {
    for (const docId of ["missing", "d1"]) {
      const r = await canvasCommitElements(ctxOf(portFor({})), { ...goodArgs, docId });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("FORBIDDEN_RESOURCE");
    }
  });
  it("存量内容损坏 -> INVALID_PARAMS 拒写（绝不覆盖）", async () => {
    saveSpy.mockClear();
    const r = await canvasCommitElements(ctxOf(portFor({})), { ...goodArgs, docId: "broken" });
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("INVALID_PARAMS");
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("canvas.commit_elements：op 规则与错误码", () => {
  it("未知 op 名 -> UNSUPPORTED_OPERATION 且附完整 supported", async () => {
    const r = await canvasCommitElements(ctxOf(portFor({})), {
      docId: "c1",
      ops: [{ op: "zorder", id: "x" }],
      confirm: true,
    });
    expect(r.isError).toBe(true);
    const body = bodyOf(r);
    expect(body.code).toBe("UNSUPPORTED_OPERATION");
    expect(body.supported).toEqual([
      "element.create",
      "element.update",
      "element.move",
      "element.delete",
      "element.connect",
    ]);
  });
  it("目标 id 不存在 -> INVALID_PARAMS", async () => {
    const r = await canvasCommitElements(ctxOf(portFor({})), {
      docId: "c1",
      ops: [{ op: "element.delete", id: "ghost" }],
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(bodyOf(r).code).toBe("INVALID_PARAMS");
  });
});

describe("canvas.commit_elements：写后回执", () => {
  it("成功 + 有 r：完整回执（版本/元素数/各类 id）", async () => {
    const r = await canvasCommitElements(ctxOf(portFor({ canRead: true })), goodArgs);
    expect(r.isError ?? false).toBe(false);
    const body = bodyOf(r);
    expect(body.ok).toBe(true);
    expect(body.contentVersion).toBe(6);
    expect(body.elementCount).toBe(1);
    expect(body.createdIds).toHaveLength(1);
  });
  it("成功 + 无 r：精简 {ok:true}（防派生值泄漏）", async () => {
    const r = await canvasCommitElements(ctxOf(portFor({ canRead: false })), goodArgs);
    const body = bodyOf(r);
    expect(body).toEqual({ ok: true });
    expect(Object.keys(body)).toEqual(["ok"]);
  });
});

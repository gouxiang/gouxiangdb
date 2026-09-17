// P0-A 对抗单测：record.search 必须按 PAT 六位 scope 收窄检索实体族。
//
// 缺陷（已坐实）：M5 的 scope 收敛只认「登录用户 r 授权」，不知道 PAT 的 scope；旧桥硬编码
// type:"all"，一枚仅持 record:read（无 doc:read/canvas:read）的 PAT 在 GX_M5_SEARCH≠off 时
// 能读到其在 M4 有 r、但 PAT 未授权的 doc/canvas 正文片段（snippet 命中正文）。
//
// 本文件不连库、不 migrate、不建 search.db：vi.mock 拦截 queryRuntime/query，钉死两道闸——
//   1) scope 安全闸：允许族必须映射成 nav kind 透传 buildQueryRuntime 的 scopeKinds；
//   2) 输出纵深闸：即使 executeUnifiedSearch 回吐混合族，结果也只保留允许族（且 total 同步收窄）。
// 对照组（带 doc:read 的 PAT 能出 doc）防「全挡死」假绿。

import { beforeEach, describe, expect, it, vi } from "vitest";

// config 在模块加载期（config.ts:346 buildConfig(process.env)）即定型，而 import 求值先于普通
// 顶层语句；用 vi.hoisted 把 env 设置提到所有 import 之前，保证 recordSearch 见到 m5Search="on"。
vi.hoisted(() => {
  process.env.GX_M5_SEARCH = "on";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL ??= "file:/tmp/gx-p0a-unused.db";
});

const runtimeCapture = vi.fn();

vi.mock("../../../domain/search/queryRuntime.js", () => ({
  buildQueryRuntime: vi.fn(async (userId: string, _type: unknown, opts: Record<string, unknown>) => {
    runtimeCapture({ userId, opts });
    return { deps: { __mocked: true }, store: { __mocked: true } };
  }),
}));

vi.mock("../../../domain/search/query.js", () => ({
  // 默认回吐三族混合（模拟 scope 没收窄时会越权拿到的 doc/canvas 正文项）
  executeUnifiedSearch: vi.fn(async () => ({
    items: [
      { type: "record", entityId: "rec1", title: "表记录", snippet: "记录正文" },
      { type: "doc", entityId: "doc1", title: "文档", snippet: "文档正文片段" },
      { type: "canvas", entityId: "cv1", title: "画布", snippet: "画布正文片段" },
    ],
    total: 3, mode: "fts", degraded: [], scopeTruncated: false,
  })),
}));

import { runMcpUnifiedSearch } from "../../../domain/mcpSearchBridge.js";
import { recordSearch, searchEntityTypesForScopes } from "../record.tools.js";

beforeEach(() => {
  runtimeCapture.mockClear();
});

describe("P0-A-1 searchEntityTypesForScopes：PAT scope -> 检索实体族", () => {
  it("仅 record:read -> 只映射 record；三族全无 -> 空（fail-closed 依据）", () => {
    expect(searchEntityTypesForScopes(["record:read"])).toEqual(["record"]);
    expect(searchEntityTypesForScopes(["record:write"])).toEqual([]); // write 不等于 read
    expect(searchEntityTypesForScopes(["doc:write", "canvas:write"])).toEqual([]);
  });
  it("多族映射（顺序固定 record/doc/canvas）；write 不旁路 read 闸", () => {
    expect(searchEntityTypesForScopes(["record:read", "doc:read"])).toEqual(["record", "doc"]);
    expect(searchEntityTypesForScopes(["doc:read", "canvas:read", "record:read"]))
      .toEqual(["record", "doc", "canvas"]);
    expect(searchEntityTypesForScopes([])).toEqual([]);
  });
});

describe("P0-A-2 runMcpUnifiedSearch：scope 闸 + 输出纵深闸", () => {
  it("仅允许 record：scopeKinds 只透传 [table]，输出零 doc/canvas 项（核心越权断言）", async () => {
    const res = await runMcpUnifiedSearch("u1", "关键词", "auto", 20, ["record"]);
    // 闸一：scope 收敛的 nav kinds 必须只有 table（doc/canvas 在 temp_scope 物化期即排除）
    expect(runtimeCapture).toHaveBeenCalledTimes(1);
    const opts = runtimeCapture.mock.calls[0]![0].opts as { scopeKinds?: string[] };
    expect(opts.scopeKinds).toEqual(["table"]);
    // 闸二：即使底层回吐三族，输出只剩 record（不吐 doc/canvas 正文）
    const types = (res.items as Array<{ type: string }>).map((i) => i.type).sort();
    expect(types).toEqual(["record"]);
    expect(res.total).toBe(1);
    expect((res.items as Array<{ snippet?: string }>).some((i) => i.snippet?.includes("文档") || i.snippet?.includes("画布"))).toBe(false);
  });

  it("record+doc 对照组：能出 record/doc（证明不是全挡死），但仍不出 canvas", async () => {
    const res = await runMcpUnifiedSearch("u1", "关键词", "auto", 20, ["record", "doc"]);
    const opts = runtimeCapture.mock.calls[0]![0].opts as { scopeKinds?: string[] };
    expect(new Set(opts.scopeKinds)).toEqual(new Set(["table", "doc"]));
    const types = (res.items as Array<{ type: string }>).map((i) => i.type).sort();
    expect(types).toEqual(["doc", "record"]); // 有 doc（对照组），无 canvas
  });

  it("仅允许 doc：scopeKinds=[doc]，输出只 doc", async () => {
    const res = await runMcpUnifiedSearch("u1", "x", "auto", 20, ["doc"]);
    expect(runtimeCapture.mock.calls[0]![0].opts.scopeKinds).toEqual(["doc"]);
    expect((res.items as Array<{ type: string }>).map((i) => i.type)).toEqual(["doc"]);
  });

  it("空允许族 -> 零结果且 scopeKinds=[]（纵深：绝不回落全族）", async () => {
    const res = await runMcpUnifiedSearch("u1", "x", "auto", 20, []);
    expect(runtimeCapture.mock.calls[0]![0].opts.scopeKinds).toEqual([]);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("不传 allowedEntityTypes（非 MCP 语义）-> 不收窄，行为与历史一致（全族 + total 用底层值）", async () => {
    const res = await runMcpUnifiedSearch("u1", "x", "auto", 20);
    expect(runtimeCapture.mock.calls[0]![0].opts.scopeKinds).toBeUndefined();
    expect(res.items).toHaveLength(3);
    expect(res.total).toBe(3);
  });
});

describe("P0-A-3 recordSearch 工具层：scope 推导 + fail-closed", () => {
  const ctx = (scopes: string[]) => ({
    subject: { userId: "u1", patId: "pat1", scopes: scopes as never },
    port: null,
  });

  it("仅 record:read 的 PAT 调 record.search：桥只收到 [record]", async () => {
    const r = await recordSearch(ctx(["record:read"]), { q: "关键词" });
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      items: Array<{ type: string }>;
    };
    expect(payload.items.map((i) => i.type)).toEqual(["record"]);
  });

  it("带 doc:read 的 PAT：结果可含 doc（对照组）", async () => {
    const r = await recordSearch(ctx(["record:read", "doc:read"]), { q: "关键词" });
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      items: Array<{ type: string }>;
    };
    expect(payload.items.map((i) => i.type).sort()).toEqual(["doc", "record"]);
  });

  it("无任何读族（注册层理论上已挡）：fail-closed FORBIDDEN_RESOURCE，不调桥/不回落全族", async () => {
    const before = runtimeCapture.mock.calls.length;
    const r = await recordSearch(ctx(["record:write", "doc:write"]), { q: "x" });
    expect(r.isError).toBe(true);
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      code: string;
    };
    expect(payload.code).toBe("FORBIDDEN_RESOURCE");
    expect(runtimeCapture.mock.calls.length).toBe(before); // 桥未被调用
  });
});

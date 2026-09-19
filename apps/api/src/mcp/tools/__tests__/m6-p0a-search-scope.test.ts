// P3 鉴权语义变更后的对抗单测：record.search **不再按令牌 scopes 收窄实体族**。
//
// 新口径（与 Web 端 X-GX-Token 会话同口径）：令牌只做「认证 + 有效期」，能力一律按签发者用户
// 实时计算。实体族由 M5 的 scope 收敛按【签发者用户的 r 授权】在召回前收窄（不传 scopeKinds）。
//
// 历史背景（原 P0-A 缺陷，已坐实过）：M5 的 scope 收敛只认「登录用户 r 授权」，不知道 PAT 的
// scope；旧实现在 MCP 层用 PAT scope 再收窄一次。P3 起这层收窄整体下线——越权基准改为签发者本人，
// 等价于本人用 Web 端检索，不新增越权面。
//
// 本文件不连库、不 migrate、不建 search.db：vi.mock 拦截 queryRuntime/query，钉死两件事——
//   1) 令牌级收窄已下线：任何 scopes 组合都走同一条不收窄的桥调用；
//   2) 桥自身的 allowedEntityTypes 纵深闸仍在（非 MCP 语义传入时照旧收窄，不被本次改动波及）。

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
import { recordSearch } from "../record.tools.js";

beforeEach(() => {
  runtimeCapture.mockClear();
});

/** 令牌上下文：scopes 仍带在主体上（老数据兼容），但不再是本文件的判定依据。 */
const ctxOf = (scopes: string[]) => ({
  subject: { userId: "u1", patId: "pat1", scopes: scopes as never },
  port: null,
});

// 语义适配（P3）：原两组「PAT scope -> 检索实体族」的纯函数断言随鉴权语义下线而失效——
// searchEntityTypesForScopes 已删除。改为钉死**新口径**：令牌 scopes 无论取何值，
// record.search 都走同一条「不按令牌收窄」的桥调用（判据换成签发者用户，见 P0-A-3）。
describe("P0-A-1 令牌 scopes 不再参与检索实体族判定", () => {
  it("空 scope 与全 scope 的 PAT：桥调用参数逐字节一致（未传 allowedEntityTypes）", async () => {
    await recordSearch(ctxOf([]), { q: "关键词" });
    const withNone = runtimeCapture.mock.calls.at(-1)![0].opts as { scopeKinds?: string[] };
    await recordSearch(ctxOf(["record:read", "doc:read", "canvas:read"]), { q: "关键词" });
    const withAll = runtimeCapture.mock.calls.at(-1)![0].opts as { scopeKinds?: string[] };
    expect(withNone.scopeKinds).toBeUndefined();
    expect(withAll.scopeKinds).toBeUndefined();
    expect(withNone).toEqual(withAll);
  });

  it("仅带写位（无读位）也不再 fail-closed：桥照常被调用（老语义会直接拒绝）", async () => {
    const before = runtimeCapture.mock.calls.length;
    await recordSearch(ctxOf(["record:write", "doc:write"]), { q: "x" });
    expect(runtimeCapture.mock.calls.length).toBe(before + 1);
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

// 语义适配（P3）：三例的判据从「令牌 scope」换成「签发者用户」——subject.userId 恒为 u1，
// 故任何 scope 组合都返回三族（由 M5 按 u1 的 r 授权收敛，本层不再额外收窄）。
describe("P0-A-3 recordSearch 工具层：能力按签发者计算", () => {
  it("仅 record:read 的 PAT 调 record.search：不再收窄成 [record]，三族全出（按签发者 u1 的授权）", async () => {
    const r = await recordSearch(ctxOf(["record:read"]), { q: "关键词" });
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      items: Array<{ type: string }>;
    };
    expect(payload.items.map((i) => i.type).sort()).toEqual(["canvas", "doc", "record"]);
  });

  it("带 doc:read 的 PAT：结果与上例一致（scope 不再改变结果集）", async () => {
    const r = await recordSearch(ctxOf(["record:read", "doc:read"]), { q: "关键词" });
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
      items: Array<{ type: string }>;
    };
    expect(payload.items.map((i) => i.type).sort()).toEqual(["canvas", "doc", "record"]);
  });

  it("无任何读 scope：不再 fail-closed FORBIDDEN_RESOURCE，仍走桥（能力与签发者一致）", async () => {
    const before = runtimeCapture.mock.calls.length;
    const r = await recordSearch(ctxOf(["record:write", "doc:write"]), { q: "x" });
    expect(r.isError ?? false).toBe(false);
    expect(runtimeCapture.mock.calls.length).toBe(before + 1); // 桥被调用
  });
});

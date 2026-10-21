// apps/web/src/api/localSync.test.ts
// 404/SYNC_DISABLED 静默收敛 + DTO 容错归一 + 写操作方法/包封。纯 node，stub global.fetch。
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import {
  getLocalSyncStatus,
  listIncoming,
  retryIncoming,
  discardIncoming,
  resolveSyncConflict,
  normalizeSyncStatus,
  disabledSyncStatus,
  isSyncDisabledError,
  isSyncUpstreamError,
  type ResolveDecision,
} from "./localSync";
import { ApiError } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("404 / SYNC_DISABLED 静默", () => {
  it("status 端点 404 → disabled 报告（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "同步服务未启用", code: "SYNC_DISABLED" }, 404)));
    const s = await getLocalSyncStatus();
    expect(s.enabled).toBe(false);
  });

  it("incoming 404 → 空列表（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "x", code: "SYNC_DISABLED" }, 404)));
    const list = await listIncoming();
    expect(list.items).toEqual([]);
    expect(list.count).toBe(0);
  });

  it("retry/discard/resolve 404 → null（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "SYNC_DISABLED" }, 404)));
    expect(await retryIncoming("i1")).toBeNull();
    expect(await discardIncoming("i1")).toBeNull();
    expect(await resolveSyncConflict({ resolveOf: "c1", decision: "theirs" })).toBeNull();
  });

  it("非 404 错误照常抛出（绝不吞真实故障）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "拒绝", code: "FORBIDDEN" }, 403)));
    await expect(getLocalSyncStatus()).rejects.toBeInstanceOf(ApiError);
  });

  it("isSyncDisabledError 仅认 404", () => {
    expect(isSyncDisabledError(new ApiError(404, { code: "SYNC_DISABLED" }))).toBe(true);
    expect(isSyncDisabledError(new ApiError(403, {}))).toBe(false);
    expect(isSyncDisabledError(new Error("x"))).toBe(false);
  });
});

describe("normalizeSyncStatus 容错", () => {
  it("非对象/缺 enabled → disabled（fail-closed）", () => {
    expect(normalizeSyncStatus(null).enabled).toBe(false);
    expect(normalizeSyncStatus("x").enabled).toBe(false);
    expect(normalizeSyncStatus({}).enabled).toBe(false);
    expect(normalizeSyncStatus({ enabled: 1 }).enabled).toBe(false);
  });

  it("enabled=true 时数字串计数/BigInt 串容错、坏 base 跳过", () => {
    const s = normalizeSyncStatus({
      enabled: true,
      pendingOutbox: "5",
      quarantinedCount: 2,
      conflictCount: "x",
      localBytesUsed: "2048",
      lastPulledAt: "2026-10-20T01:02:03.000Z",
      inFlight: true,
      stage: "push",
      nodeId: "local",
      bases: [
        { id: "b1", name: "库", lastPulledAt: "t", lastPushedAt: null },
        { id: "", name: "坏" },
        "nope",
      ],
    });
    expect(s.pendingOutbox).toBe(5);
    expect(s.conflictCount).toBe(0);
    expect(s.localBytesUsed).toBe(2048);
    expect(s.bases).toHaveLength(1);
    expect(s.bases[0]!.id).toBe("b1");
    expect(s.inFlight).toBe(true);
    expect(s.stage).toBe("push");
  });

  it("disabledSyncStatus 全零空", () => {
    const d = disabledSyncStatus();
    expect(d.enabled).toBe(false);
    expect(d.bases).toEqual([]);
  });
});

describe("incoming 包封与归一", () => {
  it("解析 {result:{items,count}} 并过滤缺主键项", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          result: {
            count: 2,
            items: [
              {
                id: "i1", clientOpId: "c1", entityType: "record", entityId: "e", op: "update",
                payload: { a: 1 }, baseVersion: "3", status: "conflict", reasonCode: null,
                reasonDetail: null, serverVersion: "4", conflictServerPayload: { a: 2 }, attempts: "1",
                createdAt: "t", decidedAt: null,
              },
              { id: "", clientOpId: "bad" },
            ],
          },
        }),
      ),
    );
    const list = await listIncoming("conflict");
    expect(list.items).toHaveLength(1);
    expect(list.count).toBe(2);
    expect(list.items[0]!.conflictServerPayload).toEqual({ a: 2 });
    expect(list.items[0]!.attempts).toBe(1);
  });

  it("裸 {items,count} 包封也兼容", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [], count: 0 })));
    const list = await listIncoming();
    expect(list.items).toEqual([]);
  });
});

describe("写操作方法与侧车代理路径", () => {
  it("retry 走 POST /api/local-sync/conflicts/:id/retry（id＝行 id）并归一回执", async () => {
    const f: Mock<typeof fetch> = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ result: { id: "i1", clientOpId: "c1", status: "accepted", attempts: 2 } }));
    vi.stubGlobal("fetch", f);
    const r = await retryIncoming("i1");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain("/api/local-sync/conflicts/i1/retry");
    expect(String(url)).not.toContain("/api/v1/sync");
    expect(init!.method).toBe("POST");
    expect(r?.status).toBe("accepted");
    expect(r?.attempts).toBe(2);
  });

  it("discard 走 .../:id/discard 且带 {confirm:true}", async () => {
    const f: Mock<typeof fetch> = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ result: { id: "i1", status: "dropped" } }));
    vi.stubGlobal("fetch", f);
    await discardIncoming("i1");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain("/api/local-sync/conflicts/i1/discard");
    expect(JSON.parse(init!.body as string)).toEqual({ confirm: true });
  });
});

describe("502 SYNC_UPSTREAM_UNREACHABLE：不当 disabled、照常抛出", () => {
  it("isSyncUpstreamError 仅认 502", () => {
    expect(isSyncUpstreamError(new ApiError(502, { code: "SYNC_UPSTREAM_UNREACHABLE" }))).toBe(true);
    expect(isSyncUpstreamError(new ApiError(404, { code: "SYNC_DISABLED" }))).toBe(false);
    expect(isSyncUpstreamError(new ApiError(409, {}))).toBe(false);
    expect(isSyncUpstreamError(new Error("x"))).toBe(false);
  });

  it("listIncoming 502 抛出（不静默空、不清旧队列）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "上游不通", code: "SYNC_UPSTREAM_UNREACHABLE" }, 502)));
    await expect(listIncoming("conflict")).rejects.toBeInstanceOf(ApiError);
  });

  it("retry/resolve 502 抛出（不返 null）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "SYNC_UPSTREAM_UNREACHABLE" }, 502)));
    await expect(retryIncoming("i1")).rejects.toBeInstanceOf(ApiError);
    await expect(resolveSyncConflict({ resolveOf: "c1", decision: "mine" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("resolve 契约（resolveOf/decision/patch）", () => {
  async function callResolve(input: { resolveOf: string; decision: ResolveDecision; patch?: Record<string, unknown> }, fetchImpl: Mock<typeof fetch>) {
    vi.stubGlobal("fetch", fetchImpl);
    await resolveSyncConflict(input);
    return JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
  }

  it("theirs 不带 patch", async () => {
    const f: Mock<typeof fetch> = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ result: { resolveOf: "c1", decision: "theirs", status: "dropped" } }));
    const body = await callResolve({ resolveOf: "c1", decision: "theirs" }, f);
    expect(body).toEqual({ resolveOf: "c1", decision: "theirs" });
    expect(String(f.mock.calls[0]![0])).toContain("/api/local-sync/conflicts/resolve");
  });

  it("mine 不带 patch", async () => {
    const body = await callResolve({ resolveOf: "c1", decision: "mine" }, vi.fn<typeof fetch>(async (_url, _init?) => jsonResponse({ result: { status: "accepted" } })));
    expect(body).toEqual({ resolveOf: "c1", decision: "mine" });
  });

  it("custom 缺/空 patch 在客户端先挡（不发请求）", async () => {
    const f = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", f);
    await expect(resolveSyncConflict({ resolveOf: "c1", decision: "custom" })).rejects.toBeInstanceOf(ApiError);
    await expect(resolveSyncConflict({ resolveOf: "c1", decision: "custom", patch: {} })).rejects.toBeInstanceOf(ApiError);
    expect(f).not.toHaveBeenCalled();
  });

  it("custom 非空 patch 透传", async () => {
    const body = await callResolve(
      { resolveOf: "c1", decision: "custom", patch: { a: 9 } },
      vi.fn<typeof fetch>(async (_url, _init?) => jsonResponse({ result: { status: "accepted" } })),
    );
    expect(body).toEqual({ resolveOf: "c1", decision: "custom", patch: { a: 9 } });
  });

  it("重放再被拒：result.reasonCode 被解析（不抛、留队由调用方处理）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ result: { resolveOf: "c1", decision: "mine", status: "conflict", reasonCode: "SYNC_VERSION_CONFLICT" } })),
    );
    const r = await resolveSyncConflict({ resolveOf: "c1", decision: "mine" });
    expect(r?.status).toBe("conflict");
    expect(r?.reasonCode).toBe("SYNC_VERSION_CONFLICT");
  });
});

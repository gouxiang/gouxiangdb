// makeRemoteBaseLister 单测：默认远端 base 列表工厂（GET /api/bases）。
//
// 为什么独立成文件：replicaSyncRuntime.test.ts 已贴近 300 行单文件硬门禁；本文件只测纯 lister 工厂，
// 用全局 fetch 假桩即可，不起引擎单例、不起 HTTP server。
//
// 为什么仍要 setupOrgHarness：被测模块 replicaSyncRuntime.ts 静态 import 了 ../../db.js，而 db.ts 在
// 模块作用域即 new PrismaClient(...)；必须先由 setupOrgHarness 注入 DATABASE_URL / globalThis.__gx_prisma，
// 再【动态 import】被测模块（见 replicaSyncRuntime.test.ts 文件头同款说明）。
//
// 覆盖（对应 be-replica-wire1 四用例）：
//   1. URL 规范化：remoteUrl 带尾斜杠时，实际请求 pathname 严格为 /api/bases（非 /api/bases/），且带 X-GX-Token。
//   2. 非字符串/空 id 过滤：{bases:[{id:"a"},{id:1},{id:"b"},null]} -> ["a","b"]。
//   3. 非 2xx（404）归一为 ReplicaTransportError（message 含「base 列表被拒绝」、status=404）。
//   4. 200 但非 JSON / 缺 bases 数组：各自抛 ReplicaTransportError。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import type { ReplicaSyncConfig } from "../../../configReplica.js";
import type { ReplicaTransportError } from "../replicaPushTransport.js";

type RuntimeMod = typeof import("../replicaSyncRuntime.js");
let mod: RuntimeMod;
let h: OrgHarness;

function cfg(over: Partial<ReplicaSyncConfig> = {}): ReplicaSyncConfig {
  return { remoteUrl: "http://h:3101", remoteToken: "secret-token", intervalMs: 30_000, ...over };
}

/** 抓出假桩收到的请求（URL 已解析），便于断言 pathname/header/method。 */
interface SeenReq {
  url: URL;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

beforeAll(async () => {
  h = await setupOrgHarness();
  mod = await import("../replicaSyncRuntime.js");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe("makeRemoteBaseLister：默认远端 base 列表", () => {
  let seen: SeenReq[];

  beforeEach(() => {
    seen = [];
  });

  it("remoteUrl 带尾斜杠也只打 /api/bases（无尾斜杠），且带 X-GX-Token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: new URL(String(input)), init });
        return jsonResponse({ bases: [] });
      }),
    );
    const list = mod.makeRemoteBaseLister(cfg({ remoteUrl: "http://h:3101/" }));
    const ids = await list();

    expect(ids).toEqual([]);
    expect(seen).toHaveLength(1);
    // 核心回归点：Hono 业务/同步路由只匹配无尾斜杠路径，/api/bases/ 会 404 导致整链路空转。
    expect(seen[0].url.pathname).toBe("/api/bases");
    expect(seen[0].url.hostname).toBe("h");
    expect(seen[0].url.port).toBe("3101");
    expect(seen[0].init?.method ?? "GET").toBe("GET");
    const headers = new Headers(seen[0].init?.headers as HeadersInit | undefined);
    expect(headers.get("X-GX-Token")).toBe("secret-token");
  });

  it("过滤非字符串/空 id，仅保留非空字符串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ bases: [{ id: "a" }, { id: 1 }, { id: "b" }, null] })),
    );
    const list = mod.makeRemoteBaseLister(cfg());
    const ids = await list();
    // number(1)/null 被剔除，仅保留非空字符串 id。
    expect(ids).toEqual(["a", "b"]);
  });

  it("404 归一为 ReplicaTransportError（含「base 列表被拒绝」、status=404）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const list = mod.makeRemoteBaseLister(cfg());
    const err = await list().then(
      () => null,
      (e: unknown) => e as ReplicaTransportError,
    );
    expect(err).not.toBeNull();
    expect(err!.name).toBe("ReplicaTransportError");
    expect(err!.message).toContain("base 列表被拒绝");
    expect(err!.status).toBe(404);
  });

  it("200 但回执不是合法 JSON -> ReplicaTransportError(status=200)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json{", { status: 200, headers: { "content-type": "text/plain" } })));
    const list = mod.makeRemoteBaseLister(cfg());
    const err = await list().then(
      () => null,
      (e: unknown) => e as ReplicaTransportError,
    );
    expect(err).not.toBeNull();
    expect(err!.name).toBe("ReplicaTransportError");
    expect(err!.message).toContain("base 列表回执不是合法 JSON");
    expect(err!.status).toBe(200);
  });

  it("200、合法 JSON 但缺 bases 数组 -> ReplicaTransportError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ somethingElse: 1 })));
    const list = mod.makeRemoteBaseLister(cfg());
    const err = await list().then(
      () => null,
      (e: unknown) => e as ReplicaTransportError,
    );
    expect(err).not.toBeNull();
    expect(err!.name).toBe("ReplicaTransportError");
    expect(err!.message).toContain("base 列表回执缺少 bases 数组");
    expect(err!.status).toBe(200);
  });
});

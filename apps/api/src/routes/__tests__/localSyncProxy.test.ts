// /api/local-sync/conflicts 侧车冲突【纯转发代理】契约测试（纯 headless）。
//
// 不起真实 HTTP server / DB：createLocalSyncProxyRoutes 注入假 fetch + 固定 config +
// 直通鉴权桩，挂到临时 Hono app 的 /api/local-sync/conflicts 上用 app.request 驱动。
// 临时 app 自行挂与生产 guards.errorResponse 同形的 onError，把 HttpError 映射成
// {error,code} 信封（生产由 app.ts 顶层 onError 负责，本文件不 import 生产 app.ts）。
// 唯一不注入鉴权桩的用例走真 requireActiveUser：无凭证时 resolveActiveAuth 在读 token
// 阶段即返回 null（authState.ts `if (!token) return null`），不发生任何 Prisma 往返。
//
// 覆盖：门关闭 404、未鉴权 401、incoming 列表 GET 透传（query 白名单/剥浏览器头）、
// retry/discard/resolve 路径与 body、decision 白名单、409 保真、上游 404 不误判 disabled、
// 4xx 非 JSON 兜底、5xx 透传与非 JSON 归一 502、fetch reject 502、:id 穿越拒绝。

import { describe, expect, it } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLocalSyncProxyRoutes, type LocalSyncProxyFetch } from "../localSyncProxy.js";
import type { ReplicaSyncConfig } from "../../configReplica.js";
import { HttpError, errorCodeForStatus } from "../../httpError.js";

const MOUNT = "/api/local-sync/conflicts";
const REMOTE = "http://remote.example.test:59999";

const CFG_ON: ReplicaSyncConfig = { remoteUrl: REMOTE, remoteToken: "engine-token", intervalMs: 30_000 };

/** 鉴权直通桩：配置门之后的转发用例一律视为已登录（不接 JWT/DB）。 */
const passAuth: MiddlewareHandler = async (_c, next) => next();

/** 一次上游调用的留痕。 */
interface Call {
  url: string;
  init: RequestInit;
}

/**
 * 构造挂好代理路由的临时 app。
 * @param cfg    引擎配置（默认 CFG_ON；传 null 测总门 404）。
 * @param realAuth  true 时不注入鉴权桩 → 走生产真 requireActiveUser（测 401）。
 * @param responder 假上游：默认 200 {ok:true}；抛异常模拟 fetch reject。
 */
function harness(opts: {
  cfg?: ReplicaSyncConfig | null;
  realAuth?: boolean;
  responder?: (url: string, init: RequestInit) => Response | Promise<Response>;
} = {}) {
  const cfg = opts.cfg === undefined ? CFG_ON : opts.cfg;
  const responder = opts.responder ?? (() => jsonResp(200, { ok: true }));
  const calls: Call[] = [];

  // 普通闭包假 fetch：原样收到生产代码拼好的 url/init（不经 undici，故可直接断言头对象）。
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  };
  const fetchImpl = fakeFetch as unknown as LocalSyncProxyFetch;

  const routes = createLocalSyncProxyRoutes({
    fetchImpl,
    config: () => cfg,
    ...(opts.realAuth ? {} : { authMiddleware: passAuth }),
  });

  const app = new Hono();
  // 与生产 guards.errorResponse 对 HttpError 的映射同形（状态码 + {error,code}）。
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: err.message, code: err.code ?? errorCodeForStatus(err.status) },
        err.status as ContentfulStatusCode,
      );
    }
    throw err;
  });
  app.route(MOUNT, routes);
  return { app, calls };
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 合法 cuid 风 id（23 位小写字母数字，落在 20–40 白名单内）。 */
const ID = "ckq9x0p4a00000123abcdef";

// ─────────────────────────────── A. 两道闸 ───────────────────────────────

describe("A. 闸门：默认关闭 404 优先于鉴权/转发", () => {
  it("config=null 时 GET / → 404 SYNC_DISABLED，且假 fetch 未被调用", async () => {
    const h = harness({ cfg: null });
    const res = await h.app.request(`${MOUNT}?status=conflict`, { method: "GET" });
    expect(res.status).toBe(404);
    expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
    expect(h.calls).toHaveLength(0);
  });

  it("config=null 时 POST retry/resolve 同样 404，且不发上游", async () => {
    const h = harness({ cfg: null });
    const r1 = await h.app.request(`${MOUNT}/${ID}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const r2 = await h.app.request(`${MOUNT}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolveOf: "x", decision: "mine" }),
    });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });

  it("config on + 生产默认鉴权 + 无凭证 → 401，且不发上游（真 requireActiveUser，无 token 不触库）", async () => {
    const h = harness({ realAuth: true });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });
});

// ─────────────────────── B. GET incoming 列表透传 ───────────────────────

describe("B. GET / 转发远端 incoming 列表", () => {
  it("URL/query 白名单/X-GX-Token 头正确，剥除浏览器 Authorization/Cookie；信封原样 200", async () => {
    const upstreamPage = {
      result: {
        items: [
          {
            id: ID,
            clientOpId: "op-1",
            baseId: "b1",
            entityType: "record",
            entityId: "rec-1",
            op: "update",
            payload: {},
            baseVersion: "10",
            status: "conflict",
            reasonCode: "VERSION_CONFLICT",
            reasonDetail: null,
            serverVersion: "11",
            conflictServerPayload: { name: "他们的名字" },
            attempts: 1,
            createdAt: "2026-10-20T00:00:00.000Z",
            decidedAt: null,
          },
        ],
        count: 1,
      },
    };
    const h = harness({ responder: () => jsonResp(200, upstreamPage) });
    const res = await h.app.request(
      `${MOUNT}?status=conflict,quarantined&baseId=b1&limit=10&evil=drop&foo=bar`,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer browser-jwt",
          Cookie: "sid=stolen",
          "X-Extra": "x",
        },
      },
    );

    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    // 远端路径逐字对齐 /api/v1/sync/incoming；query 仅白名单三键，杂键被丢弃。
    expect(call.url.startsWith(`${REMOTE}/api/v1/sync/incoming?`)).toBe(true);
    const u = new URL(call.url);
    expect(u.searchParams.get("status")).toBe("conflict,quarantined");
    expect(u.searchParams.get("baseId")).toBe("b1");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.has("evil")).toBe(false);
    expect(u.searchParams.has("foo")).toBe(false);

    const headers = call.init.headers as Record<string, string>;
    expect(headers["X-GX-Token"]).toBe("engine-token");
    expect(headers["content-type"]).toBe("application/json");
    // 浏览器给侧车的对外身份头绝不随行（头对象由侧车白名单重建）。
    expect("authorization" in headers).toBe(false);
    expect("Authorization" in headers).toBe(false);
    expect("cookie" in headers).toBe(false);
    expect("Cookie" in headers).toBe(false);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();

    const body = await readJson<typeof upstreamPage>(res);
    expect(body).toEqual(upstreamPage);
    expect(body.result.items[0]!.conflictServerPayload).toEqual({ name: "他们的名字" });
  });

  it("无 query 时不拼前导 ?", async () => {
    const h = harness({ responder: () => jsonResp(200, { result: { items: [], count: 0 } }) });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toBe(`${REMOTE}/api/v1/sync/incoming`);
  });

  it("remoteUrl 尾斜杠被剥掉，不产生 //", async () => {
    const h = harness({
      cfg: { ...CFG_ON, remoteUrl: "http://remote.example.test:59999///" },
      responder: () => jsonResp(200, { result: { items: [], count: 0 } }),
    });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toBe(`${REMOTE}/api/v1/sync/incoming`);
  });
});

// ─────────────────────── C. retry / discard 转发 ───────────────────────

describe("C. POST /:id/retry 与 /:id/discard", () => {
  it("retry：路径含 id，body 为空 JSON 对象 {}", async () => {
    const upstream = {
      result: { id: ID, clientOpId: "op-1", status: "accepted", attempts: 2 },
    };
    const h = harness({ responder: () => jsonResp(200, upstream) });
    const res = await h.app.request(`${MOUNT}/${ID}/retry`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`${REMOTE}/api/v1/sync/incoming/${ID}/retry`);
    expect(h.calls[0]!.init.method).toBe("POST");
    expect(h.calls[0]!.init.body).toBe("{}");
    expect(await readJson(res)).toEqual(upstream);
  });

  it("discard：忽略浏览器 body，侧车固定发 {\"confirm\":true}", async () => {
    const upstream = { result: { id: ID, status: "dropped" } };
    const h = harness({ responder: () => jsonResp(200, upstream) });
    // 浏览器即便没带 confirm / 带了别的字段，也不影响侧车发出的固定 body。
    const res = await h.app.request(`${MOUNT}/${ID}/discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false, weird: 1 }),
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toBe(`${REMOTE}/api/v1/sync/incoming/${ID}/discard`);
    expect(h.calls[0]!.init.body).toBe(JSON.stringify({ confirm: true }));
    expect(await readJson(res)).toEqual(upstream);
  });
});

// ───────────────────────── D. /resolve 白名单 ─────────────────────────

describe("D. POST /resolve：字段白名单与 decision 三值", () => {
  it("mine：仅透传 resolveOf/decision/clientOpId/patch，compound/replayData/杂键被剥离", async () => {
    const upstream = {
      result: {
        resolveOf: "op-conflict-1",
        decision: "mine",
        status: "accepted",
        baseId: "b1",
        entityId: "rec-1",
        newClientOpId: "op-replay-1",
        seq: "99",
        newVersion: "12",
      },
    };
    const h = harness({ responder: () => jsonResp(200, upstream) });
    const res = await h.app.request(`${MOUNT}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resolveOf: "op-conflict-1",
        decision: "mine",
        clientOpId: "op-replay-1",
        patch: { name: "新名字" },
        compound: { steps: [{ evil: true }] },
        replayData: true,
        injected: "drop-me",
      }),
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]!.url).toBe(`${REMOTE}/api/v1/sync/resolve`);
    const sent = JSON.parse(h.calls[0]!.init.body as string) as Record<string, unknown>;
    expect(sent).toEqual({
      resolveOf: "op-conflict-1",
      decision: "mine",
      clientOpId: "op-replay-1",
      patch: { name: "新名字" },
    });
    expect(sent).not.toHaveProperty("compound");
    expect(sent).not.toHaveProperty("replayData");
    expect(await readJson(res)).toEqual(upstream);
  });

  it.each(["compound", "replayData", "keep_both", "", "MINE", 123])(
    "非法 decision=%p → 侧车本地 400 SYNC_RESOLVE_BAD_DECISION，不发上游",
    async (decision) => {
      const h = harness();
      const res = await h.app.request(`${MOUNT}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolveOf: "op-1", decision }),
      });
      expect(res.status).toBe(400);
      expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_RESOLVE_BAD_DECISION");
      expect(h.calls).toHaveLength(0);
    },
  );

  it("theirs：无 patch/clientOpId 时只发两个键", async () => {
    const h = harness({
      responder: () =>
        jsonResp(200, { result: { resolveOf: "op-1", decision: "theirs", status: "dropped" } }),
    });
    const res = await h.app.request(`${MOUNT}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolveOf: "op-1", decision: "theirs" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(h.calls[0]!.init.body as string)).toEqual({
      resolveOf: "op-1",
      decision: "theirs",
    });
  });

  it("custom：patch 对象随白名单透传", async () => {
    const h = harness({
      responder: () =>
        jsonResp(200, { result: { resolveOf: "op-1", decision: "custom", status: "accepted" } }),
    });
    const res = await h.app.request(`${MOUNT}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolveOf: "op-1", decision: "custom", patch: { v: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(h.calls[0]!.init.body as string)).toEqual({
      resolveOf: "op-1",
      decision: "custom",
      patch: { v: 1 },
    });
  });
});

// ───────────────────────── E. 上游状态码映射 ─────────────────────────

describe("E. 上游响应保真与故障归一", () => {
  it("上游 409 SYNC_RESOLVE_NOT_CONFLICT 原样以 409 透传到前端", async () => {
    const upstream = { error: "冲突状态已被另一端改变", code: "SYNC_RESOLVE_NOT_CONFLICT" };
    const h = harness({ responder: () => jsonResp(409, upstream) });
    const res = await h.app.request(`${MOUNT}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolveOf: "op-1", decision: "mine" }),
    });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toEqual(upstream);
  });

  it("上游 404 不被误判为本地 SYNC_DISABLED：保 404 + 透传上游 JSON", async () => {
    const upstream = { error: "incoming 不存在", code: "NOT_FOUND" };
    const h = harness({ responder: () => jsonResp(404, upstream) });
    const res = await h.app.request(`${MOUNT}/${ID}/retry`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    const body = await readJson<{ code: string }>(res);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.code).not.toBe("SYNC_DISABLED");
  });

  it("上游 400 非 JSON（纯文本）→ 保 400 + 兜底信封 SYNC_UPSTREAM_ERROR", async () => {
    const h = harness({
      responder: () => new Response("bad request text", { status: 400 }),
    });
    const res = await h.app.request(`${MOUNT}/${ID}/retry`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; code: string }>(res);
    expect(body.code).toBe("SYNC_UPSTREAM_ERROR");
    expect(body.error).toContain("400");
  });

  it("上游 500 带 JSON → 状态码与体透传", async () => {
    const upstream = { error: "远端内部错误", code: "INTERNAL" };
    const h = harness({ responder: () => jsonResp(500, upstream) });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual(upstream);
  });

  it("上游 502 HTML 错页（非 JSON）→ 侧车归一 502 SYNC_UPSTREAM_UNREACHABLE", async () => {
    const h = harness({
      responder: () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(502);
    expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_UPSTREAM_UNREACHABLE");
  });

  it("fetch reject（连接被拒绝/DNS/超时）→ 502 SYNC_UPSTREAM_UNREACHABLE", async () => {
    const h = harness({
      responder: () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(502);
    const body = await readJson<{ error: string; code: string }>(res);
    expect(body.code).toBe("SYNC_UPSTREAM_UNREACHABLE");
    expect(body.error).toBe("无法连接远端服务器");
  });

  it("上游 200 但返回非 JSON → 502 SYNC_UPSTREAM_UNREACHABLE（不当成成功）", async () => {
    const h = harness({
      responder: () => new Response("ok-but-not-json", { status: 200 }),
    });
    const res = await h.app.request(MOUNT, { method: "GET" });
    expect(res.status).toBe(502);
    expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_UPSTREAM_UNREACHABLE");
  });
});

// ───────────────────────── F. :id 路径穿越/非法字符 ─────────────────────────

describe("F. :id 白名单（防路径穿越，全部本地 400 不发上游）", () => {
  it.each([
    ["%2E%2E%2Fetc%2Fpass", "编码 ../etc/pass"],
    ["..%2Fetc", "编码 ../etc"],
    ["a%2Fb", "编码 a/b"],
    ["bad id!", "含空格与感叹号"],
    ["short", "长度不足 20"],
    ["CKQ9X0P4A00000123ABCDEF", "大写字母不放行"],
  ])("retry 非法 id %s（%s）→ 400 SYNC_BAD_REQUEST", async (encoded) => {
    const h = harness();
    const res = await h.app.request(`${MOUNT}/${encoded}/retry`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_BAD_REQUEST");
    expect(h.calls).toHaveLength(0);
  });

  it("retry 纯字面 .. → 路由层 404 或处理器 400 任一拦截，且绝不发上游", async () => {
    // Hono 路由在进 handler/checkIncomingId 前会把纯字面 `..` 段做路径规范化 → 404（非 JSON 体）；
    // 编码形态（%2E%2E 等）则进 handler 被白名单拒为 400。两者都满足防穿越安全意图：本地拦截、
    // calls=0。此用例只锁「不被当成正常 id 转发」，不锁具体由哪一层拦截（实现层细节）。
    const h = harness();
    const res = await h.app.request(`${MOUNT}/../retry`, { method: "POST", body: "{}" });
    expect([400, 404]).toContain(res.status);
    expect(h.calls).toHaveLength(0);
  });

  it("discard 端点同样拒绝编码穿越 id", async () => {
    const h = harness();
    const res = await h.app.request(`${MOUNT}/..%2Fetc%2Fpass/discard`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(400);
    expect((await readJson<{ code: string }>(res)).code).toBe("SYNC_BAD_REQUEST");
    expect(h.calls).toHaveLength(0);
  });
});

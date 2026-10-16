// handshake.ts 测试（纯 node、注入 fake fetch，无真实网络）。
import { describe, it, expect, vi } from "vitest";
import {
  parseSemver,
  isNodeVersionCompatible,
  handshakeNode,
  loginRemoteNode,
  HandshakeError,
  RemoteLoginError,
  type FetchLike,
} from "./handshake";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 按 URL 子串路由的 fake fetch；返回 (url)=>Response 映射（统一包成 Promise）。 */
function fakeFetch(route: (url: string, init?: RequestInit) => Response): FetchLike {
  return async (url, init) => route(url, init);
}

describe("parseSemver", () => {
  it("解析 x.y.z / 带 v 前缀 / 带预发布后缀", () => {
    expect(parseSemver("0.2.4")).toEqual([0, 2, 4]);
    expect(parseSemver("v1.3.0")).toEqual([1, 3, 0]);
    expect(parseSemver("2.0.0-beta.1")).toEqual([2, 0, 0]);
  });
  it("非法输入返回 null", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("isNodeVersionCompatible", () => {
  it("同 major 且 >= 门槛 → 兼容", () => {
    expect(isNodeVersionCompatible("0.2.5", "0.2.4")).toBe(true);
    expect(isNodeVersionCompatible("0.2.4", "0.2.4")).toBe(true);
    expect(isNodeVersionCompatible("0.3.0", "0.2.4")).toBe(true);
  });
  it("同 major 但低于门槛 → 不兼容", () => {
    expect(isNodeVersionCompatible("0.2.3", "0.2.4")).toBe(false);
    expect(isNodeVersionCompatible("0.1.9", "0.2.4")).toBe(false);
  });
  it("major 不同（含 0.x→1.x）→ 不兼容", () => {
    expect(isNodeVersionCompatible("1.0.0", "0.2.4")).toBe(false);
    expect(isNodeVersionCompatible("0.2.4", "1.0.0")).toBe(false);
  });
  it("无门槛：只要版本合法即放行；非法 fail-closed", () => {
    expect(isNodeVersionCompatible("9.9.9")).toBe(true);
    expect(isNodeVersionCompatible("nope", "0.2.4")).toBe(false);
  });
});

describe("handshakeNode", () => {
  // 用工厂而非共享常量：Response.body 只能被读一次，跨用例/多次请求必须各自新建。
  const okBootstrap = () => jsonResponse({ initialized: true, signupOpen: false });
  const okHealth = () => jsonResponse({ status: "ok", version: "0.2.4" });

  it("三探活齐全 → 返回版本/初始化态，meta 404 也放行（meta=null）", async () => {
    const f = vi.fn((url: string) => {
      if (url.endsWith("/api/health")) return okHealth();
      if (url.endsWith("/bootstrap-status")) return okBootstrap();
      if (url.endsWith("/api/v1/meta")) return new Response("no", { status: 404 });
      return new Response("?", { status: 404 });
    });
    const h = await handshakeNode({
      baseURL: "http://node:3001",
      minNodeVersion: "0.2.4",
      fetchImpl: fakeFetch(f),
    });
    expect(h.version).toBe("0.2.4");
    expect(h.initialized).toBe(true);
    expect(h.meta).toBeNull();
  });

  it("绝对 baseURL + 子路径被正确拼接（无重复斜杠）", async () => {
    const seen: string[] = [];
    const f = (url: string) => {
      seen.push(url);
      if (url.endsWith("/api/health")) return okHealth();
      if (url.endsWith("/bootstrap-status")) return okBootstrap();
      return new Response("no", { status: 404 });
    };
    await handshakeNode({ baseURL: "https://nas/app/gx", fetchImpl: fakeFetch(f) });
    expect(seen).toContain("https://nas/app/gx/api/health");
    expect(seen).toContain("https://nas/app/gx/api/auth/bootstrap-status");
  });

  it("health 连不上（fetch reject）→ unreachable", async () => {
    await expect(
      handshakeNode({
        baseURL: "http://x:1",
        fetchImpl: () => Promise.reject(new TypeError("network")),
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("health 非 2xx → not_a_node", async () => {
    const f = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(handshakeNode({ baseURL: "http://x", fetchImpl: f })).rejects.toBeInstanceOf(
      HandshakeError,
    );
    await expect(handshakeNode({ baseURL: "http://x", fetchImpl: f })).rejects.toMatchObject({
      code: "not_a_node",
    });
  });

  it("health 无 version 字段 → not_a_node", async () => {
    const f = fakeFetch((url) =>
      url.endsWith("/api/health") ? jsonResponse({ status: "ok" }) : okBootstrap(),
    );
    await expect(handshakeNode({ baseURL: "http://x", fetchImpl: f })).rejects.toMatchObject({
      code: "not_a_node",
    });
  });

  it("版本过低 → version_incompatible", async () => {
    const f = fakeFetch((url) =>
      url.endsWith("/api/health")
        ? jsonResponse({ version: "0.1.0" })
        : okBootstrap(),
    );
    await expect(
      handshakeNode({ baseURL: "http://x", minNodeVersion: "0.2.4", fetchImpl: f }),
    ).rejects.toMatchObject({ code: "version_incompatible" });
  });

  it("远端未初始化（空库）→ not_initialized（瘦客户端不承接自举）", async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith("/api/health")) return okHealth();
      if (url.endsWith("/bootstrap-status"))
        return jsonResponse({ initialized: false, signupOpen: true });
      return new Response("no", { status: 404 });
    });
    await expect(handshakeNode({ baseURL: "http://x", fetchImpl: f })).rejects.toMatchObject({
      code: "not_initialized",
    });
  });

  it("meta 200 时纳入画像", async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith("/api/health")) return okHealth();
      if (url.endsWith("/bootstrap-status")) return okBootstrap();
      if (url.endsWith("/api/v1/meta"))
        return jsonResponse({ apiVersion: "v1", enterpriseOrg: true });
      return new Response("?", { status: 404 });
    });
    const h = await handshakeNode({ baseURL: "http://x", fetchImpl: f });
    expect(h.meta).toEqual({ apiVersion: "v1", enterpriseOrg: true });
  });
});

describe("loginRemoteNode", () => {
  it("成功：POST 到显式远端 base、JSON body、返回 token+user，不带本地凭据", async () => {
    const f = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toBe("http://node:3001/api/auth/login");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(init!.body as string)).toEqual({ email: "a@b.c", password: "pw" });
      return jsonResponse({ token: "remote-jwt", user: { id: "u1", email: "a@b.c" } });
    });
    const r = await loginRemoteNode({
      baseURL: "http://node:3001",
      email: "a@b.c",
      password: "pw",
      fetchImpl: fakeFetch(f),
    });
    expect(r.token).toBe("remote-jwt");
    expect(r.user.id).toBe("u1");
  });

  it("401 → invalid_credentials（RemoteLoginError）", async () => {
    const f = fakeFetch(() => jsonResponse({ error: "凭据错误" }, 401));
    await expect(
      loginRemoteNode({ baseURL: "http://x", email: "e", password: "p", fetchImpl: f }),
    ).rejects.toMatchObject({ code: "invalid_credentials", status: 401 });
  });

  it("网络错误 → unreachable", async () => {
    const f = () => Promise.reject(new TypeError("CORS/network"));
    await expect(
      loginRemoteNode({ baseURL: "http://x", email: "e", password: "p", fetchImpl: f }),
    ).rejects.toBeInstanceOf(RemoteLoginError);
  });

  it("200 但无 token → error（形态不符 fail-closed）", async () => {
    const f = fakeFetch(() => jsonResponse({ something: "else" }));
    await expect(
      loginRemoteNode({ baseURL: "http://x", email: "e", password: "p", fetchImpl: f }),
    ).rejects.toMatchObject({ code: "error" });
  });
});

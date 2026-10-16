// 节点模式 S2 第 1 片：apiFetch 主请求路径接数据源解析器的接线测试（node 环境，stub fetch）。
//
// 本片只把 apiFetch 的 URL 与鉴权头改为读 dataSourceResolver 单例，**不改任何分流/跳转逻辑**。
// 铁律（DESIGN §8.5 + #817）：
//   ① golden：恒 local（现状默认）时，请求 URL == 旧 `${BASE_URL}${path}`、
//      头 == authHeaders(<auth store token>)，对浏览器/fnOS 现网零行为变化；
//   ② 启动器 setActive(remote) 后，主路径改打远端绝对地址、带远端 token、绝不串本地 token；
//   ③ setActive(null) 回落 local（空态/全断开上千既有调用点仍同步可读）。
// 401 按 kind 分流、裸 fetch 点（头像/csv/multipart）切源在后续切片覆盖，本文件不预设其行为。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiFetch,
  Auth,
  Tables,
  EmbeddingAdminApi,
  PatsApi,
  probeNavV2,
} from "../client";
import { useAuthStore } from "../../store/auth";
import { dataSourceResolver } from "../../node/datasource";
import type { ActiveDataSource } from "../../node/datasource";

const REMOTE: ActiveDataSource = {
  nodeId: "abcdef012345",
  kind: "remote",
  baseURL: "http://remote.example:3001",
  token: "remote-jwt",
  wsOrigin: "ws://remote.example:3001",
};

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // 每个文件模块独立，默认单例恒 local；保险起见显式回落。
  dataSourceResolver.setActive(null);
  useAuthStore.setState({ token: "local-tok", user: null });
});

afterEach(() => {
  dataSourceResolver.setActive(null);
  vi.unstubAllGlobals();
});

describe("golden：恒 local 时 apiFetch 与旧实现逐字节等价", () => {
  it("URL == 本地 base 拼接（vitest 根部署 base 为空 → 原样 /api/...）", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch("/api/auth/me");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/me");
    // 头：JSON content-type + 本地 token 的 X-GX-Token，不带 Authorization
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-GX-Token"]).toBe("local-tok");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("子路径式相对 base 经 resolver 拼接（与 withBase(localBase,path) 同口径）", async () => {
    // 用测试钩子把 active 显式设成一个「相对前缀」的 local 数据源，模拟飞牛子路径部署。
    dataSourceResolver.__setActiveForTest({
      nodeId: "local",
      kind: "local",
      baseURL: "/app/gouxiangdb",
      token: "local-tok",
      wsOrigin: "ws://localhost/app/gouxiangdb",
    });
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch("/api/bases");
    expect(fetchMock.mock.calls[0]![0]).toBe("/app/gouxiangdb/api/bases");
  });

  it("本地 token 实时变化：auth store 换 token，下一次请求即跟随（不缓存旧 token）", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    useAuthStore.setState({ token: "newer-tok" });
    await apiFetch("/api/auth/me");
    expect(fetchMock.mock.calls[0]![1].headers["X-GX-Token"]).toBe("newer-tok");
  });

  it("无本地 token：不带任何鉴权头（空对象，避免触发飞牛网关）", async () => {
    useAuthStore.setState({ token: null });
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch("/api/auth/bootstrap-status");
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-GX-Token"]).toBeUndefined();
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("S2：活动数据源切到 remote 后 apiFetch 改打远端", () => {
  it("URL 用远端绝对 base、头带远端 token、绝不串本地 token", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch("/api/bases");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://remote.example:3001/api/bases");
    expect(init.headers["X-GX-Token"]).toBe("remote-jwt");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("远端 token 与本地 auth store 隔离：本地登出不影响在途远端头", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    useAuthStore.setState({ token: null });
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch("/api/auth/me");
    expect(fetchMock.mock.calls[0]![1].headers["X-GX-Token"]).toBe("remote-jwt");
  });

  it("setActive(null) 回落 local：URL 与头回到本地口径", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    dataSourceResolver.setActive(null);
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch("/api/auth/me");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/me");
    expect(init.headers["X-GX-Token"]).toBe("local-tok");
  });
});

// 手写 fetch 的鉴权端点（不经 apiFetch）：S2-2 起同样跟数据源。
// golden 重点：local 下各端点的「头风格」必须与改造前逐字节一致——
//   uploadAvatar / clearApiKey 历史走 Authorization: Bearer（保留）；
//   exportCsvText / pats.revoke / branding.uploadHero 走 X-GX-Token。
describe("S2-2：client.ts 内手写鉴权 fetch 跟数据源", () => {
  it("uploadAvatar（local）：URL 本地 + 仍是 Authorization Bearer（不改成 X-GX-Token）", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {} }));
    await Auth.uploadAvatar(new File(["x"], "a.png", { type: "image/png" }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/me/avatar");
    expect(init.headers["Authorization"]).toBe("Bearer local-tok");
    expect(init.headers["X-GX-Token"]).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined(); // multipart 不注入
  });

  it("uploadAvatar（remote）：打远端、带远端 Bearer", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    fetchMock.mockResolvedValue(jsonResponse({ user: {} }));
    await Auth.uploadAvatar(new File(["x"], "a.png", { type: "image/png" }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://remote.example:3001/api/auth/me/avatar");
    expect(init.headers["Authorization"]).toBe("Bearer remote-jwt");
  });

  it("exportCsvText（local）：X-GX-Token，无 Authorization", async () => {
    fetchMock.mockResolvedValue(new Response("a,b\n1,2", { status: 200 }));
    await Tables.exportCsvText("t1", "v1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/tables/t1/export.csv?viewId=v1");
    expect(init.headers["X-GX-Token"]).toBe("local-tok");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("exportCsvText（remote）：打远端绝对地址 + 远端 token", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await Tables.exportCsvText("t1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://remote.example:3001/api/tables/t1/export.csv",
    );
    expect(fetchMock.mock.calls[0]![1].headers["X-GX-Token"]).toBe("remote-jwt");
  });

  it("clearApiKey（local）：DELETE 本地 + 仍是 Bearer", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await EmbeddingAdminApi.clearApiKey();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/admin/embedding/api-key");
    expect(init.method).toBe("DELETE");
    expect(init.headers["Authorization"]).toBe("Bearer local-tok");
  });

  it("pats.revoke（local）：DELETE 本地 + X-GX-Token", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await PatsApi.revoke("pat 1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/pats/pat%201");
    expect(init.method).toBe("DELETE");
    expect(init.headers["X-GX-Token"]).toBe("local-tok");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("pats.revoke（remote）：打远端 + 远端 token", async () => {
    dataSourceResolver.__setActiveForTest(REMOTE);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await PatsApi.revoke("p1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://remote.example:3001/api/v1/pats/p1",
    );
    expect(fetchMock.mock.calls[0]![1].headers["X-GX-Token"]).toBe("remote-jwt");
  });
});

describe("S2-6：nav flag 探活缓存随节点切换失效", () => {
  it("同一节点第二次命中缓存不重探；切到另一节点后必须重新发请求", async () => {
    // local：第一次探活打一次 /menu（每次返回新 Response，body 才能被多次 json() 读取）
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ tree: [] })),
    );
    await probeNavV2();
    await probeNavV2();
    const localMenuCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].endsWith("/menu"),
    ).length;
    expect(localMenuCalls).toBe(1);

    // 切到远端节点：缓存失效，再探一次且打到远端
    dataSourceResolver.__setActiveForTest(REMOTE);
    await probeNavV2();
    const remoteMenuCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "http://remote.example:3001/api/v1/workspaces/current/menu",
    ).length;
    expect(remoteMenuCalls).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(2); // local 首探 1（次探命中缓存）+ remote 重探 1
  });
});

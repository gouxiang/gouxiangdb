// datasource.ts 测试（纯 node、无 jsdom、无新依赖）。
//
// 最重要的是 **golden 等价**：S1 恒返回 local，且其 baseURL / headers / baseFor / wsOrigin
// 必须与今天的既有实现逐字节同口径：
//   baseURL  == resolveApiBase(VITE_API_URL, BASE_URL)
//   headers  == authHeaders(<local token>)
//   baseFor  == withBase(localBase, path)
//   wsOrigin == collab defaultOrigin(toWsOrigin(window.location.origin)) + basePath
// 通过工厂依赖注入，在多组部署输入（根 / 子路径 / 显式 VITE_API_URL）下逐项锁死。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveApiBase, withBase } from "../lib/base";
import { authHeaders } from "../api/authHeader";
import { useAuthStore } from "../store/auth";
import { toWsOrigin } from "./resolve";
import { createDataSourceResolver, dataSourceResolver, type ActiveDataSource } from "./datasource";

const ORIGIN = "http://localhost:5173";

/** 用与 api/client.ts 完全相同的取值方式构造 localBase（golden 对照基准）。 */
function goldenResolver(
  viteApiUrl: string | undefined,
  baseUrl: string | undefined,
  token: string | null,
) {
  const localBase = resolveApiBase(viteApiUrl, baseUrl);
  const resolver = createDataSourceResolver({
    getLocalBase: () => resolveApiBase(viteApiUrl, baseUrl),
    getOrigin: () => ORIGIN,
    getLocalToken: () => token,
  });
  return { resolver, localBase };
}

// 多组部署输入：[场景, VITE_API_URL, BASE_URL]
const DEPLOY_CASES: Array<[string, string | undefined, string | undefined]> = [
  ["根部署（无显式 API）", undefined, "/"],
  ["飞牛子路径部署", undefined, "/app/gouxiangdb/"],
  ["显式绝对 VITE_API_URL（去尾斜杠）", "http://127.0.0.1:3001/", undefined],
  ["显式 https 独立域名", "https://api.example.com", "/"],
];

describe("golden：local baseURL 与 resolveApiBase 逐字节相等", () => {
  for (const [label, apiUrl, baseUrl] of DEPLOY_CASES) {
    it(label, () => {
      const { resolver, localBase } = goldenResolver(apiUrl, baseUrl, "tok");
      const cur = resolver.current();
      expect(cur.baseURL).toBe(resolveApiBase(apiUrl, baseUrl));
      expect(cur.baseURL).toBe(localBase);
      // 初始恒 local
      expect(cur.kind).toBe("local");
      expect(cur.nodeId).toBe("local");
    });
  }
});

describe("golden：headers 与现有 authHeaders(<local token>) 深度相等", () => {
  it("有 token：{ 'X-GX-Token': token }，不带 Authorization", () => {
    const { resolver } = goldenResolver(undefined, "/", "jwt-abc");
    expect(resolver.headers()).toEqual(authHeaders("jwt-abc"));
    expect(resolver.headers()).toEqual({ "X-GX-Token": "jwt-abc" });
    expect(resolver.headers()["Authorization"]).toBeUndefined();
  });

  it("无 token：{}（不产生空头，避免触发飞牛网关校验）", () => {
    const { resolver } = goldenResolver(undefined, "/", null);
    expect(resolver.headers()).toEqual(authHeaders(null));
    expect(resolver.headers()).toEqual({});
  });

  it("子路径部署下 header 形态不变", () => {
    const { resolver } = goldenResolver(undefined, "/app/gouxiangdb/", "t");
    expect(resolver.headers()).toEqual(authHeaders("t"));
  });
});

describe("golden：baseFor 与 withBase(localBase, path) 相等", () => {
  for (const [label, apiUrl, baseUrl] of DEPLOY_CASES) {
    it(label, () => {
      const { resolver, localBase } = goldenResolver(apiUrl, baseUrl, "tok");
      expect(resolver.baseFor("/api/x")).toBe(withBase(localBase, "/api/x"));
    });
  }

  it("根部署：/api/x 原样", () => {
    const { resolver } = goldenResolver(undefined, "/", null);
    expect(resolver.baseFor("/api/x")).toBe("/api/x");
  });

  it("子路径部署：补网关前缀", () => {
    const { resolver } = goldenResolver(undefined, "/app/gouxiangdb/", null);
    expect(resolver.baseFor("/api/x")).toBe("/app/gouxiangdb/api/x");
  });

  it("绝对 URL 资源原样透传（withBase 既有行为）", () => {
    const { resolver } = goldenResolver(undefined, "/", null);
    expect(resolver.baseFor("https://cdn/x.png")).toBe("https://cdn/x.png");
  });
});

describe("golden：wsOrigin 与 collab defaultOrigin 同口径", () => {
  it("根部署：toWsOrigin(window.location.origin)（== collab 行为）", () => {
    const { resolver } = goldenResolver(undefined, "/", null);
    expect(resolver.current().wsOrigin).toBe(toWsOrigin(ORIGIN));
    expect(resolver.current().wsOrigin).toBe("ws://localhost:5173");
  });

  it("子路径部署：ws origin 拼网关前缀", () => {
    const { resolver } = goldenResolver(undefined, "/app/gouxiangdb/", null);
    const localBase = resolveApiBase(undefined, "/app/gouxiangdb/");
    expect(resolver.current().wsOrigin).toBe(`${toWsOrigin(ORIGIN)}${localBase}`);
    expect(resolver.current().wsOrigin).toBe("ws://localhost:5173/app/gouxiangdb");
  });

  it("https 页面 → wss", () => {
    const resolver = createDataSourceResolver({
      getLocalBase: () => resolveApiBase(undefined, "/app/gouxiangdb/"),
      getOrigin: () => "https://gateway.example",
      getLocalToken: () => null,
    });
    expect(resolver.current().wsOrigin).toBe("wss://gateway.example/app/gouxiangdb");
  });
});

describe("默认单例 dataSourceResolver（零接线模块仍可直接用）", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null });
  });

  it("初始 kind/nodeId 恒为 local，token 实时读 auth store", () => {
    expect(dataSourceResolver.current().kind).toBe("local");
    expect(dataSourceResolver.current().nodeId).toBe("local");
    expect(dataSourceResolver.current().token).toBeNull();

    useAuthStore.setState({ token: "singleton-tok" });
    // current() 每次实时读 store，不缓存
    expect(dataSourceResolver.current().token).toBe("singleton-tok");
    expect(dataSourceResolver.headers()).toEqual({ "X-GX-Token": "singleton-tok" });
  });

  it("默认 localBase 取自 import.meta.env（vitest 下为根部署 → 空串）", () => {
    const expected = resolveApiBase(
      (import.meta.env.VITE_API_URL as string | undefined) ?? undefined,
      import.meta.env.BASE_URL as string | undefined,
    );
    expect(dataSourceResolver.current().baseURL).toBe(expected);
    expect(dataSourceResolver.baseFor("/api/health")).toBe(withBase(expected, "/api/health"));
  });
});

describe("wsHostOrigin：协同 WS 纯 host origin（双前缀防护 golden）", () => {
  const remoteHost: ActiveDataSource = {
    nodeId: "abcdef012345",
    kind: "remote",
    baseURL: "http://remote:3001",
    token: "remote-jwt",
    wsOrigin: "ws://remote:3001",
  };

  it("local 根部署：ws://页面 host（不含任何路径）", () => {
    const resolver = createDataSourceResolver({
      getLocalBase: () => "",
      getOrigin: () => "http://localhost:5173",
      getLocalToken: () => null,
    });
    expect(resolver.wsHostOrigin()).toBe("ws://localhost:5173");
  });

  it("local 子路径部署：仍只取页面 host，绝不拼 /app/gouxiangdb（防双前缀）", () => {
    const resolver = createDataSourceResolver({
      getLocalBase: () => "/app/gouxiangdb",
      getOrigin: () => "https://nas.local",
      getLocalToken: () => null,
    });
    expect(resolver.wsHostOrigin()).toBe("wss://nas.local");
  });

  it("remote 根部署：反解远端 host", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    resolver.__setActiveForTest(remoteHost);
    expect(resolver.wsHostOrigin()).toBe("ws://remote:3001");
  });

  it("remote 子路径 baseURL：只取 host，丢弃 pathname", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    resolver.__setActiveForTest({
      ...remoteHost,
      baseURL: "https://nas.remote/app/gouxiangdb",
    });
    expect(resolver.wsHostOrigin()).toBe("wss://nas.remote");
  });

  it("setActive(null) 回落 local：host origin 也回到页面 host", () => {
    const resolver = createDataSourceResolver({
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => null,
    });
    resolver.__setActiveForTest(remoteHost);
    expect(resolver.wsHostOrigin()).toBe("ws://remote:3001");
    resolver.setActive(null);
    expect(resolver.wsHostOrigin()).toBe(toWsOrigin(ORIGIN));
  });
});

describe("subscribe：为后续 remote 预留的切换通知（仅测试触达）", () => {
  const remote: ActiveDataSource = {
    nodeId: "abcdef012345",
    kind: "remote",
    baseURL: "http://remote:3001",
    token: "remote-jwt",
    wsOrigin: "ws://remote:3001",
  };

  it("active 变化时通知订阅者，current() 随之切换", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    const fn = vi.fn();
    resolver.subscribe(fn);

    expect(resolver.current().kind).toBe("local");
    resolver.__setActiveForTest(remote);

    expect(fn).toHaveBeenCalledOnce();
    expect(resolver.current()).toEqual(remote);
    expect(resolver.headers()).toEqual({ "X-GX-Token": "remote-jwt" });
    expect(resolver.baseFor("/api/x")).toBe("http://remote:3001/api/x");
  });

  it("取消函数生效：取消后不再被通知", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    const fn = vi.fn();
    const unsubscribe = resolver.subscribe(fn);

    resolver.__setActiveForTest(remote);
    expect(fn).toHaveBeenCalledOnce();

    unsubscribe();
    resolver.__setActiveForTest({ ...remote, token: "other" });
    expect(fn).toHaveBeenCalledOnce(); // 计数不变
  });

  it("多个订阅者各自独立取消", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    const a = vi.fn();
    const b = vi.fn();
    const offA = resolver.subscribe(a);
    resolver.subscribe(b);

    resolver.__setActiveForTest(remote);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();

    offA();
    resolver.__setActiveForTest({ ...remote, nodeId: "ffffffffffff" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });
});

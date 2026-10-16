// queryClientBridge.ts 纯逻辑测试（node 环境、无 react-query，用 fake Clearable）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDataSourceResolver } from "./datasource";
import {
  registerQueryClient,
  bindQueryClientClearing,
  __resetQueryClientBridgeForTest,
  type Clearable,
} from "./queryClientBridge";
import type { ActiveDataSource } from "./datasource";

const ORIGIN = "http://localhost:5173";

function remoteDs(nodeId: string): ActiveDataSource {
  return {
    nodeId,
    kind: "remote",
    baseURL: `http://${nodeId}:3001`,
    token: "jwt",
    wsOrigin: `ws://${nodeId}:3001`,
  };
}

function fakeClient(): Clearable & { clear: ReturnType<typeof vi.fn> } {
  return { clear: vi.fn() };
}

beforeEach(() => {
  __resetQueryClientBridgeForTest();
});

describe("queryClientBridge：仅 nodeId 变化时清空", () => {
  it("初始 local：同节点重新 setActive（token 变化）不清", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    const c = fakeClient();
    registerQueryClient(c);

    // 从 local（默认）setActive 到另一个 local 数据源：nodeId 不变
    resolver.__setActiveForTest({
      nodeId: "local",
      kind: "local",
      baseURL: "",
      token: "fresh",
      wsOrigin: "ws://localhost:5173",
    });
    expect(c.clear).not.toHaveBeenCalled();
  });

  it("local → remote：清空一次", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    const c = fakeClient();
    registerQueryClient(c);

    resolver.__setActiveForTest(remoteDs("aaaaaaaaaaaa"));
    expect(c.clear).toHaveBeenCalledOnce();
  });

  it("remote A → remote B：清空；多个已注册 client 都被清", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    const c1 = fakeClient();
    const c2 = fakeClient();
    registerQueryClient(c1);
    registerQueryClient(c2);

    resolver.__setActiveForTest(remoteDs("aaaaaaaaaaaa"));
    resolver.__setActiveForTest(remoteDs("bbbbbbbbbbbb"));

    expect(c1.clear).toHaveBeenCalledTimes(2);
    expect(c2.clear).toHaveBeenCalledTimes(2);
  });

  it("remote → local（setActive(null) 回落）：清空", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    const c = fakeClient();
    registerQueryClient(c);

    resolver.__setActiveForTest(remoteDs("aaaaaaaaaaaa"));
    expect(c.clear).toHaveBeenCalledTimes(1);
    resolver.setActive(null); // 回落 local（nodeId 变回 "local"）
    expect(c.clear).toHaveBeenCalledTimes(2);
  });

  it("同一 resolver 重复 bind 幂等：只订阅一次，不重复清", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    bindQueryClientClearing(resolver); // 第二次应短路
    const c = fakeClient();
    registerQueryClient(c);

    resolver.__setActiveForTest(remoteDs("aaaaaaaaaaaa"));
    expect(c.clear).toHaveBeenCalledOnce();
  });

  it("不同 resolver 实例各自独立绑定（测试隔离）", () => {
    const r1 = createDataSourceResolver({ getOrigin: () => ORIGIN });
    const r2 = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(r1);
    bindQueryClientClearing(r2);
    const c = fakeClient();
    registerQueryClient(c);

    r1.__setActiveForTest(remoteDs("aaaaaaaaaaaa"));
    expect(c.clear).toHaveBeenCalledOnce();
    r2.__setActiveForTest(remoteDs("bbbbbbbbbbbb"));
    expect(c.clear).toHaveBeenCalledTimes(2);
  });

  it("未注册 client 时切源不报错", () => {
    const resolver = createDataSourceResolver({ getOrigin: () => ORIGIN });
    bindQueryClientClearing(resolver);
    expect(() => resolver.__setActiveForTest(remoteDs("aaaaaaaaaaaa"))).not.toThrow();
  });
});

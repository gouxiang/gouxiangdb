// NodeLauncherGate SSR 测试（node + react-dom/server + MemoryRouter）：
// 门控关 → Navigate 到 "/"（现网零变化）；门控开 → 装配并渲染启动器面板。
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NodeLauncherGate, enterTargetNow } from "./NodeLauncherGate";
import { createLauncherStore, type LauncherStore } from "./launcherStore";
import { __resetLauncherStoreForTest } from "./launcherStore";
import { dataSourceResolver } from "./datasource";
import { LOCAL_NODE_ID } from "./resolve";
import type { KvStorage } from "./remoteSessions";
import { __resetUnauthorizedBridgeForTest } from "./unauthorizedBridge";

class MemStorage implements KvStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

afterEach(() => {
  __resetUnauthorizedBridgeForTest();
  __resetLauncherStoreForTest();
});

function makeStore(): LauncherStore {
  return createLauncherStore({
    storage: new MemStorage(),
    getLocalBase: () => "",
    getOrigin: () => "http://localhost",
    getLocalToken: () => null,
  });
}

function renderGate(enabled: boolean, store?: LauncherStore) {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/launcher"] },
      React.createElement(NodeLauncherGate, { enabled, store }),
    ),
  );
}

describe("NodeLauncherGate", () => {
  it("门控关闭：渲染对 / 的重定向，不泄漏任何启动器界面", () => {
    const html = renderGate(false);
    // react-router 的 Navigate 在 SSR 下渲染为空（副作用组件），关键是不出现面板内容。
    expect(html).not.toContain("构想工作台");
    expect(html).not.toContain("添加网络节点");
  });

  it("门控开启：渲染启动器面板（新装空态为欢迎卡双入口，不自动展开添加表单）", () => {
    const html = renderGate(true, makeStore());
    expect(html).toContain("构想工作台");
    expect(html).toContain("在这台电脑上开始");
    expect(html).toContain("连接到网络上的另一台电脑");
    expect(html).not.toContain("节点网址");
  });

  it("门控开启且已有节点：渲染列表", () => {
    const store = makeStore();
    store.connectLocal();
    const html = renderGate(true, store);
    expect(html).toContain("本机");
    expect(html).toContain("添加网络节点");
  });
});

// enterTargetNow 在选路成功当拍实时读 resolver 单例（避免闭包里的渲染前快照把带会话直进误判成未登录）。
describe("enterTargetNow（选路成功当拍分流）", () => {
  afterEach(() => {
    dataSourceResolver.setActive(null);
    __resetLauncherStoreForTest();
  });

  function routedStore(): LauncherStore {
    return createLauncherStore({
      storage: new MemStorage(),
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://localhost",
      getLocalToken: () => null,
    });
  }

  it("本机首 boot 未登录（local token=null）→ /login 首管理员引导", async () => {
    const store = routedStore();
    await store.connectLocal();
    expect(dataSourceResolver.current().kind).toBe("local");
    expect(dataSourceResolver.current().nodeId).toBe(LOCAL_NODE_ID);
    expect(enterTargetNow()).toBe("/login");
  });

  it("远端无会话纯选路（remote-empty）→ /login，即该远端节点自己的登录页", async () => {
    const store = routedStore();
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    await store.connectRemote("abc123def456");
    expect(dataSourceResolver.current().kind).toBe("remote");
    expect(enterTargetNow()).toBe("/login");
  });

  it("远端有记住会话（带 JWT）→ / 直接进业务壳", async () => {
    const store = routedStore();
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    store.commitRemoteSession("abc123def456", "remembered-jwt", null);
    await store.connectRemote("abc123def456");
    expect(enterTargetNow()).toBe("/");
  });
});

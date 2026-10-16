// NodeLauncherGate SSR 测试（node + react-dom/server + MemoryRouter）：
// 门控关 → Navigate 到 "/"（现网零变化）；门控开 → 装配并渲染启动器面板。
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NodeLauncherGate } from "./NodeLauncherGate";
import { createLauncherStore, type LauncherStore } from "./launcherStore";
import { __resetLauncherStoreForTest } from "./launcherStore";
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

  it("门控开启：渲染启动器面板（新装空态直落添加表单）", () => {
    const html = renderGate(true, makeStore());
    expect(html).toContain("构想工作台");
    expect(html).toContain("添加网络节点");
    expect(html).toContain("节点网址");
  });

  it("门控开启且已有节点：渲染列表", () => {
    const store = makeStore();
    store.connectLocal();
    const html = renderGate(true, store);
    expect(html).toContain("本机");
    expect(html).toContain("添加网络节点");
  });
});

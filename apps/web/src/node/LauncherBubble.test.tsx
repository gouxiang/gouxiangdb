// LauncherBubble SSR 测试（node + react-dom/server + MemoryRouter）：
// 门控关 → null（现网零 UI）；门控开且有活动节点 → 显示当前源；停在 /launcher 或无活动 → null。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LauncherBubble } from "./LauncherBubble";
import { createLauncherStore, type LauncherStore } from "./launcherStore";
import type { KvStorage } from "./remoteSessions";

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

function makeStore(): LauncherStore {
  return createLauncherStore({
    storage: new MemStorage(),
    getLocalBase: () => "",
    getOrigin: () => "http://localhost",
    getLocalToken: () => null,
  });
}

function renderBubble(pathname: string, enabled: boolean, store?: LauncherStore) {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      React.createElement(LauncherBubble, { enabled, store }),
    ),
  );
}

describe("LauncherBubble", () => {
  it("门控关闭：恒为 null（零 DOM），即便有活动节点", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderBubble("/base/x", false, store)).toBe("");
  });

  it("门控开启 + 活动本地节点：渲染气泡显示「本机」与管理入口", () => {
    const store = makeStore();
    store.connectLocal();
    const html = renderBubble("/base/x", true, store);
    expect(html).toContain("本机");
    expect(html).toContain("管理节点");
  });

  it("门控开启但无活动节点：null", () => {
    expect(renderBubble("/base/x", true, makeStore())).toBe("");
  });

  it("停在 /launcher 时：即便有活动节点也隐藏（避免与面板重复）", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderBubble("/launcher", true, store)).toBe("");
  });

  it("公开分享页 /s/.. 隐藏", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderBubble("/s/tok123", true, store)).toBe("");
  });
});

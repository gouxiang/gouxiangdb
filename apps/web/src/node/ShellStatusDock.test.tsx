// ShellStatusDock SSR 回归（node + react-dom/server + MemoryRouter）：
//   - 门控关（浏览器/fnOS/物理不在壳）恒 null（零 DOM、零副作用）；
//   - 门控开 + 活动节点：渲染底部状态条，含节点名、版本槽、信号格；
//   - 无活动节点 / 停在启动器或公开分享路由：null（口径同旧悬浮球）；
//   - signalLevel 纯函数按在线态+延迟分档。
// SSR 下 useShellHealth/useShellRuntime 的 enabled=false（测试 store shellBound=false），不发 fetch/timer。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ShellStatusDock, signalLevel } from "./ShellStatusDock";
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

function renderDock(pathname: string, enabled: boolean, store?: LauncherStore) {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      React.createElement(ShellStatusDock, { enabled, store }),
    ),
  );
}

describe("signalLevel（按在线态 + 实时延迟分 0–4 档）", () => {
  it("离线 / 无延迟 → 0", () => {
    expect(signalLevel(false, null)).toBe(0);
    expect(signalLevel(true, null)).toBe(0);
  });
  it("延迟越低档位越高（边界 80/200/500）", () => {
    expect(signalLevel(true, 1)).toBe(4);
    expect(signalLevel(true, 79)).toBe(4);
    expect(signalLevel(true, 80)).toBe(3);
    expect(signalLevel(true, 199)).toBe(3);
    expect(signalLevel(true, 200)).toBe(2);
    expect(signalLevel(true, 499)).toBe(2);
    expect(signalLevel(true, 500)).toBe(1);
    expect(signalLevel(true, 3000)).toBe(1);
  });
});

describe("ShellStatusDock", () => {
  it("门控关闭：恒为 null（零 DOM），即便有活动节点", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderDock("/base/x", false, store)).toBe("");
  });

  it("门控开启 + 活动本机节点：渲染底部条，含节点名、版本槽与管理入口", () => {
    const store = makeStore();
    store.connectLocal();
    const html = renderDock("/base/x", true, store);
    expect(html).toContain("本机");
    expect(html).toContain("切换或管理节点");
    // 版本槽在 SSR 首拍（健康未回首）显占位，不崩。
    expect(html).toContain("核心");
    expect(html).toContain("壳");
    // 底部条固定容器存在；抽屉默认不挂载。
    expect(html).toContain("data-shell-dock");
    expect(html).not.toContain("data-shell-dock-drawer");
  });

  it("门控开启但无活动节点：null", () => {
    expect(renderDock("/base/x", true, makeStore())).toBe("");
  });

  it("停在 /launcher：即便有活动节点也隐藏", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderDock("/launcher", true, store)).toBe("");
  });

  it("公开分享页 /s/.. 隐藏（不向匿名页泄露节点信息）", () => {
    const store = makeStore();
    store.connectLocal();
    expect(renderDock("/s/tok123", true, store)).toBe("");
  });
});

// LauncherPanel SSR 组合测试（node + react-dom/server，无 jsdom/新依赖）。
// 锁：空注册表（新装）直落「添加网络节点」首屏且无取消；有节点时渲染列表 + 添加按钮。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LauncherPanel } from "./LauncherPanel";
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

describe("LauncherPanel", () => {
  it("全新安装空注册表：标题 + 直接显示添加网络节点表单，且无返回/取消", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    expect(html).toContain("构想工作台");
    expect(html).toContain("添加网络节点");
    expect(html).toContain("节点网址");
    // 空态不应出现列表空态文案或「取消」（已是首屏，无处可退）
    expect(html).not.toContain("还没有节点");
    expect(html).not.toContain(">取消<");
  });

  it("有本地与远端节点：渲染节点列表与添加按钮，本地在前", () => {
    const store = makeStore();
    store.connectLocal();
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001", label: "公司库" });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    expect(html).toContain("本机");
    expect(html).toContain("公司库");
    expect(html).toContain("http://nas:3001");
    expect(html).toContain("添加网络节点");
    // 列表视图下不再内联添加表单
    expect(html).not.toContain("节点网址");
  });

  it("列表视图为每个节点提供行内重命名入口", () => {
    const store = makeStore();
    store.connectLocal();
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001", label: "公司库" });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    // 本地 + 远端各一枚重命名按钮。
    expect(html.match(/aria-label="重命名"/g)?.length).toBe(2);
  });
});

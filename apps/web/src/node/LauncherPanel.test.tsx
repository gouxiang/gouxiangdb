// LauncherPanel SSR 组合测试（node + react-dom/server，无 jsdom/新依赖）。
// 锁：空注册表（新装）显横屏欢迎卡（本机主 CTA + 网络节点次入口），不再自动落添加表单；
// 有节点时渲染列表 + 添加按钮；add 视图才出现 AddRemoteNodeForm（带取消，可回欢迎/列表）。
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
  it("全新安装空注册表：标题 + 欢迎卡双入口，不自动展开添加表单", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    expect(html).toContain("构想工作台");
    expect(html).toContain("在这台电脑上开始");
    expect(html).toContain("数据保存在本机，离线也能用");
    expect(html).toContain("连接到网络上的另一台电脑");
    // 不再强制落添加表单（其特征文案「节点网址」不应出现）
    expect(html).not.toContain("节点网址");
    expect(html).not.toContain("还没有节点");
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
    // 活动本地行仍只显「断开」（活动行动区逻辑不动）
    expect(html).toContain(">断开<");
    // 列表视图下不内联添加表单
    expect(html).not.toContain("节点网址");
  });

  it("只连过远端、从未初始化本机：列表态仍在最前给本机入口（不因其为占位行而可改名）", () => {
    const store = makeStore();
    // 不调 connectLocal：注册表里只有一个远端条目（复现"先直连远端后回切换页"）。
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001", label: "公司库" });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    // 列表态（非空注册表 → 非欢迎双 CTA）。
    expect(html).not.toContain("在这台电脑上开始");
    expect(html).toContain("添加网络节点");
    // 占位本机行出现：标题本机 + 非壳回落的单个「使用本机」入口。
    expect(html).toContain("本机");
    expect(html).toContain("使用本机");
    // 占位行不渲染重命名（远端行仍有一枚）。
    expect(html.match(/aria-label="重命名"/g)?.length).toBe(1);
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

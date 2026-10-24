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

  it("full 变体不泄漏 JSX 裸注释文本，且双入口按钮都在渲染树中", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store, variant: "full" }),
    );
    // 0.2.6 真机缺陷：白卡上方一行 // 注释被当成真实文本节点渲染，
    // 还成为 flex 匿名子项挤偏白卡、遮挡双入口点击。修复后不得出现在产物 HTML。
    expect(html).not.toContain("全屏焦点白卡");
    expect(html).toContain("在这台电脑上开始");
    expect(html).toContain("连接到网络上的另一台电脑");
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

  // ── 切片 3b：第三入口（本机离线副本）可见可点接线 ─────────────────────────────
  it("空注册表欢迎页出现第三张卡「把这台电脑作为副本接入」（含副文案），但初始不展开任何表单", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    expect(html).toContain("把这台电脑作为副本接入");
    expect(html).toContain("本机留一份，离线也能看，联网自动同步");
    // 三张卡同屏：主库 CTA + 远端次卡 + 副本次卡。
    expect(html).toContain("在这台电脑上开始");
    expect(html).toContain("连接到网络上的另一台电脑");
    // 欢迎态不内联副本表单：令牌字段不应出现。
    expect(html).not.toContain("连接令牌");
    expect(html).not.toContain("粘贴服务器管理员给的连接令牌");
  });

  it("以 add-replica 初始视图打开：出现副本表单的令牌字段与提交钮，且不混入远端表单", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, {
        store,
        initialView: { mode: "add-replica" },
      }),
    );
    // 副本表单特征：分区标题、令牌标签/占位、新副本提交文案。
    expect(html).toContain("添加本机副本");
    expect(html).toContain("连接令牌");
    expect(html).toContain("粘贴服务器管理员给的连接令牌");
    expect(html).toContain("服务器网址");
    expect(html).toContain(">添加并进入<");
    // 远端添加表单（AddRemoteNodeForm）不应同屏出现。
    expect(html).not.toContain("节点网址");
  });

  it("非空列表底部并排出现「添加本机副本」与「添加网络节点」两个按钮", () => {
    const store = makeStore();
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001", label: "公司库" });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    expect(html).toContain("添加本机副本");
    expect(html).toContain("添加网络节点");
  });

  it("注册表里只有离线副本、没有本机主库：列表仍补占位主库行，副本行给「进入副本」重连入口", () => {
    const store = makeStore();
    // 仅登记一个离线副本（不 connectLocal、不加远端），复现"先加了副本、从未初始化本机主库"。
    store.addReplica({
      nodeId: "replica-1",
      label: "办公本-副本",
      remoteBaseUrl: "http://nas:3001",
    });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, { store }),
    );
    // 占位主库行恒在（hasLocalEntry 只认 primary → ensureLocalRow 仍补占位）。
    expect(html).toContain("使用本机");
    // 副本行标题 + 远端基址副标题 + 未连接态 + 重连主按钮。
    expect(html).toContain("办公本-副本");
    expect(html).toContain("http://nas:3001");
    expect(html).toContain("未连接");
    expect(html).toContain(">进入副本<");
    // 列表底部仍给新增副本入口。
    expect(html).toContain("添加本机副本");
  });

  it("副本行重连视图：服务器网址/名称只读预填，令牌留空每次重输，提交钮为「连接并进入」", () => {
    const store = makeStore();
    store.addReplica({
      nodeId: "replica-1",
      label: "办公本-副本",
      remoteBaseUrl: "http://nas:3001",
    });
    const html = renderToStaticMarkup(
      React.createElement(LauncherPanel, {
        store,
        initialView: { mode: "reconnect-replica", nodeId: "replica-1" },
      }),
    );
    // 重连分区标题 + 只读提交文案。
    expect(html).toContain("重新连接副本");
    expect(html).toContain(">连接并进入<");
    // 网址预填该副本的规范化裸 origin。
    expect(html).toContain('value="http://nas:3001"');
    // 名称预填。
    expect(html).toContain('value="办公本-副本"');
    // 网址与名称两个只读字段（aria-readonly 由 Input 只读态落属性），令牌字段不预填、不锁定。
    expect(html.match(/aria-readonly="true"/g)?.length).toBe(2);
    // 令牌占位仍在（每次重输），且密码框无任何非空 value（零持久化/零回填）。
    const pwdInput = html.match(/<input[^>]*type="password"[^>]*>/u)?.[0] ?? "";
    expect(pwdInput).toContain('placeholder="粘贴服务器管理员给的连接令牌"');
    expect(pwdInput).not.toMatch(/value="[^"]+"/);
    // 不混入远端添加表单。
    expect(html).not.toContain("节点网址");
  });
});

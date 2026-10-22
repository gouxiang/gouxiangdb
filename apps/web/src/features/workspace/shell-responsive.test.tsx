// 壳层响应式接线回归（node 环境，源码断言 + SSR，无 jsdom、无新增依赖）。
//
// 锁的是 P1-C（D-5/D-6/D-7）三条断点偏差的 v6 接线：
//   R-D-30  v6 S2 起废止：L2 按底板恒定 236（不再 1280–1439 压 208、其余 240）
//   R-D-31  1024–1279：L2 以「浮出面板」覆盖内容区左侧（绝对定位 + 阴影 + token 层级），可折叠
//   R-D-32  768–1023：L1 恒 76 图标轨（不给展开开关）、L2 浮出、表格转卡片（GridView 侧另有断言）
//   R-D-33  <768：L1/L2 全部进抽屉；顶栏搜索折叠为图标（WorkspaceTopBar 侧另有断言）
//
// 断言口径：档位判定本身在 lib/breakpoint.test.ts 已逐档钉死，这里只锁「壳层确实按档位分支」。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { L2_WIDTH } from "./lib/l1-collapse";
import { isDrawerTier, isFloatingL2Tier } from "../../lib/breakpoint";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("R-D-30/31/32/33 壳层断点接线", () => {
  const shell = read("./WorkspaceShell.tsx");

  it("v6 S2：L2 恒 236、不分档（208 紧凑档废止，壳层不再引用 L2_WIDTH_COMPACT）", () => {
    expect(L2_WIDTH).toBe(236);
    expect(shell).toContain("const l2Width = L2_WIDTH;");
    expect(shell).not.toContain("L2_WIDTH_COMPACT");
  });

  it("R-D-31/32：浮出档（768–1279）L2 是覆盖右列内容体左侧的浮层，不是常驻列", () => {
    expect(shell).toContain('data-l2="floating"');
    // 浮层必须用分层 token（规范禁止裸 z-[数字]）
    expect(shell).toContain("gx-z-drawer");
    expect(shell).toContain("isFloatingL2Tier");
    // 浮层从「内容区首行工具带」下沿起算：不盖住 新建记录/筛选/搜索 这一行
    expect(shell).toContain("L2_FLOATING_TOP_PX");
    // v6 S3 横向栅格：浮层渲染在右列内容体内（rail 已在外层左列），故相对 left 为 0；
    // 视口绝对几何不变（面板仍在 x=76）。旧实现相对「顶栏下方全行」定位写 left:l1Width。
    expect(shell).toContain("left: 0");
    expect(shell).not.toContain("left: l1Width");
  });

  it("v6 #1003：static 档（≥1280）L2 面板常驻挂载（含收起态，靠宽度动画收展，不再条件卸载）", () => {
    // 壳层：非抽屉/非浮出档只要有容器就挂 SecondaryNav（不再 && showL2 卸载）
    expect(shell).toContain("!drawer && !floatingL2 && activeContainer && secondary");
    expect(shell).toContain("<WorkspaceTopBar");
    // 宽度动画与单颗骑缝钮的结构落在 SecondaryNav（gx-l2-wrap 三层 + static 档分支）
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain('"static-wrap"');
    expect(nav).toContain("gx-l2-wrap");
    expect(nav).toContain("cubic-bezier(.4,0,.2,1)");
  });

  it("R-D-32（v6 S1）：768–1023 档 L1 不再折叠——恒 76 图标轨、无 CollapseToggle", () => {
    // v6：L1 折叠档永久废止，md 档只影响 L2（浮出），L1 恒定 76。
    expect(shell).not.toContain("CollapseToggle");
    expect(shell).not.toContain('tier === "md"');
    expect(shell).toContain("L1_WIDTH");
  });

  it("R-D-33：<768 走抽屉，且抽屉里 L1 与 L2 都在（L2 叠在 L1 之上，不并排超宽）", () => {
    expect(shell).toContain('aria-label="关闭导航"');
    expect(shell).toContain("isDrawerTier");
    // 抽屉内 L2 是绝对定位叠层：76+236 并排会超出 390 屏宽
    expect(shell).toContain('gx-z-drawer shadow-gx-lg');
  });

  it("浮出档默认收起 + L1 底部固定区留「展开面板」唤回入口（功能不失联）", () => {
    // 档位默认只在「用户从未操作」时生效，不得再有「档位值直接当状态初值」的写法
    // （那样窄屏被动收起一次会被落盘成用户意图，回宽屏再也展开不回来）。
    expect(shell).not.toContain("useState(() => isFloatingL2Tier(tier))");
    expect(shell).toContain("resolveL2Collapsed(l2Intent, isFloatingL2Tier(tier))");
    expect(shell).toContain("secondaryToggle");
    expect(shell).toContain("展开面板");
  });

  it("L2 收起态持久化：意图写 localStorage；static 档面板常驻、收起靠宽度动画（不再挂独立唤回竖条）", () => {
    expect(shell).toContain("readL2Collapsed()");
    expect(shell).toContain("writeL2Collapsed(");
    expect(shell).toContain("resolveL2Collapsed(l2Intent, isFloatingL2Tier(tier))");
    // v6 #1003：独立唤回组件 SecondaryNavRail 已删除（单颗骑缝钮并入 SecondaryNav）
    expect(shell).not.toContain("SecondaryNavRail");
    // static 档把 collapsed 透传给面板（floating/drawer 档恒 false，那两档仍条件挂载）
    expect(shell).toContain("collapsed={!floatingL2 && !drawer && !showL2}");
    expect(shell).toContain("onExpand={expandL2}");
    // 唤回钮只在 static 档由 SecondaryNav 内部渲染为单颗兄弟钮（恒 right:-13，无 left:-13 窄条）
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain('variant === "static" ? "static-wrap" : "floating-inner"');
    expect(nav).toContain("gx-l2-toggle gx-z-drawer");
    expect(nav).not.toContain("gx-l2-expand-tab");
    expect(nav).not.toContain("gx-l2-collapse-tab");
  });

  it("SecondaryNav 支持浮出变体：浮层带阴影，宽度由壳层按档传入", () => {
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain('variant?: "static" | "floating"');
    expect(nav).toContain('variant === "floating" && "shadow-gx-lg"');
    // 默认恒为 236：桌面 SSR 断言与真机各档一致（v6 S2 起不分档）
    expect(nav).toContain("width = L2_WIDTH");
  });

  it("档位语义自查：抽屉档只在 <768，浮出档只在 768–1279", () => {
    expect(isDrawerTier("sm")).toBe(true);
    expect(isDrawerTier("md")).toBe(false);
    expect(isFloatingL2Tier("md")).toBe(true);
    expect(isFloatingL2Tier("lg")).toBe(true);
    expect(isFloatingL2Tier("xl")).toBe(false);
    expect(isFloatingL2Tier("2xl")).toBe(false);
  });
});

describe("l2Peeked 接线：点当前一级容器临时唤出 L2", () => {
  const shell = read("./WorkspaceShell.tsx");
  const primary = read("./PrimaryNav.tsx");

  it("壳层把 peek 置为会话态（setL2Peeked(true)、不写盘），并在浮出/抽屉档且 L2 收起时注入", () => {
    // 真正的接线点：peekL2 调 setL2Peeked(true)
    expect(shell).toContain("const peekL2 = useCallback(() => setL2Peeked(true), []);");
    // 仅浮出/抽屉档 + L2 收起 + 有容器才给口
    expect(shell).toContain("(floatingL2 || drawer) && !showL2 && activeContainer ? peekL2 : undefined");
    // 两份 SideRail（抽屉内 / 常规）都透传
    expect(shell).toContain("onPeekCurrent={peekCurrent}");
  });

  it("PrimaryNav 点当前已激活行调 onPeekCurrent 唤出而不重复导航；点别的库仍跳转", () => {
    expect(primary).toContain("onPeekCurrent?: () => void;");
    // 点击分支：active 且有 peek 口 → peek 并 return，否则 onNavigate(href)
    expect(primary).toContain("if (active && onPeekCurrent) {");
    expect(primary).toContain("onPeekCurrent();");
    expect(primary).toContain("onNavigate(href);");
  });

  it("换路由复位 peek（复用既有 effect，会话态不跨路由残留）", () => {
    expect(shell).toContain("setL2Peeked(false);");
    expect(shell).toContain("}, [location.pathname]);");
  });
});

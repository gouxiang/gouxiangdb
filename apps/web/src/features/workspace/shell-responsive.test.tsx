// 壳层响应式接线回归（node 环境，源码断言 + SSR，无 jsdom、无新增依赖）。
//
// 锁的是 P1-C（D-5/D-6/D-7）三条断点偏差已按 R-D-30/31/32/33 接线：
//   R-D-30  1280–1439：L2 用 L2_WIDTH_COMPACT(208)，不再恒为 240
//   R-D-31  1024–1279：L2 以「浮出面板」覆盖内容区左侧（绝对定位 + 阴影 + token 层级），可折叠
//   R-D-32  768–1023：L1 锁 56 图标档（不给展开开关）、L2 浮出、表格转卡片（GridView 侧另有断言）
//   R-D-33  <768：L1/L2 全部进抽屉；顶栏搜索折叠为图标（WorkspaceTopBar 侧另有断言）
//
// 断言口径：档位判定本身在 lib/breakpoint.test.ts 已逐档钉死，这里只锁「壳层确实按档位分支」。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { L2_WIDTH, L2_WIDTH_COMPACT } from "./lib/l1-collapse";
import { L2_WIDTH_COLLAPSED } from "./lib/l2-collapse";
import { isDrawerTier, isFloatingL2Tier } from "../../lib/breakpoint";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("R-D-30/31/32/33 壳层断点接线", () => {
  const shell = read("./WorkspaceShell.tsx");

  it("R-D-30：1280–1439 档 L2 压到 208（常驻档仍 240）", () => {
    expect(L2_WIDTH_COMPACT).toBe(208);
    expect(L2_WIDTH).toBe(240);
    expect(shell).toContain("tier === \"xl\" ? L2_WIDTH_COMPACT : L2_WIDTH");
  });

  it("R-D-31/32：浮出档（768–1279）L2 是覆盖内容区左侧的浮层，不是常驻列", () => {
    expect(shell).toContain('data-l2="floating"');
    // 浮层必须用分层 token（规范禁止裸 z-[数字]）
    expect(shell).toContain("gx-z-drawer");
    expect(shell).toContain("isFloatingL2Tier");
    // 浮层从「内容区首行工具带」下沿起算：不盖住 新建记录/筛选/搜索 这一行
    expect(shell).toContain("L2_FLOATING_TOP_PX");
  });

  it("R-D-32：768–1023 档 L1 锁定 56 图标档，且不给会被覆盖的展开开关", () => {
    expect(shell).toContain('tier === "md" || collapsed');
    expect(shell).toContain('showCollapseToggle={tier !== "md"}');
  });

  it("R-D-33：<768 走抽屉，且抽屉里 L1 与 L2 都在（L2 叠在 L1 之上，不并排超宽）", () => {
    expect(shell).toContain('aria-label="关闭导航"');
    expect(shell).toContain("isDrawerTier");
    // 抽屉内 L2 是绝对定位叠层：224+240 并排会超出 390 屏宽
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

  it("L2 收起态持久化：意图写 localStorage，收起后常驻档以零宽悬浮圆钮唤回（不占位）", () => {
    expect(shell).toContain("readL2Collapsed()");
    expect(shell).toContain("writeL2Collapsed(");
    expect(L2_WIDTH_COLLAPSED).toBe(56);
    // 唤回钮只在非浮出档渲染：浮出档插常驻竖栏会反向挤压内容宽度（R-D-31/32）
    expect(shell).toContain("<SecondaryNavRail");
    expect(shell).toContain("!floatingL2 && (");
    // Rail 已改为零宽 absolute 悬浮钮（不再竖排占栏），位置骑在 L1 右缘
    const rail = read("./SecondaryNavRail.tsx");
    expect(rail).toContain('data-l2="collapsed-tab"');
    expect(rail).toContain("absolute");
    expect(rail).toContain("l1Width");
    expect(rail).not.toContain("writingMode");
  });

  it("SecondaryNav 支持浮出变体：浮层带阴影，宽度由壳层按档传入", () => {
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain('variant?: "static" | "floating"');
    expect(nav).toContain('variant === "floating" && "shadow-gx-lg"');
    expect(nav).toContain("style={{ width }}");
    // 默认仍是 240：桌面 SSR 断言与真机 ≥1440 一致
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

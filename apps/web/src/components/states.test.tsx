// 阶段 3 状态体系回归（node 环境，react-dom/server，无 jsdom、无新增依赖）。
//
//   R-D-12 无权限态：就地卡片，不跳登录、不弹 toast
//   R-D-13 首次空态四要素；R-D-14 筛选空态
//   R-D-16 错误态带「重试」
//   R-D-17 401 引导重新登录
//   R-D-18 409 冲突给「查看最新版本 / 保留我的版本」二选一
//   R-D-19 离线横幅在线时不渲染
//   R-D-25/26 骨架屏同构 + 3–8 行
//   R-D-28 进度浮层可关闭 + 显示「已完成 23/120」

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  ConflictNotice,
  ErrorState,
  NoPermissionState,
  OfflineBanner,
  ProgressOverlay,
  SessionExpiredNotice,
  SkeletonCards,
  SkeletonList,
  SkeletonTable,
  clampSkeletonRows,
} from "./states";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("阶段3 · 骨架屏（R-D-25/26）", () => {
  it("R-D-26 行数恒在 3–8 之间，不铺满整屏", () => {
    expect(clampSkeletonRows(1)).toBe(3);
    expect(clampSkeletonRows(2)).toBe(3);
    expect(clampSkeletonRows(6)).toBe(6);
    expect(clampSkeletonRows(50)).toBe(8);
  });

  it("R-D-25 与目标同构：表头 36 + 数据行 44，底色 row-hover(#F1F5FB)", () => {
    const html = renderToStaticMarkup(<SkeletonTable rows={6} cols={5} />);
    expect(html).toContain('data-gx-skeleton="table"');
    expect(html).toContain("h-9"); // 表头 36px
    expect(html).toContain("h-11"); // 数据行 44px
    expect(html).toContain("bg-gx-row-hover");
    expect(html).toContain("gx-skeleton");
    // 默认 6 行
    expect(html.match(/h-11/g)?.length).toBe(6);
  });

  it("列表 / 卡片骨架同样走 row-hover 底 + gx-skeleton 微光", () => {
    const list = renderToStaticMarkup(<SkeletonList rows={4} />);
    expect(list).toContain('data-gx-skeleton="list"');
    expect(list).toContain("gx-skeleton");
    const cards = renderToStaticMarkup(<SkeletonCards count={4} />);
    expect(cards).toContain('data-gx-skeleton="cards"');
  });

  it("微光动画 1.2s 写在全局 CSS，且尊重 prefers-reduced-motion", () => {
    expect(css).toMatch(/\.gx-skeleton::after/);
    expect(css).toMatch(/animation:\s*gx-skeleton-sheen 1\.2s/);
    expect(css).toMatch(/@keyframes gx-skeleton-sheen/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.gx-skeleton::after\s*\{\s*animation:\s*none/);
  });
});

describe("阶段3 · 错误态（R-D-16）", () => {
  it("图标 + 标题 + 原因 + 重试主按钮 + 返回次按钮；可重试的必须带重试", () => {
    const html = renderToStaticMarkup(
      <ErrorState reason="网络超时，请稍后重试" onRetry={() => undefined} onBack={() => undefined} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("加载失败");
    expect(html).toContain("网络超时，请稍后重试");
    expect(html).toContain("重试");
    expect(html).toContain("返回");
  });

  it("不使用全屏错误页：渲染的是就地卡片，不占满视口", () => {
    const html = renderToStaticMarkup(<ErrorState onRetry={() => undefined} />);
    expect(html).not.toContain("fixed inset-0");
    expect(html).not.toContain("min-h-screen");
  });
});

describe("阶段3 · 401 / 409 / 离线（R-D-17/18/19）", () => {
  it("R-D-17 会话过期：顶部横幅 + 引导「重新登录」", () => {
    const html = renderToStaticMarkup(<SessionExpiredNotice onRelogin={() => undefined} />);
    expect(html).toContain('data-gx-session-expired="true"');
    expect(html).toContain("重新登录");
    expect(html).toContain('role="alert"');
  });

  it("R-D-18 冲突：就地提示 + 「查看最新版本 / 保留我的版本」二选一（禁止静默覆盖）", () => {
    const html = renderToStaticMarkup(
      <ConflictNotice onViewLatest={() => undefined} onKeepMine={() => undefined} />,
    );
    expect(html).toContain('data-gx-conflict="true"');
    expect(html).toContain("内容已被他人更新");
    expect(html).toContain("查看最新版本");
    expect(html).toContain("保留我的版本");
  });

  it("R-D-19 离线横幅：在线（SSR 默认）不渲染任何节点", () => {
    expect(renderToStaticMarkup(<OfflineBanner />)).toBe("");
  });

  it("R-D-17 来路记录在 lib/session-from.ts：SSR 安全、非 '/' 开头丢弃", async () => {
    const mod = await import("../lib/session-from");
    // node 环境无 window → 一律 null，不抛错（登录页 SSR 单测依赖这一点）
    expect(mod.takeSessionFrom()).toBeNull();
    // save 在无 window 时也不抛错（client.ts 401 分支可无条件调用）
    expect(() => mod.saveSessionFrom("/base/b1/table/t1")).not.toThrow();
  });
});

describe("阶段3 · 无权限态（R-D-12）", () => {
  it("就地卡片：图标 + 「无访问权限」+ 说明 + 返回 / 申请权限；不跳登录、不弹 toast", () => {
    const html = renderToStaticMarkup(
      <NoPermissionState onBack={() => undefined} onRequest={() => undefined} />,
    );
    expect(html).toContain('data-gx-no-permission="true"');
    expect(html).toContain("无访问权限");
    expect(html).toContain("申请权限");
    expect(html).toContain("返回");
  });
});

describe("阶段3 · 进度浮层（R-D-28）", () => {
  it("关闭态不渲染；打开态显示「已完成 23/120」且可关闭", () => {
    expect(renderToStaticMarkup(<ProgressOverlay open={false} title="导入" done={1} total={2} />)).toBe("");
    // 打开态走 createPortal，SSR 不支持断言 DOM，故只锁文案生成规则与可关闭属性
    const src = readFileSync(new URL("./states.tsx", import.meta.url), "utf8");
    expect(src).toContain("已完成 {done}/{safeTotal}");
    expect(src).toContain("收起进度（任务继续在后台执行）");
  });
});

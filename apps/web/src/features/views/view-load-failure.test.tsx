// PERM-04：直输库视图 URL 必须落到终态，不是无限转圈。
//
// node 环境，react-dom/server 渲染 + 源码断言，无 jsdom、无新增依赖。
//
// 现象（WALK-权限组合-2026-09-20 · PERM-04）：局外人登录后手输
// `/base/:id/table/:id/view/:id`，主内容区永久转圈，7 秒后既无「无权限」提示也不跳转。
// 后端 `GET /api/views`（apps/api/src/routes/views.ts:72 requireCanView）与
// `GET /api/bases/:id` 都正确返回 403 —— 是前端把「拉不到数据」当成了「还没加载完」。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ApiError } from "../../api/client";
import { ViewLoadFailure } from "./ViewLoadFailure";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const noop = () => undefined;
const forbidden = () => new ApiError(403, { error: "无权访问该 Base" });

describe("PERM-04：403 / 401 → 无权限态，不再是转圈", () => {
  it("403 渲染 data-gx-no-permission 无权限卡片，且没有 spinner", () => {
    const html = render(<ViewLoadFailure error={forbidden()} onRetry={noop} onBack={noop} />);
    expect(html).toContain('data-gx-no-permission="true"');
    expect(html).toContain("无访问权限");
    expect(html).toContain("返回");
    // 关键：任何失败态都不许再挂着 loader（这正是 PERM-04 的现象）
    expect(html).not.toContain("animate-spin");
  });

  it("401 同样按无权限处理（失效/被回收的会话不能退化成「继续等」）", () => {
    const html = render(
      <ViewLoadFailure error={new ApiError(401, { error: "未登录" })} onBack={noop} />,
    );
    expect(html).toContain('data-gx-no-permission="true"');
  });

  it("无权限态不挂「申请权限」按钮（后端没有这条链路，挂了就是假入口）", () => {
    const html = render(<ViewLoadFailure error={forbidden()} onBack={noop} />);
    expect(html).not.toContain("申请权限");
  });
});

describe("PERM-04：非 403/401 的错误 → 可重试错误态，仍不是转圈", () => {
  it("500 走 role=alert 错误态带「重试」，不含无权限卡片", () => {
    const html = render(
      <ViewLoadFailure error={new ApiError(500, { error: "服务器错误" })} onRetry={noop} onBack={noop} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("加载失败");
    expect(html).toContain("重试");
    expect(html).not.toContain('data-gx-no-permission="true"');
  });

  it("并把后端给的原因显示出来（不再只让用户干等）", () => {
    const html = render(<ViewLoadFailure error={forbidden()} onBack={noop} />);
    expect(html).toContain("无权访问该 Base");
  });
});

describe("PERM-04 同一根因的第二例：视图列表已到、viewId 不在其中", () => {
  it("给「视图不存在」终态，不给重试（重试同一个 viewId 仍是同一个结果）", () => {
    const html = render(<ViewLoadFailure viewMissing onRetry={noop} onBack={noop} />);
    expect(html).toContain("视图不存在");
    expect(html).toContain("链接已经失效");
    expect(html).toContain("返回");
    expect(html).not.toContain("重试");
    expect(html).not.toContain("animate-spin");
  });
});

describe("PERM-04：ViewRouter 不再只有「加载 / 转圈」两个分支", () => {
  it("根因已除：不再出现 viewsLoading || !view 的合并分支", () => {
    const src = read("./ViewRouter.tsx");
    // 这一行是无限转圈的直接成因：viewsLoading 变 false 之后（请求已失败），
    // !view 仍为 true，于是永远走 <Spinner />。
    expect(src).not.toContain("viewsLoading || !view");
  });

  it("失败分支接线到 ViewLoadFailure，且只在真正 loading 时给 Spinner", () => {
    const src = read("./ViewRouter.tsx");
    expect(src).toContain("if (viewsLoading) {");
    expect(src).toContain("<ViewLoadFailure");
    expect(src).toContain("viewMissing={!viewsError && !view}");
    expect(src).toContain("refetch: refetchViews");
  });

  it("ViewLoadFailure ≤300 行、无 hooks（保持可在 node 环境直测）", () => {
    const src = read("./ViewLoadFailure.tsx");
    expect(src.split("\n").length).toBeLessThanOrEqual(300);
    expect(src).not.toContain("useState");
    expect(src).not.toContain("useQuery");
  });
});

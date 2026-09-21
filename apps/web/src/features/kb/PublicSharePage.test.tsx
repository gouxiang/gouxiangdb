// apps/web/src/features/kb/PublicSharePage.test.tsx
// 公开分享页 canEdit 渲染判定：可编辑 → 「可编辑」+ 保存入口 + 编辑器可写；
// 只读 → 「仅可见」+ 无任何保存入口 + 编辑器只读（fail-closed：缺字段/出错一律只读）。
//
// 手段：node 环境（apps/web 无 jsdom），vi.mock 掉编辑器/画布/大纲等重组件，
// 用 react-dom/server 渲染**真实 PublicDocView / PublicSharePage**。判定发生在 render 分支里，
// renderToStaticMarkup 足以证明它。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 注入给被 mock 的 usePublicShare 的返回值；每条用例渲染前重置。 */
let shareSeed: Record<string, unknown> = {};

vi.mock("./kb-hooks", async (imp) => {
  const actual = await imp<Record<string, unknown>>();
  return { ...actual, usePublicShare: () => shareSeed };
});

// 用轻量桩替换编辑器，把 readOnly / 保存入口暴露成可断言的属性
vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: (p: { readOnly?: boolean; onSave?: unknown; initialMarkdown?: string }) =>
      React.createElement(
        "div",
        {
          "data-md-readonly": String(!!p.readOnly),
          "data-md-has-save": String(typeof p.onSave === "function"),
        },
        p.initialMarkdown ?? "",
      ),
  };
});
vi.mock("./canvas/GxCanvas", async () => {
  const React = await import("react");
  return {
    GxCanvas: (p: { canEdit?: boolean }) =>
      React.createElement("div", { "data-canvas-canedit": String(!!p.canEdit) }),
  };
});
vi.mock("./DocOutline", () => ({ DocOutline: () => null }));

import PublicSharePage from "./PublicSharePage";
import { PublicDocView } from "./PublicDocView";

const base = {
  id: "d1",
  content: "正文内容",
  title: "示例文档",
  kind: "doc",
  canEdit: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderView(doc: Record<string, unknown>) {
  return render(
    <StaticRouter location="/s/tok">
      <PublicDocView doc={doc as never} token="tok" embedCanEdit={false} />
    </StaticRouter>,
  );
}

function renderPage() {
  return render(
    <StaticRouter location="/s/tok">
      <Routes>
        <Route path="/s/:token" element={<PublicSharePage />} />
      </Routes>
    </StaticRouter>,
  );
}

describe("PublicDocView：canEdit 决定正文可否编辑", () => {
  it("canEdit=true → 徽标「可编辑」+ 保存按钮 + 编辑器可写（readOnly=false）", () => {
    const html = renderView({ ...base, canEdit: true });
    expect(html).toContain("可编辑");
    expect(html).not.toContain("仅可见");
    expect(html).toContain("保存");
    expect(html).toContain('data-md-readonly="false"');
    expect(html).toContain('data-md-has-save="true"');
  });

  it("canEdit=false → 徽标「仅可见」+ 没有任何保存入口 + 编辑器只读", () => {
    const html = renderView({ ...base, canEdit: false });
    expect(html).toContain("仅可见");
    expect(html).not.toContain("可编辑");
    expect(html).not.toContain("保存");
    expect(html).toContain('data-md-readonly="true"');
  });

  it("canEdit 字段缺失 → fail-closed 按只读（无保存入口）", () => {
    const { canEdit: _omit, ...missing } = base;
    const html = renderView({ ...missing });
    expect(html).toContain("仅可见");
    expect(html).not.toContain("保存");
    expect(html).toContain('data-md-readonly="true"');
  });

  it("画布文档同理：canEdit=true 时把真实值传给画布", () => {
    const html = renderView({ ...base, kind: "canvas", canEdit: true });
    expect(html).toContain('data-canvas-canedit="true"');
    const ro = renderView({ ...base, kind: "canvas", canEdit: false });
    expect(ro).toContain('data-canvas-canedit="false"');
  });
});

describe("PublicSharePage：分享级失败 fail-closed（不渲染任何编辑入口）", () => {
  it("分享链接失效/出错 → 渲染失效页，无编辑器、无保存", () => {
    shareSeed = { data: undefined, isLoading: false, error: new Error("分享链接已失效") };
    const html = renderPage();
    expect(html).toContain("分享链接已失效或被取消");
    expect(html).not.toContain("保存");
    expect(html).not.toContain("可编辑");
  });

  it("加载中 → 只渲染 spinner，不渲染编辑器/保存", () => {
    shareSeed = { data: undefined, isLoading: true, error: null };
    const html = renderPage();
    expect(html).not.toContain("可编辑");
    expect(html).not.toContain("保存");
  });
});

describe("源码守卫：canEdit 不写死、readOnly 以 !canEdit 驱动", () => {
  it("canEdit 来自读取接口真实值，且不再有硬编码只读", () => {
    const share = read("./PublicSharePage.tsx");
    expect(share).toContain("canEdit: data.canEdit === true");
    expect(share).toContain("canEdit: r.canEdit === true");
    const view = read("./PublicDocView.tsx");
    // 旧实现：编辑器硬编码 readOnly、画布硬编码 canEdit={false}
    expect(view).toContain("readOnly={!canEdit}");
    expect(view).toContain("canEdit={canEdit}");
    expect(view + share).not.toContain("canEdit={false}");
    // 保存入口受 canEdit 门控
    expect(view).toContain("{canEdit && (");
  });
});

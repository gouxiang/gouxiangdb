// apps/web/src/features/kb/PublicSharePage.test.tsx
// 公开分享两类保障：
//   A) canEdit 渲染判定（PublicDocView，文档分支继续复用）：可编辑 → 「可编辑」+ 保存入口
//      + 编辑器可写；只读 → 「仅可见」+ 无保存入口 + 编辑器只读（fail-closed）。
//   B) PublicSharePage 三类分发（doc/table/base）：按 kind 渲染对应分支；库作用域 t 路由
//      直接渲染单表只读网格。
//
// 手段：node 环境（apps/web 无 jsdom），vi.mock 掉编辑器/画布/大纲/数据表网格/库外壳等重组件，
// 用 react-dom/server 渲染**真实 PublicDocView / PublicSharePage**。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 注入给被 mock 的 usePublicShareAny 的返回值；每条用例渲染前重置。 */
let shareSeed: Record<string, unknown> = {};

vi.mock("./kb-hooks", async (imp) => {
  const actual = await imp<Record<string, unknown>>();
  return { ...actual, usePublicShareAny: () => shareSeed, usePublicShare: () => shareSeed };
});

// 数据表只读网格 / 库外壳：用轻量桩暴露分发结果（避免在 SSR 里跑取数）。
vi.mock("./PublicSharedTable", async () => {
  const React = await import("react");
  return {
    PublicSharedTable: (p: { access: { kind: string; tableToken?: string; baseToken?: string; tableId?: string } }) =>
      React.createElement(
        "div",
        {
          "data-public-grid": "1",
          "data-grid-access": p.access.kind,
          "data-grid-token": p.access.tableToken ?? p.access.baseToken ?? "",
          "data-grid-table": p.access.tableId ?? "",
        },
        "PUBLIC_GRID",
      ),
  };
});
vi.mock("./PublicBaseShell", async () => {
  const React = await import("react");
  return {
    PublicBaseShell: (p: { share?: { base?: { name?: string } } }) =>
      React.createElement("div", { "data-base-shell": "1" }, `BASE_SHELL:${p.share?.base?.name ?? ""}`),
  };
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
// 品牌产品名 hook 走 react-query；本 SSR 回归不挂 QueryClientProvider，给默认名桩。
vi.mock("../branding/useBranding", () => ({ useProductName: () => "构想工作台" }));

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

/** 文档族分享根种子（后端 docShareResponse 形状，kind 字面量为 "doc"）。 */
const docShare = {
  kind: "doc",
  rootToken: "tok",
  shareRole: "viewer",
  canEdit: false,
  requestedMode: "view",
  mode: "view",
  degraded: false,
  includeChildren: false,
  doc: { ...base, canEdit: false },
  tree: [],
};

function renderView(doc: Record<string, unknown>) {
  return render(
    <StaticRouter location="/s/tok">
      <PublicDocView doc={doc as never} token="tok" embedCanEdit={false} />
    </StaticRouter>,
  );
}

function renderPage(location = "/s/tok") {
  return render(
    <StaticRouter location={location}>
      <Routes>
        <Route path="/s/:token" element={<PublicSharePage />} />
        <Route path="/s/:token/t/:tableId" element={<PublicSharePage />} />
        <Route path="/s/:token/doc/:docId" element={<PublicSharePage />} />
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

  it("加载中 → 不渲染编辑器/保存", () => {
    shareSeed = { data: undefined, isLoading: true, error: null };
    const html = renderPage();
    expect(html).not.toContain("可编辑");
    expect(html).not.toContain("保存");
  });
});

describe("PublicSharePage：doc / table / base 三类按 kind 分发", () => {
  it("kind=doc（文档族）→ 渲染文档分支：只读徽标「仅可见」，无保存入口", () => {
    shareSeed = { data: docShare, isLoading: false, error: null };
    const html = renderPage();
    expect(html).toContain("仅可见");
    expect(html).not.toContain("data-public-grid");
    expect(html).not.toContain("data-base-shell");
  });

  it("缺省 kind 但带 doc 体（历史响应）→ 仍按文档族渲染", () => {
    const { kind: _omit, ...legacy } = docShare;
    shareSeed = { data: legacy, isLoading: false, error: null };
    const html = renderPage();
    expect(html).toContain("仅可见");
  });

  it("kind=table（直连表 token）→ 渲染只读网格，access=token 且带表 token", () => {
    shareSeed = {
      data: { kind: "table", token: "tok", canEdit: false, mode: "view" },
      isLoading: false,
      error: null,
    };
    const html = renderPage();
    expect(html).toContain('data-public-grid="1"');
    expect(html).toContain('data-grid-access="token"');
    expect(html).toContain('data-grid-token="tok"');
    expect(html).not.toContain("data-base-shell");
  });

  it("kind=base（库分享外壳）→ 渲染库外壳落地页", () => {
    shareSeed = {
      data: { kind: "base", token: "tok", canEdit: false, mode: "view", base: { id: "b1", name: "客户库" }, tables: [] },
      isLoading: false,
      error: null,
    };
    const html = renderPage();
    expect(html).toContain('data-base-shell="1"');
    expect(html).toContain("BASE_SHELL:客户库");
    expect(html).not.toContain("data-public-grid");
  });

  it("/s/:token/t/:tableId（库作用域单表）→ 直接渲染只读网格，access=base 且带 baseToken+tableId", () => {
    // 该路由不读分享根（不会调用 usePublicShareAny 的数据），但 hook 仍被调用：给 loading 桩
    shareSeed = { data: undefined, isLoading: true, error: null };
    const html = renderPage("/s/baseTok/t/tbl9");
    expect(html).toContain('data-public-grid="1"');
    expect(html).toContain('data-grid-access="base"');
    expect(html).toContain('data-grid-token="baseTok"');
    expect(html).toContain('data-grid-table="tbl9"');
  });
});

describe("源码守卫：canEdit 不写死、readOnly 以 !canEdit 驱动", () => {
  it("canEdit 来自读取接口真实值，且不再有硬编码只读", () => {
    // canEdit 归一逻辑在文档分支 PublicDocShare.tsx（三类分发后从 PublicSharePage 抽出）
    const share = read("./PublicDocShare.tsx");
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


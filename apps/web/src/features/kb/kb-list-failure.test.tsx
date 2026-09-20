// PERM-05：局外人手输 `/kb/:kbId` 必须渲染「无访问权限」，不能渲染「还没有内容」假空态。
//
// 走查（WALK-权限组合-2026-09-20 · PERM-05）原话：同一 KB 里明明有两篇文档，手输 `/kb/:kbId`
// 却看到「还没有内容 / 新建一篇 Markdown 文档…」；而手输**文档** URL 才是正确的「没有访问权限」。
// 后端 `GET /api/kb/:kbId/docs`（apps/api/src/routes/kb/docs.ts:34 requireKb →
// HttpError 403「无权访问该知识库」）完全正确，是前端把「请求失败」判成了「结果为空」。
//
// 手段：node 环境，`vi.mock` 注入 useKbDocs 的状态 + react-dom/server 渲染**真实 KbHomePage**。
// apps/web 没有 jsdom（禁止为测试新增依赖），所以不能真点；但这里的判定发生在 render 分支里，
// renderToStaticMarkup 足以证明它。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";
import { ApiError } from "../../api/client";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 注入给被 mock 的 useKbDocs 的返回值；每条用例渲染前重置。 */
let seed: Record<string, unknown> = {};

vi.mock("./kb-hooks", async (imp) => {
  const actual = await imp<Record<string, unknown>>();
  return { ...actual, useKbDocs: () => ({ data: undefined, isLoading: false, ...seed }) };
});

import KbHomePage from "./KbHomePage";
import { KbListFailure } from "./KbListFailure";

function renderKbHome(seedState: Record<string, unknown>) {
  seed = seedState;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <StaticRouter location="/kb/kb1">
        <Routes>
          <Route path="/kb/:kbId" element={<KbHomePage />} />
        </Routes>
      </StaticRouter>
    </QueryClientProvider>,
  );
}

const forbidden = new ApiError(403, { error: "无权访问该知识库" });
const errored = { isError: true, error: forbidden, refetch: () => undefined };

describe("PERM-05：403 → 无权限态，不再是「还没有内容」假空态", () => {
  it("手输 KB URL（docs 查询 403）：渲染无权限卡片，且不出现首次空态文案", () => {
    const html = renderKbHome(errored);
    expect(html).toContain('data-gx-no-permission="true"');
    expect(html).toContain("无访问权限");
    expect(html).toContain("返回");
    // 假空态的两个特征句都不许再出现
    expect(html).not.toContain("还没有内容");
    expect(html).not.toContain("新建一篇 Markdown 文档");
  });

  it("显示后端给的真实原因，不自造权限结论", () => {
    expect(renderKbHome(errored)).toContain("无权访问该知识库");
    expect(render(<KbListFailure error={forbidden} onBack={() => undefined} />)).not.toContain("申请权限");
  });

  it("真正的空结果（无错误）仍然走首次空态 —— 不能被修过头", () => {
    const html = renderKbHome({ isError: false, error: null, refetch: () => undefined });
    expect(html).toContain("还没有内容");
    expect(html).toContain("新建一篇 Markdown 文档");
    expect(html).not.toContain('data-gx-no-permission="true"');
  });
});

describe("PERM-05：KbListFailure 的分档", () => {
  it("其余错误 → role=alert 可重试错误态（不是无权限、也不是空态）", () => {
    const html = render(
      <KbListFailure
        error={new ApiError(500, { error: "服务器错误" })}
        onRetry={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("加载失败");
    expect(html).toContain("重试");
    expect(html).not.toContain('data-gx-no-permission="true"');
  });

  it("KbHomePage 的分支顺序：失败判定必须排在空态之前", () => {
    const src = read("./KbHomePage.tsx");
    expect(src).toContain(") : docsError ? (");
    expect(src.indexOf("docsError")).toBeLessThan(src.indexOf("(docs ?? []).length === 0"));
    expect(src).toContain("<KbListFailure");
  });
});

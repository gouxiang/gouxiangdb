// 关联块的 kind="table" 分支回归：
//   - kind="table" → 渲染数据表预览（TableEmbedPreview），**不是**文档预览（RefEmbedBody）
//   - kind="doc"   → 仍走文档预览（对照组，保证分支没被写反）
//   - 分享态档位 → embedCanEdit 由宿主分享档位决定（canEdit 恒 false 也不影响）

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GxDocRef } from "../types";

const h = vi.hoisted(() => ({
  tableProps: [] as Array<Record<string, unknown>>,
  ctx: { kbId: "kb1", canEdit: true, embedCanEdit: undefined as boolean | undefined },
}));

vi.mock("../canvas-context", () => ({
  useCanvasBoard: () => ({ ctx: h.ctx }),
}));

vi.mock("../RefEmbedBody", () => ({
  RefEmbedBody: () => <span>DOC_BODY_MARKER</span>,
}));

vi.mock("../TableEmbedPreview", () => ({
  TableEmbedPreview: (props: Record<string, unknown>) => {
    h.tableProps.push(props);
    return <span>TABLE_PREVIEW_MARKER</span>;
  },
}));

import { RefEmbedCard } from "../RefEmbedCard";

function render(node: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function card(over: { gxRef: GxDocRef; canEdit?: boolean; publicToken?: string }) {
  return (
    <RefEmbedCard
      gxRef={over.gxRef}
      kbId="kb1"
      publicToken={over.publicToken}
      canEdit={over.canEdit ?? true}
      containerClassName=""
      containerStyle={{}}
      jumpEnabled
      onJump={() => {}}
    />
  );
}

describe("RefEmbedCard：kind=table 走数据表预览", () => {
  it('kind="table" 渲染 TableEmbedPreview，且不渲染文档 body', () => {
    h.tableProps.length = 0;
    h.ctx.embedCanEdit = undefined;
    const html = render(
      card({ gxRef: { docId: "tbl1", kind: "table", title: "客户台账", viewId: "v1", viewName: "看板", baseId: "b1" } }),
    );
    expect(html).toContain("TABLE_PREVIEW_MARKER");
    expect(html).not.toContain("DOC_BODY_MARKER");
    // 标题来自插入时的快照（数据表没有可解析的源文档）
    expect(html).toContain("客户台账");
    expect(h.tableProps[0]).toMatchObject({ tableId: "tbl1", viewId: "v1", canEdit: true });
  });

  it('kind="doc" 仍走文档预览（分支未被写反）', () => {
    h.tableProps.length = 0;
    h.ctx.embedCanEdit = undefined;
    const html = render(card({ gxRef: { docId: "d1", kind: "doc", title: "季度复盘" } }));
    expect(html).toContain("DOC_BODY_MARKER");
    expect(html).not.toContain("TABLE_PREVIEW_MARKER");
    expect(h.tableProps).toHaveLength(0);
  });

  it("分享态：canEdit 恒 false，但宿主档位可编辑 → 预览拿到 canEdit=true", () => {
    h.tableProps.length = 0;
    h.ctx.embedCanEdit = true; // 宿主分享档位 mode==="edit"
    render(card({ gxRef: { docId: "tbl1", kind: "table", title: "客户台账" }, canEdit: false, publicToken: "tok" }));
    expect(h.tableProps[0]).toMatchObject({ tableId: "tbl1", canEdit: true, publicToken: "tok" });
  });

  it("分享态：宿主档位只读 → 预览拿到 canEdit=false", () => {
    h.tableProps.length = 0;
    h.ctx.embedCanEdit = false; // 宿主分享档位 mode==="view"
    render(card({ gxRef: { docId: "tbl1", kind: "table", title: "客户台账" }, canEdit: false, publicToken: "tok" }));
    expect(h.tableProps[0]).toMatchObject({ tableId: "tbl1", canEdit: false });
  });
});

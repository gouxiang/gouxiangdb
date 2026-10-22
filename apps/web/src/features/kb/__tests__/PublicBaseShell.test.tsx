// apps/web/src/features/kb/__tests__/PublicBaseShell.test.tsx
// 库分享外壳落地页（node SSR）：只渲染带 token 的已分享表卡片；空态给具体文案。
// 卡片点击走 onOpenTable（PublicSharePage 内导航到 /s/:token/t/:tableId）。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { createElement } from "react";
import { StaticRouter } from "react-router-dom/server";

vi.mock("../../branding/useBranding", () => ({ useProductName: () => "构想工作台" }));

import { PublicBaseShell } from "../PublicBaseShell";
import type { PublicBaseShareDTO } from "../../../api/client";

const share: PublicBaseShareDTO = {
  kind: "base",
  token: "btok",
  mode: "view",
  canEdit: false,
  base: { id: "b1", name: "客户主数据库" },
  tables: [
    { id: "t1", name: "联系人", icon: null, token: "tok1" },
    { id: "t2", name: "未开放表", icon: null }, // 后端补字段前的缺省项：不得渲染成卡片
    { id: "t3", name: "订单", icon: "table", token: "tok3" },
  ],
};

function shot(props: Parameters<typeof PublicBaseShell>[0]) {
  return render(
    createElement(
      StaticRouter,
      { location: "/s/btok" },
      createElement(PublicBaseShell, props),
    ),
  );
}

describe("PublicBaseShell：库分享外壳", () => {
  it("渲染库名与只读徽标", () => {
    const html = shot({ share, isLoading: false, isError: false });
    expect(html).toContain("客户主数据库");
    expect(html).toContain("仅可见");
  });

  it("只渲染带 token 的表卡片（未单独分享的表不出现）", () => {
    const html = shot({ share, isLoading: false, isError: false });
    expect(html).toContain("联系人");
    expect(html).toContain("订单");
    expect(html).not.toContain("未开放表");
  });

  it("没有任何可看表 → 空态给具体文案，不写泛泛占位", () => {
    const html = shot({ share: { ...share, tables: [] }, isLoading: false, isError: false });
    expect(html).toContain("还没有可查看的数据表");
  });

  it("加载中 / 出错态", () => {
    const loading = shot({ share: undefined, isLoading: true, isError: false });
    expect(loading).not.toContain("联系人");
    const err = shot({ share: undefined, isLoading: false, isError: true });
    expect(err).toContain("分享链接已失效或被取消");
  });
});

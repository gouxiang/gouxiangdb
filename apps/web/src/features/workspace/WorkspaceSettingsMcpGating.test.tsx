// M6-FE 工作区设置「MCP 接入」入口门控回归（node：react-dom/server + vi.mock）。
// 锁：GX_ENTERPRISE_ORG 开启才显示 MCP 接入入口；关闭/探测失败一律不显示（fail-closed）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let enterpriseOn = false;
let isOwner = false;
let manageMenu = false;

vi.mock("../contacts/contacts-hooks", () => ({
  useMyOrgActions: () => ({ actions: new Set(manageMenu ? ["manage_menu"] : []), isLoading: false }),
  useIsWorkspaceOwner: () => ({ isOwner, isLoading: false }),
}));

vi.mock("../search/search-admin-hooks", () => ({
  useReindex: () => ({ mutate: vi.fn(), isPending: false }),
  isForbidden: () => false,
  isSearchNotEnabled: () => false,
  errorCode: () => null,
}));

vi.mock("../settings/pat-hooks", () => ({
  useEnterpriseOrgFlag: () => enterpriseOn,
  usePatList: () => ({ data: [], isLoading: false }),
  useCreatePat: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokePat: () => ({ mutate: vi.fn(), isPending: false }),
  normalizePatError: () => ({ status: 0, code: null, message: null }),
}));

import { WorkspaceSettingsPage } from "./WorkspaceSettingsPage";

function renderPage(location = "/workspace/settings"): string {
  // 资产/导航子页内部用 useQuery（SSR 不跑 queryFn），需要 QueryClient 上下文。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <StaticRouter location={location}>
        <Routes>
          <Route path="/workspace/settings/*" element={<WorkspaceSettingsPage />} />
        </Routes>
      </StaticRouter>
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

beforeEach(() => {
  enterpriseOn = false;
  isOwner = false;
  manageMenu = false;
});

describe("工作区设置 MCP 接入入口门控（fail-closed）", () => {
  it("企业组织关闭：左侧导航不出现 MCP 接入", () => {
    enterpriseOn = false;
    const html = renderPage();
    expect(html).not.toContain("MCP 接入");
  });

  it("企业组织开启：左侧导航出现 MCP 接入", () => {
    enterpriseOn = true;
    const html = renderPage();
    expect(html).toContain("MCP 接入");
  });
});

// 子页由 URL 的 splat 驱动：刷新/直访/分享链接落到同一子页（旧的 /settings/nav 仍可用）。
describe("工作区设置子页按 URL 落位", () => {
  it("/workspace/settings/general → 通用", () => {
    const html = renderPage("/workspace/settings/general");
    expect(html).toContain("组织通讯录、导航编排与资产入口");
  });

  it("/workspace/settings/nav → 导航编排（旧链接不坏）", () => {
    manageMenu = true;
    const html = renderPage("/workspace/settings/nav");
    expect(html).toContain("导航编排");
    expect(html).not.toContain("组织通讯录、导航编排与资产入口");
  });

  it("/workspace/settings/assets → 资产", () => {
    const html = renderPage("/workspace/settings/assets");
    expect(html).toContain("智能数据库");
  });

  it("/workspace/settings/mcp（企业组织开启）→ MCP 接入", () => {
    enterpriseOn = true;
    const html = renderPage("/workspace/settings/mcp");
    expect(html).toContain("为 AI 客户端签发访问令牌");
  });
});

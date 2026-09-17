// M6-FE 工作区设置「MCP 接入」入口门控回归（node：react-dom/server + vi.mock）。
// 锁：GX_ENTERPRISE_ORG 开启才显示 MCP 接入入口；关闭/探测失败一律不显示（fail-closed）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";

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

function renderPage(): string {
  return renderToString(
    <StaticRouter location="/workspace/settings">
      <Routes>
        <Route path="/workspace/settings/*" element={<WorkspaceSettingsPage />} />
      </Routes>
    </StaticRouter>,
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

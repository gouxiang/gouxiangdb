// P2-B 回归：权限管理并入工作区设置 + 通讯录/权限分区内嵌。
//
// 锁四件事：
//   B1 FooterNav 只剩两项，/workspace/authz 路由仍然可达（直访不 404）；
//   B2 设置页「通讯录」是直接内嵌的成员/部门列表，不再是「说明 + 跳转按钮」；
//      且 /workspace/contacts 页面壳渲染的是同一个组件（不是复制的第二份实现）；
//   B3 两个分区沿用既有 ownerOnly / canSeeAuthz 口径，非 owner 不渲染、不出 disabled 假入口。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";

let isOwner = false;
let canSeeAuthzCap = true;
let actions: string[] = [];
let permPanelProps: Record<string, unknown> = {};

vi.mock("../../contacts/contacts-hooks", () => ({
  useMyOrgActions: () => ({ actions: new Set(actions), isLoading: false }),
  useIsWorkspaceOwner: () => ({ isOwner, isLoading: false }),
}));
vi.mock("../../authz/useAuthzCapability", () => ({
  useAuthzCapability: () => ({ canManage: canSeeAuthzCap }),
}));
vi.mock("../../contacts/ContactsDirectory", () => ({
  ContactsDirectory: () => <div data-contacts-directory="1" />,
}));
vi.mock("../../authz/PermPanel", () => ({
  default: (props: Record<string, unknown>) => {
    permPanelProps = props;
    return <div data-perm-panel-embedded="1" />;
  },
}));
vi.mock("../../settings/pat-hooks", () => ({
  useEnterpriseOrgFlag: () => false,
  usePatList: () => ({ data: [], isLoading: false }),
  useCreatePat: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokePat: () => ({ mutate: vi.fn(), isPending: false }),
  normalizePatError: () => ({ status: 0, code: null, message: null }),
}));
vi.mock("../../search/search-admin-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useReindex: () => ({ mutate: vi.fn(), isPending: false }) };
});

import { WorkspaceSettingsPage } from "../WorkspaceSettingsPage";
import ContactsPage from "../../contacts/ContactsPage";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const appSrc = read("../../../App.tsx");
const settingsSrc = read("../WorkspaceSettingsPage.tsx");
const contactsSrc = read("../../contacts/ContactsPage.tsx");
const directorySrc = read("../../contacts/ContactsDirectory.tsx");

function renderAt(location: string, node: React.ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <StaticRouter location={location}>
        <Routes>
          <Route path="/workspace/settings/*" element={node} />
          <Route path="/workspace/contacts" element={node} />
        </Routes>
      </StaticRouter>
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

const GENERAL = "管理组织通讯录与资产入口";

beforeEach(() => {
  isOwner = false;
  canSeeAuthzCap = true;
  actions = [];
  permPanelProps = {};
});

describe("B1：底部区只剩两项，但路由仍可达", () => {
  it("App 仍注册 /workspace/authz → PermPanel（删导航入口≠删页面）", () => {
    expect(appSrc).toContain('path="/workspace/authz"');
    expect(appSrc).toContain("<PermPanel />");
  });

  it("设置页左二级新增「权限管理」分区，图标沿用 shield", () => {
    isOwner = true;
    actions = ["manage_share"];
    const html = renderAt("/workspace/settings/assets", <WorkspaceSettingsPage />);
    expect(html).toContain("权限管理");
    expect(html).toContain("资源树授权与策略下发");
  });
});

describe("B2：通讯录分区是真的列表，不再是跳转按钮", () => {
  it("直戳 /settings/contacts 渲染内嵌的 ContactsDirectory", () => {
    isOwner = true;
    const html = renderAt("/workspace/settings/contacts", <WorkspaceSettingsPage />);
    expect(html).toContain("data-contacts-directory");
  });

  it("旧的「打开通讯录」按钮与「这里只做入口」文案已删除", () => {
    expect(contactsSrc).not.toContain("打开通讯录");
    expect(settingsSrc).not.toContain("打开通讯录");
    expect(settingsSrc).not.toContain("这里只做入口");
    expect(settingsSrc).not.toContain('navigate("/workspace/contacts")');
  });

  it("/workspace/contacts 页面壳只做路由占位，主体与设置页是同一个组件", () => {
    const html = renderAt("/workspace/contacts", <ContactsPage />);
    expect(html).toContain("data-contacts-directory");
    // 页面壳里不再重复实现列表：去重后不应再出现 DeptTree / MemberList 的直接引用
    expect(contactsSrc).not.toContain("DeptTree");
    expect(contactsSrc).not.toContain("MemberList");
    expect(contactsSrc).toContain("ContactsDirectory");
  });

  it("抽出后 window resize 监听仍然成对（注销在同一个 effect 的 cleanup 里）", () => {
    expect(directorySrc).toContain('window.addEventListener("resize", onResize)');
    expect(directorySrc).toContain('return () => window.removeEventListener("resize", onResize)');
  });
});

describe("B3：非 owner / 无能力不渲染，不出 disabled 假入口", () => {
  it("owner + manage_share：通讯录与权限管理都能进", () => {
    isOwner = true;
    actions = ["manage_share"];
    expect(renderAt("/workspace/settings/contacts", <WorkspaceSettingsPage />)).toContain(
      "data-contacts-directory",
    );
    const authz = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(authz).toContain("data-perm-panel-embedded");
  });

  it("非 owner：左二级不出现这两个分区（连 disabled 入口也没有）", () => {
    isOwner = false;
    actions = ["manage_departments"];
    const html = renderAt("/workspace/settings/assets", <WorkspaceSettingsPage />);
    expect(html).not.toContain("资源树授权与策略下发");
    // 通讯录分区描述文案不应出现在任何入口（左栏 button 的 title 用它）
    expect(html).not.toContain("部门、成员与组织角色");
  });

  it("非 owner 直戳 /settings/contacts 与 /settings/authz 都回落通用，不空白也不穿后置 general", () => {
    isOwner = false;
    actions = ["manage_share"];
    expect(renderAt("/workspace/settings/contacts", <WorkspaceSettingsPage />)).toContain(GENERAL);
    const authz = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(authz).toContain(GENERAL);
    expect(authz).not.toContain("data-perm-panel-embedded");
  });

  it("owner 但无任一授权动作且/authzManage 时：权限分区不出，通讯录仍在（不当成一刀切）", () => {
    isOwner = true;
    actions = [];
    canSeeAuthzCap = false;
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("data-perm-panel-embedded");
    expect(html).toContain("部门、成员与组织角色");
  });

  it("内嵌 PermPanel 走 embedded（不重复一个大标题）", () => {
    isOwner = true;
    actions = ["manage_share"];
    renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(permPanelProps.embedded).toBe(true);
    expect(settingsSrc).toContain("<PermPanel embedded />");
  });
});

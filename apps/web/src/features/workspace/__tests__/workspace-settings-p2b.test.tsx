// P2-B 回归：权限管理并入工作区设置 + 通讯录/权限分区内嵌。
//
// 锁四件事：
//   B1 FooterNav 只剩两项，/workspace/authz 路由仍然可达（直访不 404）；
//   B2 设置里不再有「通讯录」入口（一级导航底部已有），/workspace/contacts 页面壳
//      渲染的是同一个 ContactsDirectory（不是复制的第二份实现）；
//   B3 权限分区沿用既有 ownerOnly / canSeeAuthz 口径，非 owner 不渲染、不出 disabled 假入口。
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
// 权限分区现在是三块（角色 / 各库成员与分享 / 资源授权策略），下面这些子组件各自会发请求，
// 本组用例只关心分区口径与渲染位置 → 一律桩掉，保持「不发请求」的既有风格。
vi.mock("../../contacts/RoleManager", () => ({
  RoleManager: (props: { canManageRoles: boolean }) => (
    <div data-role-manager={props.canManageRoles ? "manage" : "ro"} />
  ),
}));
vi.mock("../../settings/MembersPanel", () => ({
  MembersPanel: () => <div data-members-panel="1" />,
}));
vi.mock("../../settings/SharePanel", () => ({
  SharePanel: () => <div data-share-panel="1" />,
}));
vi.mock("../../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useBases: () => ({ data: [], isLoading: false }) };
});
vi.mock("../../kb/kb-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useKbList: () => ({ data: [], isLoading: false }) };
});
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
const authzSrc = read("../WorkspaceSettingsAuthz.tsx");
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

const GENERAL = "权限、语义检索与回收站都在这里配置";

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

  it("设置页左二级有「权限管理」分区，图标沿用 shield", () => {
    isOwner = true;
    actions = ["manage_share"];
    const html = renderAt("/workspace/settings/general", <WorkspaceSettingsPage />);
    expect(html).toContain("权限管理");
    expect(html).toContain("资源树授权与策略下发");
  });
});

describe("B2：设置里不再有通讯录与资产入口", () => {
  it("设置页源码里已无 contacts / assets 分区，也不再有通讯录跳转卡", () => {
    expect(settingsSrc).not.toContain('key: "contacts"');
    expect(settingsSrc).not.toContain('key: "assets"');
    expect(settingsSrc).not.toContain("打开通讯录");
    expect(settingsSrc).not.toContain("这里只做入口");
    expect(settingsSrc).not.toContain('navigate("/workspace/contacts")');
    expect(settingsSrc).not.toContain("ContactsDirectory");
  });

  it("直戳 /settings/contacts 与 /settings/assets 都回落通用，不再渲染通讯录目录", () => {
    isOwner = true;
    const contacts = renderAt("/workspace/settings/contacts", <WorkspaceSettingsPage />);
    expect(contacts).toContain(GENERAL);
    expect(contacts).not.toContain("data-contacts-directory");
    const assets = renderAt("/workspace/settings/assets", <WorkspaceSettingsPage />);
    expect(assets).toContain(GENERAL);
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
  it("owner + manage_share：权限管理能进，三块都在（角色 / 各库成员与分享 / 授权策略）", () => {
    isOwner = true;
    actions = ["manage_share"];
    const authz = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(authz).toContain("data-perm-panel-embedded");
    expect(authz).toContain("data-role-manager");
    expect(authz).toContain("角色与组织权限");
    expect(authz).toContain("库与知识库成员权限");
    expect(authz).toContain("资源授权策略");
  });

  it("非 owner：左二级不出现权限管理分区（连 disabled 入口也没有）", () => {
    isOwner = false;
    actions = ["manage_departments"];
    const html = renderAt("/workspace/settings/general", <WorkspaceSettingsPage />);
    expect(html).not.toContain("资源树授权与策略下发");
    expect(html).not.toContain("data-perm-panel-embedded");
  });

  it("非 owner 直戳 /settings/authz 回落通用，不空白也不穿后置 general", () => {
    isOwner = false;
    actions = ["manage_share"];
    const authz = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(authz).toContain(GENERAL);
    expect(authz).not.toContain("data-perm-panel-embedded");
  });

  it("owner 但无任一授权动作且无 authzManage 时：权限分区不出，回落通用", () => {
    isOwner = true;
    actions = [];
    canSeeAuthzCap = false;
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("data-perm-panel-embedded");
  });

  it("内嵌 PermPanel 走 embedded（不重复一个大标题）", () => {
    isOwner = true;
    actions = ["manage_share"];
    renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(permPanelProps.embedded).toBe(true);
    expect(authzSrc).toContain("<PermPanel embedded />");
  });

  it("角色管理块的写能力按 manage_roles 动作下发，不按 owner 一刀切", () => {
    isOwner = true;
    actions = ["manage_share"];
    expect(renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />)).toContain(
      'data-role-manager="ro"',
    );
    actions = ["manage_share", "manage_roles"];
    expect(renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />)).toContain(
      'data-role-manager="manage"',
    );
  });
});

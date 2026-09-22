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
// 角色清单桩：三枚预设（超级管理员不可编辑不可删）+ 一枚自定义。
let roles: {
  id: string; name: string; description: string; systemKey: string | null;
  isSystem: boolean; immutable: boolean; actions: string[];
}[] = [];

const PRESET_ROLES = [
  { id: "role_super", name: "超级管理员", systemKey: "super_admin", immutable: true },
  { id: "role_admin", name: "管理员", systemKey: "admin", immutable: false },
  { id: "role_restricted", name: "受限成员", systemKey: "restricted", immutable: false },
  { id: "role_c_finance", name: "财务", systemKey: null, immutable: false },
];

const noopAsync = () => Promise.resolve({ id: "x" });

vi.mock("../../contacts/contacts-hooks", () => ({
  useMyOrgActions: () => ({ actions: new Set(actions), isLoading: false }),
  useIsWorkspaceOwner: () => ({ isOwner, isLoading: false }),
  useOrgRoles: () => ({ data: roles, isLoading: false, isError: false, refetch: vi.fn() }),
  useOrgRoleMutations: () => ({
    createRole: { mutateAsync: noopAsync, isPending: false },
    updateRole: { mutateAsync: noopAsync, isPending: false },
    removeRole: { mutateAsync: noopAsync, isPending: false },
    replaceAssignments: { mutateAsync: noopAsync, isPending: false },
  }),
}));
vi.mock("../../authz/useAuthzCapability", () => ({
  useAuthzCapability: () => ({ canManage: canSeeAuthzCap }),
}));
vi.mock("../../contacts/ContactsDirectory", () => ({
  ContactsDirectory: () => <div data-contacts-directory="1" />,
}));
// 权限分区现在是两块（上半角色与权限 / 下半选中角色的通讯录 + 库权限）。
// 原先桩掉的 MembersPanel / SharePanel 已随 WorkspaceSettingsAuthz 一起删除（零引用），
// 这两个 mock 若留着，桩的模块不存在会让用例在解析阶段就失败，故一并去掉。
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

/** 角色清单桩的装填器：顺序即面板顺序，默认选中第一枚（超级管理员第一）。 */
function setRoles(order: typeof PRESET_ROLES) {
  roles = order.map((r) => ({
    id: r.id,
    name: r.name,
    description: "",
    systemKey: r.systemKey,
    isSystem: r.systemKey !== null,
    immutable: r.immutable,
    actions: [],
  }));
}

beforeEach(() => {
  isOwner = false;
  canSeeAuthzCap = true;
  actions = [];
  setRoles(PRESET_ROLES);
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
  it("owner + edit_roles：左栏角色列表与右栏选中角色权限都在，三枚预设角色全列出", () => {
    isOwner = true;
    actions = ["view_directory", "edit_roles"];
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    // 左栏卡片：系统预设 / 自定义 两个分组都要有（此前是上下两块堆叠，改左右两栏后分组仍在）
    expect(html).toContain("系统预设");
    expect(html).toContain("自定义");
    for (const r of PRESET_ROLES) expect(html).toContain(r.name);
    // 右栏：默认选中第一枚（超级管理员），两段权限分区都要在
    expect(html).toContain("通讯录权限");
    expect(html).toContain("库权限");
  });

  it("三条硬规则里的两条（建库 / 删库）在通讯录权限里写明「勾不出来」", () => {
    isOwner = true;
    actions = ["view_directory", "edit_roles"];
    // 三枚预设角色现在都不再赋权（超级管理员锁死；管理员同权、受限成员最低权限，也只有只读
    // 说明），只有自定义角色会渲染勾选网格；硬规则行长在网格里，所以用自定义角色顶到第一枚。
    setRoles([PRESET_ROLES[3]!, ...PRESET_ROLES.filter((r) => r.id !== "role_c_finance")]);
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(html).toContain("建库 / 建知识库");
    expect(html).toContain("仅超级管理员与管理员");
    expect(html).toContain("删除库");
    expect(html).toContain("仅超级管理员");
  });

  it("管理员 / 受限成员不再渲染权限网格，只给一句为什么不能配", () => {
    isOwner = true;
    actions = ["view_directory", "edit_roles"];
    for (const [id, reason] of [
      ["role_admin", "管理员与超级管理员同权"],
      ["role_restricted", "受限成员是系统预设的最低权限角色"],
    ] as const) {
      const picked = PRESET_ROLES.find((r) => r.id === id)!;
      setRoles([picked, ...PRESET_ROLES.filter((r) => r.id !== id)]);
      const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
      expect(html, `${picked.name} 应给出不可赋权的原因`).toContain(reason);
      // 勾不出来的硬证据：网格整体没渲染——连网格里的硬规则行和保存按钮都不在
      expect(html, `${picked.name} 不该出现硬规则行`).not.toContain("建库 / 建知识库");
      expect(html, `${picked.name} 不该出现保存按钮`).not.toContain("保存通讯录权限");
    }
  });

  it("超级管理员角色不可编辑、不可删除，且给出原因", () => {
    isOwner = true;
    actions = ["view_directory", "edit_roles", "delete_roles"];
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(html).toContain("不可编辑、不可删除");
    expect(html).toContain("超级管理员是系统内置角色");
  });

  it("角色写能力按 create/edit/delete_roles 下发，不按 owner 一刀切", () => {
    isOwner = true;
    actions = ["view_directory"];
    // 无 create_roles：新建按钮禁用并把原因挂在 title 上（不做「点了才报错」的假入口）
    expect(renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />)).toContain(
      "需要「新建角色」权限才能新建自定义角色",
    );
    actions = ["view_directory", "create_roles"];
    expect(renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />)).not.toContain(
      "需要「新建角色」权限才能新建自定义角色",
    );
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

  it("owner 但无任一授权动作且无 authzManage 时：权限分区不出，回落通用", () => {
    isOwner = true;
    actions = [];
    canSeeAuthzCap = false;
    const html = renderAt("/workspace/settings/authz", <WorkspaceSettingsPage />);
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("角色与权限");
  });
});

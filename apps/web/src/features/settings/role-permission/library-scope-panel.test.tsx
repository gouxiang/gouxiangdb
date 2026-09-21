// apps/web/src/features/settings/role-permission/library-scope-panel.test.tsx
// 库权限面板的 SSR 回归（Modal 走 createPortal，本仓无 jsdom，只测首屏结构）。
//
// 锁三条界面纪律：
//   1. 可管理的库在「可见库」清单里必为勾选且不可取消（可管理隐含可见）；
//   2. 「设置」按钮只在可见（或可管理）的库行上出现；
//   3. 库视野接口出错时不渲染任何可勾框，也不给保存按钮（整份替换下误保存 = 清空授权）。

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoleLibraryScopeDTO } from "@gx/shared-types";

let scopes: RoleLibraryScopeDTO[] = [];
let scopesError = false;
let bases: { id: string; name: string }[] = [];
let kbs: { id: string; name: string }[] = [];

vi.mock("../../../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useBases: () => ({ data: bases, isLoading: false, isError: false }),
    useRoleScopes: () => ({
      data: scopesError ? undefined : scopes,
      isLoading: false,
      isError: scopesError,
      refetch: vi.fn(),
    }),
    useRoleScopesSave: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRoleScopesVisibility: () => ({ data: undefined, isLoading: false, isError: false }),
    useRoleScopesShareEnabled: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock("../../kb/kb-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useKbList: () => ({ data: kbs, isLoading: false }) };
});
vi.mock("./role-permission-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useMyRoleRefs: () => ({ roleIds: new Set<string>(), isSuperOrAdmin: false, isLoading: false }) };
});

import { LibraryScopePanel } from "./LibraryScopePanel";

const ROLE = {
  id: "r1",
  workspaceId: "w1",
  systemKey: null,
  name: "财务",
  description: "",
  isSystem: false,
  immutable: false,
  actions: [],
  createdAt: "",
  deletedAt: null,
};

function render(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <LibraryScopePanel role={ROLE} canEdit />
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

describe("库权限面板", () => {
  it("两份清单都列出库，并按类型分组", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [{ id: "k1", name: "产品知识库" }];
    scopes = [];
    const html = render();
    expect(html).toContain("可管理库");
    expect(html).toContain("可见库");
    expect(html).toContain("数据库");
    expect(html).toContain("知识库");
    expect(html).toContain("客户库");
    expect(html).toContain("产品知识库");
  });

  it("可管理的库在可见清单里勾选且禁用（不允许勾出「管得了但看不见」）", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopes = [
      {
        id: "s1", roleId: "r1", libraryKind: "base", libraryId: "b1", libraryName: "客户库",
        canManage: true, visible: false, tables: {}, fields: {}, updatedAt: "",
      },
    ];
    const html = render();
    // 两份清单各一个勾选框：可管理清单里勾选，可见清单里勾选 + 禁用
    const checked = html.match(/checked=""/g) ?? [];
    expect(checked.length).toBe(2);
    expect(html).toContain("disabled=");
  });

  it("可见的库行上才出现「设置」入口", () => {
    bases = [{ id: "b1", name: "客户库" }, { id: "b2", name: "未授权库" }];
    kbs = [];
    scopes = [
      {
        id: "s1", roleId: "r1", libraryKind: "base", libraryId: "b1", libraryName: "客户库",
        canManage: false, visible: true, tables: {}, fields: {}, updatedAt: "",
      },
    ];
    const html = render();
    expect(html).toContain("设置");
    // 只有一个库可见 → 只有一个设置入口
    expect((html.match(/>设置</g) ?? []).length).toBe(1);
  });

  it("库视野接口出错：不渲染可勾框，也不给保存按钮", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopesError = true;
    const html = render();
    expect(html).toContain("这个角色的库权限没取到");
    expect(html).not.toContain("可管理库");
    expect(html).not.toContain("保存库权限");
  });
});

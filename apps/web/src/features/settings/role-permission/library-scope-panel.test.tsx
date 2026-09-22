// apps/web/src/features/settings/role-permission/library-scope-panel.test.tsx
// 库权限面板的 SSR 回归（Modal 走 createPortal，本仓无 jsdom，只测首屏结构）。
//
// 锁新形态与三条界面纪律：
//   1. 一行式：一行里同时有库名和「可管理 / 可见 / 可分享」三个勾选，列头各带问号说明；
//   2. 可管理隐含可见 / 隐含分享权、可分享隐含可见：勾了可管理或可分享，可见都勾选且不可单独取消；
//   3. 库视野接口出错时不渲染任何可勾框，也不给保存按钮（整份替换下误保存 = 清空授权）。

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoleLibraryScopeDTO } from "@gx/shared-types";
import { LIBRARY_SHARE_SCOPE_NOTE } from "./labels";

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
  };
});
vi.mock("../../kb/kb-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useKbList: () => ({ data: kbs, isLoading: false }) };
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

function render(canEdit = true): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <LibraryScopePanel role={ROLE} canEdit={canEdit} />
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

/** 数出 SSR 里的布尔属性出现次数（React 对 true 渲染成 `attr=""`，false 整条省略）。 */
function countAttr(html: string, attr: string): number {
  return (html.match(new RegExp(`${attr}=""`, "g")) ?? []).length;
}

describe("库权限面板 · 一行式新形态", () => {
  it("表头给出「可管理 / 可见 / 可分享」三列，各带问号说明；行里库名与三个勾选同现", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [{ id: "k1", name: "产品知识库" }];
    scopes = [];
    const html = render();

    // 三列列头
    expect(html).toContain("可管理");
    expect(html).toContain("可见");
    expect(html).toContain("可分享");
    // 问号图标的说明走 title（鼠标悬停可见）
    expect(html).toContain("勾了可管理就一定能进");
    expect(html).toContain("库里全部内容都是只读可见");
    expect(html).toContain("勾了可管理自动就有分享权");
    // 库名 + base/kb 分组
    expect(html).toContain("客户库");
    expect(html).toContain("产品知识库");
    expect(html).toContain("数据库");
    expect(html).toContain("知识库");
    // 一个库一行、一行三个勾选
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(6);
    expect(html).toContain("设置");
    // 库级「允许分享」总闸不在这里（只在各库设置页），面板必须把这句话说出来
    expect(html).toContain(LIBRARY_SHARE_SCOPE_NOTE);
  });

  it("可管理的库：可见与可分享都勾选且不可单独取消（可管理隐含可见 / 隐含分享权）", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopes = [
      {
        id: "s1", roleId: "r1", libraryKind: "base", libraryId: "b1", libraryName: "客户库",
        canManage: true, visible: false, canShare: false, tables: {}, fields: {}, updatedAt: "",
      },
    ];
    const html = render();
    // 三个勾选框全勾上
    expect(countAttr(html, "checked")).toBe(3);
    // 可见、可分享各置灰一次（可管理本身仍可取消）；再加上底部「保存库权限」默认无改动即置灰
    expect(countAttr(html, "disabled")).toBe(3);
  });

  it("只授可分享的库：可见自动勾上并置灰（可分享隐含可见）", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopes = [
      {
        id: "s1", roleId: "r1", libraryKind: "base", libraryId: "b1", libraryName: "客户库",
        canManage: false, visible: false, canShare: true, tables: {}, fields: {}, updatedAt: "",
      },
    ];
    const html = render();
    // 可见与可分享各勾上（可管理不勾）
    expect(countAttr(html, "checked")).toBe(2);
    // 可见置灰不可单独取消；底部「保存库权限」无改动亦置灰
    expect(countAttr(html, "disabled")).toBe(2);
  });

  it("未进库的库：不能配，最右「设置」置灰", () => {
    bases = [{ id: "b1", name: "客户库" }, { id: "b2", name: "未授权库" }];
    kbs = [];
    scopes = [
      {
        id: "s1", roleId: "r1", libraryKind: "base", libraryId: "b1", libraryName: "客户库",
        canManage: false, visible: true, canShare: false, tables: {}, fields: {}, updatedAt: "",
      },
    ];
    const html = render();
    // 两个库各一个「设置」按钮，外加表头一处「设置」列名
    expect((html.match(/>设置</g) ?? []).length).toBe(3);
    // 只有没进库的那一行出现置灰理由
    expect(html).toContain("这个库既不可见也不可管理");
    // b2 的「设置」+ 底部「保存库权限」（尚无改动即置灰）
    expect(countAttr(html, "disabled")).toBe(2);
  });

  it("canEdit=false：三个勾选与「设置」全部禁用，且不给保存按钮", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopes = [];
    const html = render(false);
    // 三个勾选框 + 一个设置按钮
    expect(countAttr(html, "disabled")).toBe(4);
    expect(html).not.toContain("保存库权限");
  });

  it("库视野接口出错：不渲染可勾框，也不给保存按钮", () => {
    bases = [{ id: "b1", name: "客户库" }];
    kbs = [];
    scopesError = true;
    const html = render();
    expect(html).toContain("这个角色的库权限没取到");
    expect(html).not.toContain("可分享");
    expect(html).not.toContain("保存库权限");
  });
});

describe("库权限面板 · 总闸不在这里（源码级护栏）", () => {
  const src = readFileSync(new URL("./LibraryScopePanel.tsx", import.meta.url), "utf8");

  it("角色面板不再挂库级「允许分享」开关块（总闸只留在各库设置页）", () => {
    expect(src).not.toContain("ShareToggleBlock");
    expect(src).not.toContain("useRoleScopesShareEnabled");
  });

  it("删掉开关块的位置留一句指引：总闸在库设置页，这里只定角色资格", () => {
    expect(LIBRARY_SHARE_SCOPE_NOTE).toContain("各库设置页");
    expect(LIBRARY_SHARE_SCOPE_NOTE).toContain("「允许分享」总闸");
    expect(src).toContain("LIBRARY_SHARE_SCOPE_NOTE");
  });
});

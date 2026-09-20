// 底部固定区四项的能力门控回归（纯函数、node 环境、无 jsdom、无新增依赖）。
//
// 锁的是「交互治理第一批」的验收点：
//   - 四项各用自己那套能力判定，无能力即**不可见**（不是 disabled 假装禁用）；
//   - 加载中 / 空集 / 缺失信号一律 fail-closed；
//   - 过滤后顺序必须仍是 nav-footer.ts 的定稿顺序（D-5 §2.2）；
//   - 以后端当前口径为准：/meta 不下发 authzManage 时，owner 靠 manage_share 仍可见权限管理。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { OrgAction } from "@gx/shared-types";
import {
  canSeeAuthz,
  canSeeContacts,
  canSeeNavComposer,
  canSeeWorkspaceSettings,
  isFooterNavVisible,
  visibleFooterNav,
} from "./nav-gate";
import { FOOTER_NAV_ITEMS } from "./nav-footer";

const setOf = (...actions: OrgAction[]) => new Set<OrgAction>(actions);
const OWNER = setOf(
  "manage_departments",
  "manage_members",
  "manage_roles",
  "manage_menu",
  "manage_share",
);

describe("能力判定：四项各自一套口径", () => {
  it("通讯录：三枚成员写动作与 view_directory 任一放行，其余不放行", () => {
    for (const a of [
      "manage_departments",
      "manage_members",
      "manage_roles",
      "view_directory",
    ] as OrgAction[]) {
      expect(canSeeContacts(setOf(a)), a).toBe(true);
    }
    expect(canSeeContacts(setOf("manage_menu"))).toBe(false);
    expect(canSeeContacts(setOf("manage_share"))).toBe(false);
    expect(canSeeContacts(setOf())).toBe(false);
  });

  it("只有只读通讯录权限的角色（view_directory + 邀请/创建）也能进通讯录入口", () => {
    expect(canSeeContacts(setOf("view_directory", "invite_users", "create_users"))).toBe(true);
    // 单独一枚写动作不含读：不能因为能邀请就推断能看通讯录
    expect(canSeeContacts(setOf("invite_users"))).toBe(false);
    expect(canSeeContacts(setOf("delete_users"))).toBe(false);
  });

  it("导航编排：只认 manage_menu", () => {
    expect(canSeeNavComposer(setOf("manage_menu"))).toBe(true);
    expect(canSeeNavComposer(setOf("manage_roles", "manage_share"))).toBe(false);
    expect(canSeeNavComposer(setOf())).toBe(false);
  });

  it("权限管理：authzManage 能力位与 manage_share 任一放行（两套口径都生效）", () => {
    expect(canSeeAuthz(setOf(), true)).toBe(true);
    expect(canSeeAuthz(setOf("manage_share"), false)).toBe(true);
    // 后端当前 /meta 不下发 authzManage 且账号无动作 → 不可见（这才是 P0 要修的漏口）
    expect(canSeeAuthz(setOf(), false)).toBe(false);
    expect(canSeeAuthz(setOf("manage_menu"), false)).toBe(false);
  });

  it("工作区设置：持任一枚组织管理动作即视为组织管理员", () => {
    expect(canSeeWorkspaceSettings(OWNER)).toBe(true);
    expect(canSeeWorkspaceSettings(setOf("manage_menu"))).toBe(true);
    expect(canSeeWorkspaceSettings(setOf("manage_share"))).toBe(true);
    // viewer/commenter（系统角色无组织动作）不可见
    expect(canSeeWorkspaceSettings(setOf())).toBe(false);
  });
});

describe("visibleFooterNav：过滤即剔除，且保持定稿顺序", () => {
  it("owner（五枚动作齐全）：三项全可见，顺序不变", () => {
    const visible = visibleFooterNav(FOOTER_NAV_ITEMS, { actions: OWNER, authzManage: false });
    expect(visible.map((i) => i.path)).toEqual([
      "/workspace/contacts",
      "/workspace/settings/assets",
      "/help",
    ]);
  });

  it("权限管理已下线为设置分区：持有能力与 authzManage 都不再出现在底部区（P2-B1）", () => {
    // 入口迁出后该项不再由 FOOTER_NAV_ITEMS 承载，落到 isFooterNavVisible 的默认分支；
    // 判定本身没删——它被 PermPanel（直访门控）与设置页权限分区共用。
    expect(isFooterNavVisible("/workspace/authz", { actions: OWNER, authzManage: true })).toBe(false);
    expect(FOOTER_NAV_ITEMS.map((i) => i.path)).not.toContain("/workspace/authz");
    expect(canSeeAuthz(OWNER, false)).toBe(true);
  });

  it("已下线的导航编排入口：即使持有 manage_menu 也永不可见（第三批）", () => {
    // 该路径随 menu_items 手动收纳机制一并下线，落到 isFooterNavVisible 的默认分支。
    expect(isFooterNavVisible("/workspace/settings/nav", { actions: OWNER, authzManage: true })).toBe(false);
    expect(FOOTER_NAV_ITEMS.map((i) => i.path)).not.toContain("/workspace/settings/nav");
    expect(canSeeNavComposer(OWNER)).toBe(true); // 纯函数保留给「工作区设置」的兜底判定
  });

  it("无任何能力的成员（viewer/commenter）：两个管理入口都不渲染，静态入口「帮助中心」仍在", () => {
    expect(visibleFooterNav(FOOTER_NAV_ITEMS, { actions: setOf(), authzManage: false }).map((i) => i.path)).toEqual([
      "/help",
    ]);
  });

  it("只有权限引擎能力位（authzManage）时：底部区只剩静态入口（权限入口已迁入设置页，P2-B1）", () => {
    const visible = visibleFooterNav(FOOTER_NAV_ITEMS, { actions: setOf(), authzManage: true });
    expect(visible.map((i) => i.path)).toEqual(["/help"]);
  });

  it("部分能力的混合账号按逐条判定，不做全有全无（静态入口始终在）", () => {
    const visible = visibleFooterNav(FOOTER_NAV_ITEMS, {
      actions: setOf("manage_menu"),
      authzManage: false,
    });
    expect(visible.map((i) => i.path)).toEqual(["/workspace/settings/assets", "/help"]);
  });

  it("探针未完成（loading）：管理入口一律按无能力，静态入口不受影响", () => {
    expect(visibleFooterNav(FOOTER_NAV_ITEMS, { actions: OWNER, authzManage: false, loading: true }).map((i) => i.path)).toEqual([
      "/help",
    ]);
    expect(isFooterNavVisible("/workspace/contacts", { actions: OWNER, authzManage: true, loading: true })).toBe(false);
  });

  it("未知入口不放行；过滤不修改原数组", () => {
    expect(isFooterNavVisible("/workspace/whatever", { actions: OWNER, authzManage: true })).toBe(false);
    const before = FOOTER_NAV_ITEMS.map((i) => i.path);
    visibleFooterNav(FOOTER_NAV_ITEMS, { actions: setOf(), authzManage: false });
    expect(FOOTER_NAV_ITEMS.map((i) => i.path)).toEqual(before);
  });
});

describe("侧栏个人信息栏已下线（交互治理第一批）", () => {
  // 源码断言而非渲染断言：整壳渲染需要 QueryClient/Router 全套环境，这里锁的是「入口已移除」这一事实。
  const here = (p: string) => new URL(p, import.meta.url);
  const read = (p: string) => readFileSync(here(p), "utf8");
  /** 剥离注释后判代码本体（注释里允许讲述历史，代码里不许再出现）。 */
  const code = (p: string) =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  it("新壳 WorkspaceShell：UserCard 组件本体与渲染都不再存在", () => {
    const shell = code("../WorkspaceShell.tsx");
    expect(shell).not.toContain("UserCard");
    expect(shell).not.toContain("PersonalCenterDrawer");
    expect(shell).toContain("visibleFooterNav(FOOTER_NAV_ITEMS");
  });

  it("旧壳 Sidebar / KbSidebar：底部个人信息入口同样下线", () => {
    for (const f of ["../../sidebar/Sidebar.tsx", "../../kb/KbSidebar.tsx"]) {
      const src = code(f);
      expect(src).not.toContain("PersonalCenterDrawer");
      expect(src).not.toContain("avatarColor");
      expect(src).not.toContain("personalCenterOpen");
      expect(src).not.toContain("打开个人中心");
    }
  });
});

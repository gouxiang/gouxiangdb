// apps/api/src/domain/authz/__tests__/library-visibility-canshare.test.ts
// 锁住「这个库谁能进来」台账必须把独立的「可分享」位 canShare 一路带回前端。
//
// 为什么值得单独一个测试文件：d308a77 把分享权拆成独立列后，后端裁决改成
// `canToggleShare = canManage || canShare`，权限管理页也据此把文案写成
// 「被单独授予『可分享』的角色也能开」。但 GET /libraries/:kind/:id/visibility 的
// DTO 里根本没有 canShare，前端只能拿 canManage 判——于是给某个角色单勾「可分享」
// 在界面上是个勾了不生效的假承诺：开关不出现，且没有任何测试会红。
//
// 本文件钉两件事：
//   1. 取数不能漏：findMany 的 select 必须带 canShare（漏了就会静默回退成 canManage 口径）；
//   2. 口径要一致：台账每行的 canManage || canShare 必须等于后端 synthesizeAccess 的裁决。

import { describe, expect, it, vi, beforeEach } from "vitest";

type ScopeRow = { roleId: string; canManage: number; visible: number; canShare: number };
type RoleRow = { id: string; name: string; systemKey: string | null };

const state: {
  scopes: ScopeRow[];
  roles: RoleRow[];
  selectArgs: Array<Record<string, unknown>>;
} = {
  scopes: [],
  roles: [],
  selectArgs: [],
};

vi.mock("../../../db.js", () => ({
  prisma: {
    roleLibraryScope: {
      findMany: (a: { select: Record<string, unknown> }) => {
        state.selectArgs.push(a.select);
        return Promise.resolve(state.scopes);
      },
    },
    role: { findMany: () => Promise.resolve(state.roles) },
    base: { findUnique: () => Promise.resolve({ shareEnabled: 1 }) },
    knowledgeBase: { findUnique: () => Promise.resolve({ shareEnabled: 0 }) },
  },
  withWriteTx: (_label: string, fn: (t: unknown) => unknown) => Promise.resolve(fn({})),
}));

vi.mock("../../org/roles.js", () => ({
  usersWithRole: () => Promise.resolve(["u1", "u2"]),
  ADMIN_ROLE_ID: "role_admin",
  SUPER_ADMIN_ROLE_ID: "role_owner",
}));

const { libraryVisibility } = await import("../libraryVisibility.js");
const { synthesizeAccess } = await import("../libraryPolicy.js");

const EMPTY_CFG = '{"tables":{},"fields":{}}';

/** 台账里的角色行 -> 前端据它判「我能不能开分享开关」的同一条式子。 */
const canToggleShareOf = (r: { canManage: boolean; canShare: boolean }): boolean =>
  r.canManage || r.canShare;

function seed(scopes: ScopeRow[]) {
  state.scopes = scopes;
  state.roles = scopes.map((s) => ({ id: s.roleId, name: `角色-${s.roleId}`, systemKey: null }));
}

beforeEach(() => {
  state.scopes = [];
  state.roles = [];
  state.selectArgs.length = 0;
});

describe("库视野台账的 canShare 位", () => {
  it("取数必须 select canShare（漏了会静默退回只看 canManage 的旧口径）", async () => {
    seed([{ roleId: "r1", visible: 1, canManage: 0, canShare: 1 }]);
    await libraryVisibility("base", "b1");

    expect(state.selectArgs).toHaveLength(1);
    expect(state.selectArgs[0].canShare, "select 漏 canShare 会让独立分享位在台账里恒为 false").toBe(true);
  });

  it("仅被授予 canShare（canManage=false）的角色：canShare 回 true，且判据成立", async () => {
    seed([{ roleId: "r_share", visible: 1, canManage: 0, canShare: 1 }]);
    const res = await libraryVisibility("base", "b1");

    const row = res.roles.find((r) => r.roleId === "r_share");
    expect(row, "只勾可分享的角色必须先出现在台账里，否则前端无从判定").toBeTruthy();
    expect(row!.canManage).toBe(false);
    expect(row!.canShare).toBe(true);
    expect(canToggleShareOf(row!), "被单独授予可分享的角色必须能开分享开关").toBe(true);
  });

  it("台账口径与后端裁决一致：每行的 canManage || canShare 等于 synthesizeAccess 的 canToggleShare", async () => {
    seed([
      { roleId: "r_manage", visible: 1, canManage: 1, canShare: 0 },
      { roleId: "r_share", visible: 1, canManage: 0, canShare: 1 },
      { roleId: "r_both", visible: 1, canManage: 1, canShare: 1 },
      { roleId: "r_none", visible: 1, canManage: 0, canShare: 0 },
    ]);
    const res = await libraryVisibility("base", "b1");

    for (const s of state.scopes) {
      const row = res.roles.find((r) => r.roleId === s.roleId)!;
      const verdict = synthesizeAccess([
        { canManage: s.canManage, visible: s.visible, canShare: s.canShare, config: EMPTY_CFG },
      ]).canToggleShare;
      expect(
        canToggleShareOf(row),
        `角色 ${s.roleId}：台账口径与后端裁决分裂会让界面承诺与实际放行不一致`,
      ).toBe(verdict);
    }
  });

  it("canManage=1 且 canShare=0 的存量行：canManage 照旧为 true（升级不静默收权）", async () => {
    seed([{ roleId: "r_manage", visible: 1, canManage: 1, canShare: 0 }]);
    const res = await libraryVisibility("base", "b1");

    const row = res.roles.find((r) => r.roleId === "r_manage")!;
    expect(row.canManage).toBe(true);
    expect(row.canShare).toBe(false);
    expect(canToggleShareOf(row)).toBe(true);
  });

  it("只勾 canShare 而 visible=0：不构成覆盖，不进台账（运行时 visible 闸先拦，它拿不到权）", async () => {
    seed([{ roleId: "r_share_only", visible: 0, canManage: 0, canShare: 1 }]);
    const res = await libraryVisibility("base", "b1");

    expect(res.roles).toHaveLength(0);
    expect(
      synthesizeAccess([{ canManage: 0, visible: 0, canShare: 1, config: EMPTY_CFG }]).visible,
    ).toBe(false);
  });

  it("canShare 不隐含管理权：台账里 canManage 仍为 false", async () => {
    seed([{ roleId: "r_share", visible: 1, canManage: 0, canShare: 1 }]);
    const res = await libraryVisibility("kb", "k1");

    const row = res.roles.find((r) => r.roleId === "r_share")!;
    expect(row.canManage, "分享位不得顺带放出管理权").toBe(false);
    expect(row.canShare).toBe(true);
  });
});

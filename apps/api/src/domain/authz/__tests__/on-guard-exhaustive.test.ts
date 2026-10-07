// 「身份 × 七守」穷举矩阵（权限引擎永久单一化后最重要的一道授权正确性网）。
//
// 引擎已永久、无条件生效，无 off/shadow/on、无对拍/drift。本文件不造近似：
//   - 探针路由在测试内挂载真实的七守（requireCan*），不重写判定、不 mock 引擎/配置；
//   - 期望值表逐格直接由第二代口径推导（resolveBaseAccess + permit，见 EXPECT），
//     要求真实引擎裁决与该期望完全一致。
//
// 外部只读分享链接者不进本矩阵：其请求走 routes/public.ts 分享态路径、不持用户账号、
// 不经过七守（硬规则 D 由公开路由单独强制），放入即假覆盖。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { rebuildScopePoliciesTx } from "../scopeDoubleWrite.js";
// guards.js 必须在夹具注入 globalThis.__gx_prisma【之后】动态 import：
// 顶层静态 import 会经 guards -> db.ts 在 beforeAll 前实例化指向默认库的 prisma，
// 守卫查错库 -> 401（scopeDoubleWrite 的依赖图不碰 db.ts，故 r1 文件无此问题）。
import type * as GuardsMod from "../../../guards.js";

// 七守探针列：[列名, HTTP 方法, 探针路径, 守卫在 guards 模块上的导出名]。
type GuardFn = (c: any, baseId: string) => Promise<unknown>;
type Probe = [string, string, string, keyof typeof GuardsMod];
const PROBES: Probe[] = [
  ["view", "GET", "/view", "requireCanView"],
  ["edit", "POST", "/edit", "requireCanEditData"],
  ["schema", "GET", "/schema", "requireCanManageSchema"],
  ["manage", "POST", "/manage", "requireCanManageBase"],
  ["delete", "DELETE", "/delete", "requireCanDeleteBase"],
  ["toggle", "PATCH", "/toggle", "requireCanToggleShare"],
  ["comment", "POST", "/comment", "requireCanComment"],
];

/**
 * 期望值表：身份 -> 七列状态码。逐格按第二代口径推导（不看引擎实现）：
 *   super 全 200（硬规则 + workspace owner 兜底）；
 *   admin 无 scope：仅 visible（库门 enter）+ 硬给的 canToggleShare；
 *   admin canManage / 库管理员：除删库外全 200（删库硬规则 A 仅超管）；
 *   editor(visible+逐表 update)：view/edit/comment 200，其余 403；toggle 非管理员 -> 403；
 *   viewer(仅 visible)：只 view 200；
 *   canShare-only / 零角色：visible=0，全 403。
 */
const A = 200;
const F = 403;
const EXPECT: Record<string, number[]> = {
  super: [A, A, A, A, A, A, A],
  adminNoScope: [A, F, F, F, F, A, F],
  adminCanManage: [A, A, A, A, F, A, A],
  libAdmin: [A, A, A, A, F, A, A],
  editor: [A, A, F, F, F, F, A],
  viewer: [A, F, F, F, F, F, F],
  canShareOnly: [F, F, F, F, F, F, F],
  zero: [F, F, F, F, F, F, F],
};
const IDENTITIES = Object.keys(EXPECT);

let h: CharHarness;
let probeApp: Hono;
let guards: typeof GuardsMod;
/** 身份 -> 被测库：adminCanManage 走 N，其余走 M。 */
let baseOfIdentity: Record<string, string>;

beforeAll(async () => {
  h = await setupCharHarness("gx-authz-on-exhaust-");
  // 夹具已注入临时 prisma，再加载真实守卫模块。
  guards = await import("../../../guards.js");

  for (const u of IDENTITIES) await h.createUser(u);
  await h.grantRole("super"); // 超级管理员
  await h.grantRole("adminNoScope", "role_admin");
  await h.grantRole("adminCanManage", "role_admin");

  for (const rid of ["libAdmin", "editor", "viewer", "canShareOnly", "zero"]) {
    await h.prisma.role.create({
      data: { id: `role_g_${rid}`, workspaceId: "ws_default", name: `穷举 ${rid}`, isSystem: 0, permissions: "[]" },
    });
    await h.prisma.roleAssignment.create({
      data: { roleId: `role_g_${rid}`, subjectType: "user", subjectId: rid, scopeType: "workspace", createdBy: "seed" },
    });
  }

  // 被测库由超管创建：保证任一身份都不是 createdBy（否则 creator 兜底造成假绿）。
  // 需两个库：role_admin 的 canManage 是角色级行，无法在同一库区分「有/无 canManage」的
  // 两个管理员——故 M 上 role_admin 无行（验无 canManage 档），N 上 role_admin 给 canManage
  // 行（验 canManage 档）；adminCanManage 绑定 N，其余身份绑定 M。
  async function createBase(name: string): Promise<{ baseId: string; tableId: string }> {
    const b = await h.app.request("/api/bases", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("super")) },
      body: JSON.stringify({ name }),
    });
    if (b.status !== 201) throw new Error(`create base failed: ${b.status} ${await b.text()}`);
    const newBaseId = (await json<{ base: { id: string } }>(b)).base.id;
    const t = await h.app.request(`/api/tables?baseId=${newBaseId}`, { headers: await h.auth("super") });
    return { baseId: newBaseId, tableId: (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id };
  }
  const M = await createBase("穷举主库");
  const N = await createBase("穷举管理员管理库");

  // 建库事务（libraryScopeSeed.seedAdminScopeTx）会给每个新库自动落 role_admin canManage=1
  // 行并投影全权——这是产品「建完即可管理」的既有设计，但与本夹具「M 上 role_admin 无行」
  // 的前提冲突。故在播种前物理删掉 M 上自动 seed 的 role_admin 行（N 上的保留）；
  // 其投影残留由后面的 rebuildScopePoliciesTx(role_admin,[N 行]) 精确替换清除。
  await h.prisma.roleLibraryScope.deleteMany({
    where: { roleId: "role_admin", libraryKind: "base", libraryId: M.baseId },
  });

  const scopeRow = (lib: string, o: { canManage?: number; visible?: number; canShare?: number; config?: string }) => ({
    roleId: "",
    libraryKind: "base" as const,
    libraryId: lib,
    canManage: o.canManage ?? 0,
    visible: o.visible ?? 0,
    canShare: o.canShare ?? 0,
    config: o.config ?? "{}",
  });

  // 第二代 scope 行：M 上 role_admin【无行】（adminNoScope 凭硬规则进库、无管理权）；
  // N 上 role_admin 给 canManage（adminCanManage 拿管理权）。M 上其余角色各行。
  const adminRow = { ...scopeRow(N.baseId, { canManage: 1, visible: 1 }), roleId: "role_admin" };
  const rowsByRole: Record<string, unknown[]> = {
    role_admin: [adminRow],
    role_g_libAdmin: [{ ...scopeRow(M.baseId, { canManage: 1, visible: 1 }), roleId: "role_g_libAdmin" }],
    role_g_editor: [{
      ...scopeRow(M.baseId, { visible: 1, config: JSON.stringify({ tables: { [M.tableId]: { update: true } }, fields: {} }) }),
      roleId: "role_g_editor",
    }],
    role_g_viewer: [{ ...scopeRow(M.baseId, { visible: 1 }), roleId: "role_g_viewer" }],
    role_g_canShareOnly: [{ ...scopeRow(M.baseId, { canShare: 1 }), roleId: "role_g_canShareOnly" }],
    role_g_zero: [],
  };
  for (const row of [
    adminRow,
    rowsByRole.role_g_libAdmin![0],
    rowsByRole.role_g_editor![0],
    rowsByRole.role_g_viewer![0],
    rowsByRole.role_g_canShareOnly![0],
  ]) {
    const data = row as {
      roleId: string; libraryKind: string; libraryId: string;
      canManage: number; visible: number; canShare: number; config: string;
    };
    await h.prisma.roleLibraryScope.upsert({
      where: {
        roleId_libraryKind_libraryId: {
          roleId: data.roleId, libraryKind: data.libraryKind, libraryId: data.libraryId,
        },
      },
      create: data,
      update: { canManage: data.canManage, visible: data.visible, canShare: data.canShare, config: data.config },
    });
  }

  // 投影：role_admin 覆盖全部活库（M：无 canManage -> enter+manage_share；N：canManage -> 全位）；
  // 其余角色逐角色在 M 重建（其行只指向 M）。
  await rebuildScopePoliciesTx(h.prisma, "role_admin", rowsByRole.role_admin as never, "seed");
  for (const rid of ["libAdmin", "editor", "viewer", "canShareOnly", "zero"]) {
    await rebuildScopePoliciesTx(h.prisma, `role_g_${rid}`, rowsByRole[`role_g_${rid}`] as never, "seed");
  }

  // 测试内探针应用：挂真实七守；抛出的 HttpError 走 guards 的统一错误出口转状态码。
  baseOfIdentity = Object.fromEntries(
    IDENTITIES.map((id) => [id, id === "adminCanManage" ? N.baseId : M.baseId]),
  );
  probeApp = new Hono();
  probeApp.onError((e, c) => guards.errorResponse(c, e));
  for (const [, method, prefix, name] of PROBES) {
    const guard = guards[name] as GuardFn;
    probeApp.on(method, `${prefix}/:baseId`, async (c) => {
      await guard(c, c.req.param("baseId")!);
      return c.json({ ok: true });
    });
  }
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

/** 以某身份按一列探针打一次，返回状态码（被测库按身份绑定，adminCanManage 走 N）。 */
async function probe(identity: string, method: string, prefix: string): Promise<number> {
  const lib = baseOfIdentity[identity]!;
  const res = await probeApp.request(`${prefix}/${lib}`, { method, headers: await h.auth(identity) });
  return res.status;
}

describe("穷举：身份 × 七守，逐格等于期望", () => {
  it.each(IDENTITIES)("%s：七列状态码与 EXPECT 完全一致", async (identity) => {
    const got: number[] = [];
    for (const [, method, prefix] of PROBES) got.push(await probe(identity, method, prefix));
    expect(got).toEqual(EXPECT[identity]);
  });

  it("三个关键格：无行管理员 view=200（P0-A）；未勾 canManage 管理员 manage=403（P1）；纯只读 edit=403", async () => {
    expect(await probe("adminNoScope", "GET", "/view")).toBe(200);
    expect(await probe("adminNoScope", "POST", "/manage")).toBe(403);
    expect(await probe("viewer", "POST", "/edit")).toBe(403);
  });
});

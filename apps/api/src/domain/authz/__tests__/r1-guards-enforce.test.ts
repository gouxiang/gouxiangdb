// 七守 enforce 接线端到端（真迁移临时库 + 真 createApp/真 JWT/真守卫，不 mock auth/引擎）：
// 引擎永久单一化后恒定由引擎权威裁决，无 off/shadow/on、无对拍/drift/回落。
//   · 引擎 allow/deny 分别导致放行/403；
//   · 403 文案与 code 逐字保持；
//   · requireCanEditData：引擎给 edit_data 放行、撤掉即 403；
//   · requireCanToggleShare：引擎给 manage_share 放行、无则 403；
//   · requireCanDeleteBase 走 conjunction：引擎给了 d 也不放行（防删库越权），超管照删；
//   · nodeId 为 null（资源反查不到活节点）-> fail-closed 403；
//   · 管理员凭硬规则进库（P0 已闭合）：库门 enter 已投影、无内容 r、未勾 canManage 无 edit_data。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { projectImplicitAdmin } from "../implicitAdminProject.js";
import { rebuildScopePoliciesTx } from "../scopeDoubleWrite.js";

let h: CharHarness;
let baseId: string;
let tableId: string;
let baseNodeId: string;
let base2Id: string;
let base2NodeId: string;
let base3Id: string; // 直连 prisma 建、无 nav 节点（nodeId=null 用例）

const OWNER = "g_owner";
const MEMBER = "g_member";
const OUTSIDER = "g_outsider";
const ADMIN = "g_admin"; // role_admin：二代硬规则「管理员进所有库」，引擎侧无 scope 行也应有视野

async function call(method: string, url: string, userId: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(userId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const status = async (method: string, url: string, userId: string, body?: unknown): Promise<number> =>
  (await call(method, url, userId, body)).status;

const tablesUrl = (id: string) => `/api/tables?baseId=${id}`;

/** auth_policies 对 (nodeId, subjectType, subjectId) 唯一：改动作只能 upsert 同一行。 */
async function setPolicy(nodeId: string, subjectId: string, actions: string): Promise<void> {
  await h.prisma.authPolicy.upsert({
    where: { nodeId_subjectType_subjectId: { nodeId, subjectType: "user", subjectId } },
    create: {
      id: `pol_r1_${subjectId}_${nodeId}`, workspaceId: "ws_default", nodeId,
      subjectType: "user", subjectId, actions, createdBy: "test",
    },
    update: { actions },
  });
}
async function clearPolicy(nodeId: string, subjectId: string): Promise<void> {
  await h.prisma.authPolicy.deleteMany({ where: { nodeId, subjectType: "user", subjectId } });
}
const navNodeIdOf = async (resourceId: string): Promise<string> =>
  (await h.prisma.navNode.findUniqueOrThrow({
    where: { workspaceId_resourceType_resourceId: { workspaceId: "ws_default", resourceType: "base", resourceId } },
    select: { id: true },
  })).id;

beforeAll(async () => {
  h = await setupCharHarness("gx-r1-guards-");

  for (const u of [OWNER, MEMBER, OUTSIDER, ADMIN]) await h.createUser(u);
  await h.grantRole(OWNER); // 超级管理员：建库硬规则 + 引擎 workspace owner 兜底
  await h.grantRole(ADMIN, "role_admin");
  await h.prisma.role.create({ data: { id: "role_g_mem", workspaceId: "ws_default", name: "R1 可见", isSystem: 0, permissions: "[]" } });
  await h.prisma.role.create({ data: { id: "role_g_none", workspaceId: "ws_default", name: "R1 无关", isSystem: 0, permissions: "[]" } });
  for (const [u, roleId] of [[MEMBER, "role_g_mem"], [OUTSIDER, "role_g_none"]] as const) {
    await h.prisma.roleAssignment.create({
      data: { roleId, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" },
    });
  }

  const b = await call("POST", "/api/bases", OWNER, { name: "R1 主库" });
  baseId = (await json<{ base: { id: string } }>(b)).base.id;
  const b2 = await call("POST", "/api/bases", OWNER, { name: "R1 删库演练库" });
  base2Id = (await json<{ base: { id: string } }>(b2)).base.id;
  const t = await call("GET", tablesUrl(baseId), OWNER);
  tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;

  // 第二代视野：MEMBER 只勾可见（不可写/不可管理/无删库），OUTSIDER 一行都不给。
  await h.prisma.roleLibraryScope.create({
    data: { roleId: "role_g_mem", libraryKind: "base", libraryId: baseId, visible: 1, canManage: 0, config: "{}" },
  });
  await h.prisma.roleLibraryScope.create({
    data: { roleId: "role_g_mem", libraryKind: "base", libraryId: base2Id, visible: 1, canManage: 0, config: "{}" },
  });
  baseNodeId = await navNodeIdOf(baseId);
  base2NodeId = await navNodeIdOf(base2Id);

  // 引擎侧授权：MEMBER 在主库有 enter 库门（与旧视野一致）。
  await setPolicy(baseNodeId, MEMBER, "enter");

  // 无 nav 节点的库（数据缺口形态，M3 reconcile 归口，此处验证 fail-closed）。
  const b3 = await h.prisma.base.create({ data: { name: "R1 无节点库", createdBy: "seed" } });
  base3Id = b3.id;
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("1. 引擎为权威（放行与拒绝）", () => {
  it("三身份基线：超管 200 / 可见成员 200 / 无视野者 403", async () => {
    expect(await status("GET", tablesUrl(baseId), OWNER)).toBe(200);
    expect(await status("GET", tablesUrl(baseId), MEMBER)).toBe(200);
    expect(await status("GET", tablesUrl(baseId), OUTSIDER)).toBe(403);
  });

  it("引擎 deny 即 403：撤掉成员策略后，旧决策仍允也拒绝", async () => {
    await clearPolicy(baseNodeId, MEMBER);
    expect(await status("GET", tablesUrl(baseId), MEMBER)).toBe(403);
    await setPolicy(baseNodeId, MEMBER, "enter");
  });

  it("引擎 allow 即放行：给无视野者插 enter 策略，旧决策仍拒也放行", async () => {
    await setPolicy(baseNodeId, OUTSIDER, "enter");
    expect(await status("GET", tablesUrl(baseId), OUTSIDER)).toBe(200);
    await clearPolicy(baseNodeId, OUTSIDER);
  });

  it("403 文案与 code 逐字保持（引擎拒绝时）", async () => {
    const res = await call("GET", tablesUrl(baseId), OUTSIDER);
    expect(res.status).toBe(403);
    expect(await json<{ error: string; code: string }>(res)).toEqual({ error: "无权访问该 Base", code: "FORBIDDEN" });
  });
});

describe("2. requireCanEditData / requireCanToggleShare", () => {
  it("requireCanEditData：引擎给 edit_data 即放行（旧视野拒绝），撤掉即 403 且文案不变", async () => {
    // 库节点只需聚合位：写入守判 edit_data（= canManage 或任一活表可写），不判单表单动作的 u。
    await setPolicy(baseNodeId, MEMBER, "enter,edit_data");
    expect(await status("POST", `/api/records?tableId=${tableId}`, MEMBER, { fields: {} })).toBe(201);
    await setPolicy(baseNodeId, MEMBER, "enter");
    const res = await call("POST", `/api/records?tableId=${tableId}`, MEMBER, { fields: {} });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe("当前角色无权编辑数据");
  });

  it("requireCanToggleShare：引擎给 manage_share 即放行（旧视野拒绝），无则 403 且文案不变", async () => {
    const res0 = await call("PATCH", `/api/bases/${baseId}/share-enabled`, MEMBER, { enabled: true });
    expect(res0.status).toBe(403);
    expect((await json<{ error: string }>(res0)).error)
      .toBe("只有对本库有管理权限的角色、超级管理员或管理员可开关分享");

    await setPolicy(baseNodeId, MEMBER, "enter,manage_share");
    expect(await status("PATCH", `/api/bases/${baseId}/share-enabled`, MEMBER, { enabled: true })).toBe(200);
    await setPolicy(baseNodeId, MEMBER, "enter");
  });
});

describe("3. requireCanDeleteBase（conjunction）：引擎给 d 也不放行删库，超管照删", () => {
  it("非超管：引擎给 d，旧硬规则拒 -> 仍 403；超管旧允+引擎兜底 -> 200", async () => {
    // 旧硬规则 A：非超管一律不可删库；conjunction 下 legacy 拒即不放行。
    await setPolicy(base2NodeId, MEMBER, "d");
    const res = await call("DELETE", `/api/bases/${base2Id}`, MEMBER);
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe("只有超级管理员可以删除库");
    await clearPolicy(base2NodeId, MEMBER);

    // 超管：旧允 + 引擎 workspace owner 兜底 -> 放行。
    expect(await status("DELETE", `/api/bases/${base2Id}`, OWNER)).toBe(200);
  });
});

// P0 缺口【已闭合】（2026-10-03 核出 -> 同日由两枚库级聚合位 enter/edit_data 修掉）：
// 管理员 base 节点原先只有管理位、没有任何库级准入位，requireCanView 判数据动作 r，
// 故管理员被锁在库门外。现 requireCanView 改判 enter（= legacy access.visible），
// 投影侧已在库节点 emit enter。本组断言为【期望值】，不得再回退。
// 依据 docs/decisions/AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md §6 第 3 条。
describe("4. 管理员 requireCanView：库门 enter 已投影（P0 已闭合）", () => {
  it("修法证据：管理员 base 节点持 enter、manage_share，不持内容 r；未勾 canManage 时不持 edit_data", async () => {
    // 构造「主库 role_admin 未勾 canManage」形态：建库 seed 给 role_admin 落过 canManage=1 行，
    // 这里删掉该行并重算投影（管理员进库靠硬规则，删行不影响 enter/manage_share，但不再 emit edit_data）。
    await h.prisma.roleLibraryScope.deleteMany({
      where: { roleId: "role_admin", libraryKind: "base", libraryId: baseId },
    });
    const saved = await h.prisma.roleLibraryScope.findMany({ where: { roleId: "role_admin" } });
    await rebuildScopePoliciesTx(h.prisma, "role_admin", saved.map((r) => ({
      roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })), "seed");

    const pol = await h.prisma.authPolicy.findUnique({
      where: {
        nodeId_subjectType_subjectId: {
          nodeId: baseNodeId, subjectType: "role", subjectId: "role_admin",
        },
      },
    });
    expect(pol).not.toBeNull();
    const acts = (pol!.actions ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    expect(acts).toContain("enter"); // 修法落点：库门位（= access.visible）
    expect(acts).toContain("manage_share"); // 管理员 canShare 恒真，管理位不受影响
    expect(acts).not.toContain("r"); // 仍不得有内容 r：否则淹没逐表字段收窄（A-4）
    expect(acts).not.toContain("edit_data"); // 未勾 canManage 的管理员不给写并集（P1）

    // 对照：kb 节点同样 emit enter，且 kb 不 emit edit_data（§7.2-3：kb 内容写关在 content 档位）。
    const kbProj = projectImplicitAdmin({ bases: [], kbs: [{ libraryId: "kb_x" }], adminScopeRows: [] });
    expect(kbProj).toHaveLength(1);
    const kbActs = kbProj[0]!.actions.split(",").map((s) => s.trim()).filter(Boolean);
    expect(kbActs).toContain("enter");
    expect(kbActs).not.toContain("edit_data");
  });

  it("管理员 200：凭硬规则进库（引擎侧无 scope 行也有视野）", async () => {
    expect(await status("GET", tablesUrl(baseId), ADMIN)).toBe(200);
  });
});

describe("5. nodeId 为 null（资源反查不到活节点）：fail-closed 403", () => {
  it("无 nav 节点的库 -> 超管旧决策为允也 403", async () => {
    expect(await status("GET", tablesUrl(base3Id), OWNER)).toBe(403);
  });
});

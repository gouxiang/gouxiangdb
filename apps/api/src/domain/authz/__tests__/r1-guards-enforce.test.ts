// M4/R1 七守 enforce 接线端到端（真迁移临时库 + 真 createApp/真 JWT/真守卫，不 mock auth）：
//   off / shadow 两态：七守响应与接线前逐值一致（状态码全等），off 且零引擎 SQL；
//   on 态（总门 AUTHZ_ENFORCE_READY 仍为 false，生产物理降级 shadow，故用 vi.mock 强制
//   effectiveAuthzMode=on 演练——这是 R1 接线的验收重点，翻门仍由总监另做）：
//     · 引擎 allow/deny 分别导致放行/403，旧决策与引擎不一致时以引擎为准（双向都验）；
//     · 403 文案与 code 逐字保持；
//     · requireCanDeleteBase 走 conjunction：引擎给了 d 也不放行（防删库越权），超管照删；
//     · nodeId 为 null -> fail-closed 403 并计 UNRESOLVED_NODE；
//     · 引擎抛错 -> 回落旧决策（不 500）+ 计 authz_enforce_error。
// 末两条 spy Prisma delegate（restore 后该 delegate 失效，同 shadow-integration 坑），故置尾。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { driftRegistry } from "../shadow.js";

const forced = vi.hoisted(() => ({ mode: null as null | "off" | "shadow" | "on" }));
vi.mock("../../../configAuthz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../configAuthz.js")>();
  return {
    ...actual,
    effectiveAuthzMode: (env?: NodeJS.ProcessEnv) => forced.mode ?? actual.effectiveAuthzMode(env),
  };
});

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
  delete process.env.GX_AUTHZ_ENGINE;
  forced.mode = null;
  h = await setupCharHarness("gx-r1-guards-");

  for (const u of [OWNER, MEMBER, OUTSIDER]) await h.createUser(u);
  await h.grantRole(OWNER); // 超级管理员：建库硬规则 + 引擎 workspace owner 兜底
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

  // 引擎侧授权：MEMBER 在主库有 r（与旧视野一致 -> 零漂移基线）。
  await setPolicy(baseNodeId, MEMBER, "r");

  // 无 nav 节点的库（数据缺口形态，M3 reconcile 归口，此处验证 fail-closed）。
  const b3 = await h.prisma.base.create({ data: { name: "R1 无节点库", createdBy: "seed" } });
  base3Id = b3.id;
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  forced.mode = null;
  await h.cleanup();
});

beforeEach(() => driftRegistry.reset());
afterEach(() => {
  forced.mode = null;
  delete process.env.GX_AUTHZ_ENGINE;
});

/** 七守读探针：主库列表（requireCanView）+ 建记录（requireCanEditData 的只读替身不用）。 */
async function readSnapshot(): Promise<Record<string, number>> {
  return {
    owner: await status("GET", tablesUrl(baseId), OWNER),
    member: await status("GET", tablesUrl(baseId), MEMBER),
    outsider: await status("GET", tablesUrl(baseId), OUTSIDER),
  };
}

describe("1. off 基线：七守仍以旧决策为准，引擎零接入", () => {
  it("超管 200 / 可见成员 200 / 无视野者 403，compared=0", async () => {
    forced.mode = "off";
    expect(await readSnapshot()).toEqual({ owner: 200, member: 200, outsider: 403 });
    expect(driftRegistry.snapshot().compared).toBe(0);
  });
});

describe("2. shadow：响应逐值不变，正向对拍双零", () => {
  it("同一批探针与 off 全等；overDeny/overAllow=0 且 compared>0，方向为 forward", async () => {
    forced.mode = "off";
    const offSnap = await readSnapshot();
    forced.mode = "shadow";
    expect(await readSnapshot()).toEqual(offSnap);
    const s = driftRegistry.snapshot();
    expect(s.compared).toBeGreaterThan(0);
    expect(s.overDeny + s.overAllow).toBe(0);
    expect(s.comparedReverse).toBe(0);
  });
});

describe("3. on：引擎为权威（放行与拒绝两个方向）", () => {
  beforeEach(() => { forced.mode = "on"; });

  it("三身份基线：comparedReverse 计数且方向标记进环形缓冲", async () => {
    expect(await readSnapshot()).toEqual({ owner: 200, member: 200, outsider: 403 });
    const s = driftRegistry.snapshot();
    expect(s.comparedReverse).toBeGreaterThanOrEqual(3);
    expect(s.compared).toBe(s.comparedReverse);
  });

  it("引擎 deny 即 403：撤掉成员策略后，旧决策仍允也拒绝，记 OVERDENY(reverse)", async () => {
    await clearPolicy(baseNodeId, MEMBER);
    expect(await status("GET", tablesUrl(baseId), MEMBER)).toBe(403);
    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBeGreaterThanOrEqual(1);
    expect(s.recent.at(-1)!.direction).toBe("reverse");
    await setPolicy(baseNodeId, MEMBER, "r");
  });

  it("引擎 allow 即放行：给无视野者插 r 策略，旧决策仍拒也放行，记 OVERALLOW(reverse)", async () => {
    await setPolicy(baseNodeId, OUTSIDER, "r");
    expect(await status("GET", tablesUrl(baseId), OUTSIDER)).toBe(200);
    expect(driftRegistry.snapshot().overAllow).toBeGreaterThanOrEqual(1);
    await clearPolicy(baseNodeId, OUTSIDER);
  });

  it("403 文案与 code 逐字保持（引擎拒绝时）", async () => {
    const res = await call("GET", tablesUrl(baseId), OUTSIDER);
    expect(res.status).toBe(403);
    expect(await json<{ error: string; code: string }>(res)).toEqual({ error: "无权访问该 Base", code: "FORBIDDEN" });
  });

  it("requireCanEditData：引擎给 u 即放行（旧视野拒绝），撤掉 u 即 403 且文案不变", async () => {
    await setPolicy(baseNodeId, MEMBER, "r,u");
    expect(await status("POST", `/api/records?tableId=${tableId}`, MEMBER, { fields: {} })).toBe(201);
    await setPolicy(baseNodeId, MEMBER, "r");
    const res = await call("POST", `/api/records?tableId=${tableId}`, MEMBER, { fields: {} });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe("当前角色无权编辑数据");
  });

  it("requireCanToggleShare：引擎给 manage_share 即放行（旧视野拒绝），无则 403 且文案不变", async () => {
    const res0 = await call("PATCH", `/api/bases/${baseId}/share-enabled`, MEMBER, { enabled: true });
    expect(res0.status).toBe(403);
    expect((await json<{ error: string }>(res0)).error)
      .toBe("只有对本库有管理权限的角色、超级管理员或管理员可开关分享");

    await setPolicy(baseNodeId, MEMBER, "r,manage_share");
    expect(await status("PATCH", `/api/bases/${baseId}/share-enabled`, MEMBER, { enabled: true })).toBe(200);
    await setPolicy(baseNodeId, MEMBER, "r");
  });

  it("requireCanDeleteBase（conjunction）：引擎给 d 也不放行删库，超管照删", async () => {
    // 旧硬规则 A：非超管一律不可删库；引擎侧给他 d，authority 语义下这里会是 200（越权）。
    await setPolicy(base2NodeId, MEMBER, "d");
    const res = await call("DELETE", `/api/bases/${base2Id}`, MEMBER);
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe("只有超级管理员可以删除库");
    await clearPolicy(base2NodeId, MEMBER);

    // 超管：旧允 + 引擎 workspace owner 兜底 -> 放行。
    expect(await status("DELETE", `/api/bases/${base2Id}`, OWNER)).toBe(200);
  });

  it("nodeId 为 null（资源反查不到活节点）：fail-closed 403 并计 UNRESOLVED_NODE", async () => {
    expect(await status("GET", tablesUrl(base3Id), OWNER)).toBe(403); // 超管旧决策为允
    const s = driftRegistry.snapshot();
    expect(s.unresolvedNode).toBeGreaterThanOrEqual(1);
    expect(s.enforceUnresolved).toBeGreaterThanOrEqual(1);
  });
});

describe("4. on + 引擎故障：回落旧决策，不 500", () => {
  it("workspace 版本查询抛错 -> 超管仍 200，enforceErrors=1", async () => {
    forced.mode = "on";
    vi.spyOn(h.prisma.workspace, "findUnique").mockRejectedValue(new Error("engine boom"));
    expect(await status("GET", tablesUrl(baseId), OWNER)).toBe(200);
    expect(driftRegistry.snapshot().enforceErrors).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks(); // 该 delegate 此后失效，故本条为倒数第二条
  });
});

// 放文件最末：Prisma delegate spy restore 后失效，其后不得再跑任何引擎查询。
describe("5. off 零引擎 SQL（delegate 层硬证据）", () => {
  it("off 态 navNode/authPolicy/workspace 零查询", async () => {
    forced.mode = "off";
    const delegates = h.prisma as unknown as Record<string, Record<string, unknown>>;
    const spies = ["findUnique", "findFirst", "findMany", "count"].flatMap((m) =>
      ["navNode", "authPolicy", "workspace"].map(
        (d) => vi.spyOn(delegates[d]!, m as never) as unknown as ReturnType<typeof vi.fn>,
      ),
    );
    expect(await readSnapshot()).toEqual({ owner: 200, member: 200, outsider: 403 });
    expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
  });
});

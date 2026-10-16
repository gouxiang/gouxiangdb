// YN8 导航树 B 片：两人离线拖动对账（§19.6）——互不相交自动合 / 同节点不同父树冲突 /
// 同组兄弟排序冲突 / 人工 mine/theirs/custom（拖到第三位置）/ ENTITY_DELETED。
// （真 createApp + 真迁移临时库 + 真 JWT，不 mock）。
//
// 场景映射（DESIGN-OFFLINE-SYNC §19.6）：
//   A 两人各自在线建【互不相交】的分组：后者基于旧 treeVersion 推送 → 自动接受（抬基线到当前），
//     两个组都在，钟只按事实 +1。
//   B 两人把【同一节点】移到不同父：后推方落 conflict=SYNC_TREE_VERSION_CONFLICT，其移动不生效。
//   C B 的冲突：theirs → dropped，节点保持服务端位置；mine → accepted，节点改回我的位置，原行 resolved。
//   D 同组兄弟排序：一方 reorder，另一方也 reorder 同父且基线旧 → conflict（sibling_order）。
//   E custom＝拖到第三个位置：冲突用 patch.to 改判到新父，accepted 且原行 resolved。
//   F ENTITY_DELETED：移动目标父在离线期间被删 → conflict=SYNC_ENTITY_DELETED。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const U1 = "yn8b_u1";
const U2 = "yn8b_u2";
const C1 = "yn8b-dev-1";
const C2 = "yn8b-dev-2";

interface TreeResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "dropped";
  reasonCode?: string;
  newVersion?: string;
  entityId?: string;
  serverVersion?: string;
}

let seq = 0;
function cid(p: string): string { seq += 1; return `${p}-${seq}`; }

async function headers(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

function op(
  clientOpId: string,
  name: string,
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
) {
  return { clientOpId, entityType: "navnode", entityId, op: name, baseVersion, payload };
}

async function pushTree(user: string, client: string, ops: unknown[]): Promise<TreeResult[]> {
  const r = await h.app.request("/api/v1/sync/push/tree", {
    method: "POST", headers: await headers(user),
    body: JSON.stringify({ clientId: client, ops }),
  });
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(200);
  return body.result.results as TreeResult[];
}

async function treeVersion(): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: "workspace_tree:ws_default" }, select: { version: true },
  });
  return row?.version ?? 0n;
}

async function resolve(
  user: string,
  resolveOf: string,
  decision: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const r = await h.app.request("/api/v1/sync/resolve", {
    method: "POST", headers: await headers(user),
    body: JSON.stringify({ resolveOf, decision, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(U1);
  await h.createUser(U2);
  await h.grantSystemRole(U1, "owner");
  await h.grantSystemRole(U2, "owner"); // 两人都有 manage_menu
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 互不相交子树自动合并", () => {
  it("两人各建一个不同的根分组，后者基线旧 → 仍 accepted，两组并存", async () => {
    const base = await treeVersion();
    const bv = base.toString();
    // 两人都基于同一旧版本，各自新建互不相关的根分组（不同 id、不同节点）。
    const r1 = await pushTree(U1, C1, [op(cid("a"), "nav_create_group", "yn8b_grp_auto_1", bv, { name: "甲的组", parentId: "root" })]);
    expect(r1[0]?.status).toBe("accepted");
    // U2 基于旧 base 推：根层兄弟作用域理论相交，但节点互不相同——按 §19.6「双方移动互不相交子树自动合」
    // 的精神，建组只新增成员、不改他人节点，自动接受。
    const r2 = await pushTree(U2, C2, [op(cid("a"), "nav_create_group", "yn8b_grp_auto_2", bv, { name: "乙的组", parentId: "root" })]);
    expect(r2[0]?.status).toBe("accepted");
    expect(await h.prisma.navNode.findUnique({ where: { id: "yn8b_grp_auto_1" } })).toBeTruthy();
    expect(await h.prisma.navNode.findUnique({ where: { id: "yn8b_grp_auto_2" } })).toBeTruthy();
  });
});

describe("B/C. 同一节点移到不同父 → 树冲突 + 人工裁决", () => {
  it("U1/U2 都移动同一节点到各自不同分组，后者冲突；theirs/mine 二选一", async () => {
    // 准备：被移节点 child（根）。统一经 push 建组以固定可控版本（在线建组也会推钟）。
    const setup = await pushTree(U1, C1, [
      op(cid("b"), "nav_create_group", "yn8b_child", "0", { name: "节点", parentId: "root" }),
    ]);
    expect(setup[0]?.status).toBe("accepted");
    const afterChild = await treeVersion();
    const parents = await pushTree(U1, C1, [
      op(cid("b"), "nav_create_group", "yn8b_grp_p1", afterChild.toString(), { name: "父1", parentId: "root" }),
    ]);
    expect(parents[0]?.status).toBe("accepted");
    const p2 = await pushTree(U2, C2, [
      op(cid("b"), "nav_create_group", "yn8b_grp_p2", afterChild.toString(), { name: "父2", parentId: "root" }),
    ]);
    // U2 基于 afterChild（旧，缺 p1），建 p2 是新增不冲突，自动抬基线。
    expect(p2[0]?.status).toBe("accepted");
    const afterP2 = await treeVersion();
    const commonBase = afterP2.toString();

    // 两人都基于 commonBase 把同一 child 移到不同父：U1 移到 p1 先 accepted。
    const m1 = await pushTree(U1, C1, [
      op(cid("b"), "nav_move", "yn8b_child", commonBase, { to: { parentId: "yn8b_grp_p1" } }),
    ]);
    expect(m1[0]?.status).toBe("accepted");
    const afterM1 = await treeVersion();
    expect(afterM1).toBe(afterP2 + 1n);

    // U2 仍基于 commonBase 把同一 child 移到 p2 → 同节点不同父树冲突，移动不生效（child 仍在 p1）。
    const m2 = await pushTree(U2, C2, [
      op(cid("b"), "nav_move", "yn8b_child", commonBase, { to: { parentId: "yn8b_grp_p2" } }),
    ]);
    expect(m2[0]?.status).toBe("conflict");
    expect(m2[0]?.reasonCode).toBe("SYNC_TREE_VERSION_CONFLICT");
    expect(m2[0]?.serverVersion).toBe(afterM1.toString());
    let row = await h.prisma.navNode.findUnique({ where: { id: "yn8b_child" } });
    expect(row?.parentId).toBe("yn8b_grp_p1"); // U2 的移动未生效

    // theirs：采用服务端 → dropped，child 仍在 p1。
    const t = await resolve(U2, m2[0]!.clientOpId, "theirs");
    expect(t.status).toBe(200);
    expect(t.body.result.status).toBe("dropped");
    row = await h.prisma.navNode.findUnique({ where: { id: "yn8b_child" } });
    expect(row?.parentId).toBe("yn8b_grp_p1");
    const incomingDropped = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: m2[0]!.clientOpId } });
    expect(incomingDropped?.status).toBe("dropped");

    // 再造一次同节点不同父冲突用于 mine：U1 把 child 移回根，U2 基于更早版本移到 p2。
    const cur = await treeVersion();
    const back = await pushTree(U1, C1, [
      op(cid("b"), "nav_move", "yn8b_child", cur.toString(), { to: { parentId: "root" } }),
    ]);
    expect(back[0]?.status).toBe("accepted");
    const m3 = await pushTree(U2, C2, [
      op(cid("b"), "nav_move", "yn8b_child", cur.toString(), { to: { parentId: "yn8b_grp_p2" } }),
    ]);
    expect(m3[0]?.status).toBe("conflict");

    // mine：采用我的位置 → accepted（child 到 p2），原冲突行 resolved，oplog result=resolved。
    const mn = await resolve(U2, m3[0]!.clientOpId, "mine");
    expect(mn.status).toBe(200);
    expect(mn.body.result.status).toBe("accepted");
    row = await h.prisma.navNode.findUnique({ where: { id: "yn8b_child" } });
    expect(row?.parentId).toBe("yn8b_grp_p2");
    const resolvedIncoming = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: m3[0]!.clientOpId } });
    expect(resolvedIncoming?.status).toBe("resolved");
    const oplogResolved = await h.prisma.syncOpLog.findFirst({
      where: { conflictOf: m3[0]!.clientOpId, result: "resolved" },
    });
    expect(oplogResolved).toBeTruthy();
  });
});

describe("D. 同组兄弟排序冲突", () => {
  it("双方对同一父兄弟集 reorder 且基线分叉 → sibling_order 冲突", async () => {
    // 父 reorderParent 下建两个子组 s1/s2。
    const v0 = await treeVersion();
    await pushTree(U1, C1, [op(cid("d"), "nav_create_group", "yn8b_grp_rp", v0.toString(), { name: "排父", parentId: "root" })]);
    const v1 = await treeVersion();
    await pushTree(U1, C1, [op(cid("d"), "nav_create_group", "yn8b_grp_s1", v1.toString(), { name: "s1", parentId: "yn8b_grp_rp" })]);
    const v2 = await treeVersion();
    await pushTree(U1, C1, [op(cid("d"), "nav_create_group", "yn8b_grp_s2", v2.toString(), { name: "s2", parentId: "yn8b_grp_rp" })]);
    const v3 = await treeVersion();
    const base = v3.toString();

    // U1 排 [s1,s2]（同序，accepted）。
    const r1 = await pushTree(U1, C1, [
      op(cid("d"), "nav_reorder", "yn8b_grp_rp", base, { parentId: "yn8b_grp_rp", orderedIds: ["yn8b_grp_s1", "yn8b_grp_s2"] }),
    ]);
    expect(r1[0]?.status).toBe("accepted");
    // U2 基于旧 base 排相反序 → 同父兄弟作用域相交 → conflict。
    const r2 = await pushTree(U2, C2, [
      op(cid("d"), "nav_reorder", "yn8b_grp_rp", base, { parentId: "yn8b_grp_rp", orderedIds: ["yn8b_grp_s2", "yn8b_grp_s1"] }),
    ]);
    expect(r2[0]?.status).toBe("conflict");
    expect(r2[0]?.reasonCode).toBe("SYNC_TREE_VERSION_CONFLICT");
    const snap = await h.prisma.syncIncoming.findUnique({
      where: { clientOpId: r2[0]!.clientOpId }, select: { conflictServerPayload: true },
    });
    const parsed = JSON.parse(snap!.conflictServerPayload as string);
    expect(parsed.kind).toBe("tree");
  });
});

describe("E. custom 拖到第三个位置", () => {
  it("move 冲突用 patch.to 改判到新父 p3 → accepted，节点在 p3，原行 resolved", async () => {
    // child 当前在 yn8b_grp_p2（上一用例 mine 后）。先建第三位置 p3，拿到建后的干净公共基线 baseNow。
    const v = await treeVersion();
    const created = await pushTree(U1, C1, [op(cid("e"), "nav_create_group", "yn8b_grp_p3", v.toString(), { name: "父3", parentId: "root" })]);
    expect(created[0]?.status).toBe("accepted");
    const baseNow = (await treeVersion()).toString();

    // U1 基于最新版先把 child 移到 p1（accepted，钟前进）。
    const first = await pushTree(U1, C1, [
      op(cid("e"), "nav_move", "yn8b_child", baseNow, { to: { parentId: "yn8b_grp_p1" } }),
    ]);
    expect(first[0]?.status).toBe("accepted");

    // U2 仍基于旧 baseNow 把同一 child 移到 p2 → 同节点不同父真冲突（与新建 p3 无关）。
    const conflict = await pushTree(U2, C2, [
      op(cid("e"), "nav_move", "yn8b_child", baseNow, { to: { parentId: "yn8b_grp_p2" } }),
    ]);
    expect(conflict[0]?.status).toBe("conflict");
    expect(conflict[0]?.reasonCode).toBe("SYNC_TREE_VERSION_CONFLICT");

    // custom：既不采用服务端的 p1，也不采用我的 p2，而是拖到第三位置 p3。
    const r = await resolve(U2, conflict[0]!.clientOpId, "custom", {
      patch: { to: { parentId: "yn8b_grp_p3" } },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.status).toBe("accepted");
    const row = await h.prisma.navNode.findUnique({ where: { id: "yn8b_child" } });
    expect(row?.parentId).toBe("yn8b_grp_p3");
    expect(row?.path).toBe(`/yn8b_grp_p3/yn8b_child/`);
  });
});

describe("F. ENTITY_DELETED 资源失效", () => {
  it("移动到的目标父离线期间被删 → conflict=SYNC_ENTITY_DELETED", async () => {
    // 建目标父 pg 与待移节点 pm（根）。
    const v = await treeVersion();
    await pushTree(U1, C1, [op(cid("f"), "nav_create_group", "yn8b_grp_pg", v.toString(), { name: "会删的父", parentId: "root" })]);
    const v1 = await treeVersion();
    await pushTree(U1, C1, [op(cid("f"), "nav_create_group", "yn8b_grp_pm", v1.toString(), { name: "待移", parentId: "root" })]);
    const v2 = await treeVersion();
    const base = v2.toString();

    // U2 离线想把 pm 移进 pg（基于 base）。服务端这边 U1 把空组 pg 删除（钟前进）。
    const del = await pushTree(U1, C1, [op(cid("d"), "nav_delete", "yn8b_grp_pg", base, {})]);
    expect(del[0]?.status).toBe("accepted");

    const mv = await pushTree(U2, C2, [
      op(cid("f"), "nav_move", "yn8b_grp_pm", base, { to: { parentId: "yn8b_grp_pg" } }),
    ]);
    expect(mv[0]?.status).toBe("conflict");
    expect(mv[0]?.reasonCode).toBe("SYNC_ENTITY_DELETED");
    const pm = await h.prisma.navNode.findUnique({ where: { id: "yn8b_grp_pm" } });
    expect(pm?.parentId).toBeNull(); // 未移动
  });
});

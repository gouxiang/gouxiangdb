// YN8 导航树同步 A 片：navnode op 词表 + 工作区 treeVersion 钟 + /push/tree 回放 + 在线切面。
// （真 createApp + 真迁移临时库 + 真 JWT + 真组织权限，不 mock）。
// 设计权威：DESIGN-OFFLINE-SYNC §19.1（nav 词表）、§19.6（treeVersion 工作区级钟/服务端重算 path）、
//   §19.3-7（自动节点不发 nav op）、§19.4（manage_menu 当前权限重判）、§8.4（保留离线 cuid）、
//   §8.6（在线手动导航写也推进 treeVersion）、§20.1（注册表分派）、§20.5（默认 off 零行为）。
//
// A 片验收映射：
//   A 探针 phase 刷到 YN8。
//   B nav_create_group 回放：保留离线 cuid、treeVersion 0→1、oplog entityType=navnode/baseId=null。
//   C nav_rename / nav_reorder / nav_move / nav_delete 逐条回放，treeVersion 随每条 +1。
//   D move 后服务端重算子树 path/depth（不信客户端）；防环非法目标 → rejected，树不动。
//   E treeVersion 乐观锁（B 片分叉分析）：两台设备基于同一旧版本给同一分组改名 → 后推方
//     conflict=SYNC_TREE_VERSION_CONFLICT，名称不被覆盖、带 serverVersion、进同步中心。
//   F 幂等：同 clientOpId 重放回同一回执，树只改一次、钟不二次推进。
//   G 当前权限：无 manage_menu 的成员推树 op → rejected=PERMISSION_REVOKED。
//   H 未登记 op/非 navnode 实体 → rejected=OP_UNSUPPORTED；payload 非法 → 4xx rejected。
//   I 在线切面：开同步时在线建组/移动推进 treeVersion 且落 __server__ navnode oplog。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn8_owner";
const VIEWER = "yn8_viewer";
const CLIENT = "yn8-client-owner";
const CLIENT2 = "yn8-client-owner-2";

interface TreeOpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined";
  reasonCode?: string;
  reasonDetail?: string;
  seq?: string;
  newVersion?: string;
  entityId?: string;
  serverVersion?: string;
}
interface PushTreeResp {
  status: number;
  code?: string;
  results?: TreeOpResult[];
}

let pushSeq = 0;
function cid(prefix: string): string {
  pushSeq += 1;
  return `${prefix}-${pushSeq}`;
}

async function authHeader(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

function top(
  clientOpId: string,
  op: string,
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
) {
  return { clientOpId, entityType: "navnode", entityId, op, baseVersion, payload };
}

async function pushTree(user: string, clientId: string, ops: unknown[]): Promise<PushTreeResp> {
  const res = await h.app.request("/api/v1/sync/push/tree", {
    method: "POST",
    headers: await authHeader(user),
    body: JSON.stringify({ clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code, results: body.result?.results };
}

async function treeVersion(): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: "workspace_tree:ws_default" },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(VIEWER);
  await h.grantSystemRole(OWNER, "owner"); // owner 角色持 manage_menu
  await h.grantSystemRole(VIEWER, "viewer"); // viewer 无 manage_menu
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 探针", () => {
  it("on + 登录 → phase YN8", async () => {
    const r = await h.app.request("/api/v1/sync", { headers: await h.auth(OWNER) });
    expect(r.status).toBe(200);
    const body = await r.json();
    // 探针响应为平铺对象（无 result 包裹）：{apiVersion, sync, phase, …}。
    expect(body.phase).toBe("YN8");
  });
});

describe("B-D. nav 5 op 回放 + treeVersion", () => {
  const gOfflineId = "yn8grp_offline_0001";
  const g2 = "yn8grp_offline_0002";
  let gServerId = "";

  it("B create_group 保留离线 cuid，钟 0→1，oplog baseId=null", async () => {
    expect(await treeVersion()).toBe(0n);
    const r = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_create_group", gOfflineId, "0", { name: "离线分组A", parentId: "root", ord: 0 }),
    ]);
    expect(r.status).toBe(200);
    expect(r.results?.[0]?.status).toBe("accepted");
    expect(r.results?.[0]?.entityId).toBe(gOfflineId);
    expect(r.results?.[0]?.newVersion).toBe("1");
    expect(await treeVersion()).toBe(1n);
    const row = await h.prisma.navNode.findUnique({ where: { id: gOfflineId } });
    expect(row).toBeTruthy();
    expect(row?.kind).toBe("group");
    expect(row?.isSystem).toBe(0);
    expect(row?.path).toBe(`/${gOfflineId}/`);
    const log = await h.prisma.syncOpLog.findFirst({
      where: { clientOpId: r.results![0]!.clientOpId },
    });
    expect(log?.entityType).toBe("navnode");
    expect(log?.baseId).toBeNull();
    gServerId = row!.id;
  });

  it("C rename / 第二个分组 / reorder / move 逐条 +1，服务端重算 path", async () => {
    const r = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_create_group", g2, "1", { name: "子分组", parentId: gServerId, ord: 0 }),
      top(cid("g"), "nav_rename", gServerId, "2", { name: "离线分组A改" }),
      // 根层兄弟集合强一致：此刻根层只有 gServerId（g2 挂在 gServerId 下）。
      top(cid("g"), "nav_reorder", "root", "3", { parentId: "root", orderedIds: [gServerId] }),
    ]);
    expect(r.status).toBe(200);
    expect(r.results?.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(await treeVersion()).toBe(4n);
    const child = await h.prisma.navNode.findUnique({ where: { id: g2 } });
    expect(child?.path).toBe(`/${gServerId}/${g2}/`);
    expect(child?.depth).toBe(2);

    // 把 g2 从 gServerId 下移到根层（group 允许移到根），path 重算。
    const mv = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_move", g2, "4", { to: { parentId: "root", ord: 1 } }),
    ]);
    expect(mv.results?.[0]?.status).toBe("accepted");
    const moved = await h.prisma.navNode.findUnique({ where: { id: g2 } });
    expect(moved?.parentId).toBeNull();
    expect(moved?.path).toBe(`/${g2}/`);
    expect(moved?.depth).toBe(1);
    expect(moved?.ord).toBe(1);
    expect(await treeVersion()).toBe(5n);
  });

  it("D 防环：把祖先移入自己子孙 → rejected，树不动、钟不推进", async () => {
    // gServerId 与 g2 当前都在根。先把 gServerId 移到 g2 下（v5→v6），再试图把 g2 移到 gServerId 下
    //（gServerId 已成 g2 子孙 → 成环）。
    const setup = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_move", gServerId, "5", { to: { parentId: g2 } }),
    ]);
    expect(setup.results?.[0]?.status).toBe("accepted");
    expect(await treeVersion()).toBe(6n);
    const bad = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_move", g2, "6", { to: { parentId: gServerId } }),
    ]);
    expect(bad.results?.[0]?.status).toBe("rejected");
    expect(await treeVersion()).toBe(6n); // 环移动被拒，钟停在 6
    const g2row = await h.prisma.navNode.findUnique({ where: { id: g2 } });
    expect(g2row?.parentId).toBeNull(); // g2 仍在根，未被环移动破坏
  });

  it("D2 delete 空组：nav_delete accepted，行物理删除，钟 +1", async () => {
    // gServerId 此刻挂在 g2 下、但其原孩子 g2 已移走，故它是空组（空组两策略等价，直接物理删）。
    const del = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_delete", gServerId, "6", { strategy: "retain" }),
    ]);
    expect(del.results?.[0]?.status).toBe("accepted");
    const gone = await h.prisma.navNode.findUnique({ where: { id: gServerId } });
    expect(gone).toBeNull();
    expect(await treeVersion()).toBe(7n);
  });
});

describe("E. treeVersion 乐观锁", () => {
  it("两台设备基于同一旧版本给同一分组改名 → 后者 conflict，带 serverVersion，名称不被覆盖", async () => {
    // 先建一个存活分组，拿到双方共识的基线 base。
    const cur = await treeVersion();
    const grp = "yn8grp_lock_00001";
    const created = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_create_group", grp, cur.toString(), { name: "乐观锁组" }),
    ]);
    expect(created.results?.[0]?.status).toBe("accepted");
    const base = await treeVersion(); // 两台设备此刻都停在 base

    // 设备1基于 base 改名 → accepted，钟前进到 base+1。
    const first = await pushTree(OWNER, CLIENT, [
      top(cid("g"), "nav_rename", grp, base.toString(), { name: "设备1改的名" }),
    ]);
    expect(first.results?.[0]?.status).toBe("accepted");

    // 设备2仍基于旧 base 给【同一分组】改不同名 → nodes 相交（node_rename）树冲突，改名不生效。
    const r = await pushTree(OWNER, CLIENT2, [
      top(cid("g"), "nav_rename", grp, base.toString(), { name: "设备2改的名" }),
    ]);
    expect(r.results?.[0]?.status).toBe("conflict");
    expect(r.results?.[0]?.reasonCode).toBe("SYNC_TREE_VERSION_CONFLICT");
    expect(r.results?.[0]?.serverVersion).toBe((base + 1n).toString());
    // 设备2的改名未覆盖设备1。
    const row = await h.prisma.navNode.findUnique({ where: { id: grp } });
    expect(row?.name).toBe("设备1改的名");
    // 冲突进同步中心。
    const incoming = await h.prisma.syncIncoming.findFirst({
      where: { clientOpId: r.results![0]!.clientOpId, status: "conflict" },
    });
    expect(incoming).toBeTruthy();
  });
});

describe("F. 幂等", () => {
  it("同 clientOpId 重放回同一回执，钟不二次推进", async () => {
    const before = await treeVersion();
    const sameId = "yn8-idem-fixed-001";
    const op = top(sameId, "nav_create_group", "yn8grp_idem_0001", before.toString(), { name: "幂等组" });
    const r1 = await pushTree(OWNER, CLIENT, [op]);
    expect(r1.results?.[0]?.status).toBe("accepted");
    const after1 = await treeVersion();
    expect(after1).toBe(before + 1n);
    const r2 = await pushTree(OWNER, CLIENT, [op]);
    expect(r2.results?.[0]?.status).toBe("accepted");
    expect(r2.results?.[0]?.newVersion).toBe(r1.results?.[0]?.newVersion);
    expect(await treeVersion()).toBe(after1);
  });
});

describe("G. 当前权限", () => {
  it("无 manage_menu 的 viewer → rejected=PERMISSION_REVOKED，不进 oplog", async () => {
    const cur = await treeVersion();
    const r = await pushTree(VIEWER, "yn8-client-viewer", [
      top(cid("v"), "nav_create_group", "yn8grp_denied_00", cur.toString(), { name: "无权组" }),
    ]);
    expect(r.results?.[0]?.status).toBe("rejected");
    expect(r.results?.[0]?.reasonCode).toBe("SYNC_PERMISSION_REVOKED");
    expect(await h.prisma.navNode.findUnique({ where: { id: "yn8grp_denied_00" } })).toBeNull();
    expect(await treeVersion()).toBe(cur);
  });
});

describe("H. 白名单与载荷", () => {
  it("非 navnode 实体 / 未登记 op / 非法 payload 均 rejected", async () => {
    const cur = (await treeVersion()).toString();
    // 本批全部预期 rejected（任一条都不推进钟），故共用同一 cur 基线不会互相污染。
    const r = await pushTree(OWNER, CLIENT, [
      { clientOpId: cid("b"), entityType: "record", entityId: "x", op: "create", baseVersion: cur, payload: {} },
      top(cid("b"), "navnode_typo", "yn8grp_typo_000", cur, { name: "x" }),
      top(cid("b"), "nav_create_group", "yn8grp_noname_00", cur, { parentId: "root" }),
      top(cid("b"), "nav_rename", "yn8grp_missing_0", cur, { name: "改名" }),
    ] as unknown[]);
    const statuses = r.results?.map((x) => x.status);
    expect(statuses).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(r.results?.[0]?.reasonCode).toBe("SYNC_OP_UNSUPPORTED"); // record 不走树通道
    expect(r.results?.[1]?.reasonCode).toBe("SYNC_OP_UNSUPPORTED"); // 未登记 op
    expect(await treeVersion()).toBe(BigInt(cur)); // 全拒，钟不动
  });
});

describe("I. 在线切面（§8.6）", () => {
  it("同步 on 时在线建组/移动推进 treeVersion 并落 __server__ navnode oplog", async () => {
    const before = await treeVersion();
    const created = await h.app.request("/api/v1/nav/groups", {
      method: "POST",
      headers: await authHeader(OWNER),
      body: JSON.stringify({ name: "在线组", parentId: "root" }),
    });
    expect(created.status).toBe(201);
    const { id: onlineGid } = await created.json() as { id: string };
    expect(await treeVersion()).toBe(before + 1n);
    const log = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "navnode", entityId: onlineGid, op: "nav_create_group" },
      orderBy: { seq: "desc" },
    });
    expect(log).toBeTruthy();
    expect(log?.clientId).toBe("__server__");
    expect(log?.baseId).toBeNull();
  });
});

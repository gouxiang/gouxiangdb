// YN8 导航树 C 片：工作区级订阅 + 游标增量拉取，两人「离线各改 → 联网 push/pull 对账」端到端。
// （真 createApp + 真迁移临时库 + 真 JWT，不 mock）。
//
// 场景映射：
//   A subscribe workspace_tree：回 cursorSeq "0"/snapshotDone true/treeVersion "0"/scope；
//     重复订阅幂等不重置游标；scopeId 非 ws_default → 400；坏 scopeType → 400。
//   B 离线对账主干：C1/C2 都在钟 0 订阅；U1 联网建组+改名；U2 离线基于钟 0 建互不相交组，
//     联网先 push（自动合 accepted）再 pull after=0 → 按 seq 收回【全部】navnode op（含他人与自己），
//     treeVersion 反映最新钟，nextCursor=最后 seq，hasMore=false。
//   C keyset 分页：limit=1 逐页 nextCursor 递增，取尽后再拉 ops 空、游标回显。
//   D 读写分离：无 manage_menu 的登录成员 GET /pull/tree 200（登录即可读树结构），
//     POST /push/tree 逐条 rejected=PERMISSION_REVOKED；树 op 不泄露记录明文（payload 仅结构键）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const U1 = "yn8c_u1";
const U2 = "yn8c_u2";
const U3 = "yn8c_u3"; // 普通登录成员，不授 owner（无 manage_menu）
const C1 = "yn8c-dev-1";
const C2 = "yn8c-dev-2";
const C3 = "yn8c-dev-3";

interface PullTreeOp {
  seq: string;
  entityType: string;
  entityId: string;
  op: string;
  clientId: string;
  clientOpId: string;
  baseId: string | null;
  newVersion: string;
  payload: Record<string, unknown>;
}
interface PullTreeBody {
  scope: string;
  scopeId: string;
  ops: PullTreeOp[];
  nextCursor: string;
  hasMore: boolean;
  treeVersion: string;
  authzVersion: number;
}
interface TreeResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected";
  reasonCode?: string;
  newVersion?: string;
}

let seq = 0;
function cid(p: string): string { seq += 1; return `${p}-${seq}`; }

async function headers(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

function op(clientOpId: string, name: string, entityId: string, baseVersion: string, payload: Record<string, unknown>) {
  return { clientOpId, entityType: "navnode", entityId, op: name, baseVersion, payload };
}

async function subscribe(user: string, client: string, scopeType = "workspace_tree", scopeId = "ws_default") {
  const r = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST", headers: await headers(user),
    body: JSON.stringify({ clientId: client, scopeType, scopeId }),
  });
  return { status: r.status, body: await r.json() };
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

async function pullTree(user: string, client: string | null, after: string, limit?: number) {
  const q = new URLSearchParams({ after });
  if (client) q.set("clientId", client);
  if (limit !== undefined) q.set("limit", String(limit));
  const r = await h.app.request(`/api/v1/sync/pull/tree?${q.toString()}`, { headers: await h.auth(user) });
  const body = await r.json();
  return { status: r.status, body: body as { result: PullTreeBody } };
}

async function treeVersion(): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: "workspace_tree:ws_default" }, select: { version: true },
  });
  return row?.version ?? 0n;
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(U1);
  await h.createUser(U2);
  await h.createUser(U3);
  await h.grantSystemRole(U1, "owner");
  await h.grantSystemRole(U2, "owner");
  // U3  deliberately 不授权：普通登录成员（可读树、不可写树）。
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. subscribe workspace_tree 记账与入参", () => {
  it("订阅回 scope/cursor 0/snapshotDone true/treeVersion；幂等不重置", async () => {
    const s1 = await subscribe(U1, C1);
    expect(s1.status).toBe(200);
    expect(s1.body.result.scopeType).toBe("workspace_tree");
    expect(s1.body.result.scopeId).toBe("ws_default");
    expect(s1.body.result.cursorSeq).toBe("0");
    expect(s1.body.result.snapshotDone).toBe(true);
    expect(s1.body.result.treeVersion).toBe("0");
    expect(typeof s1.body.result.authzVersion).toBe("number");

    // 幂等：重复订阅仍 200、游标不被重置（推进过也保留）。
    const s2 = await subscribe(U1, C1);
    expect(s2.status).toBe(200);
    expect(s2.body.result.cursorSeq).toBe(s1.body.result.cursorSeq);
  });

  it("scopeId 非 ws_default → 400 SYNC_BAD_SCOPE；未知 scopeType → 400", async () => {
    const badScopeId = await subscribe(U1, "yn8c-bad-scope-id", "workspace_tree", "ws_other");
    expect(badScopeId.status).toBe(400);
    expect(badScopeId.body.code).toBe("SYNC_BAD_SCOPE");

    const badType = await subscribe(U1, "yn8c-bad-type", "kb", "x");
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe("SYNC_BAD_SCOPE");
  });

  it("after 非数字 → 400 SYNC_BAD_CURSOR", async () => {
    const r = await h.app.request("/api/v1/sync/pull/tree?after=abc", { headers: await h.auth(U1) });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("SYNC_BAD_CURSOR");
  });
});

describe("B. 两人离线各改 → 联网 push/pull 对账", () => {
  it("U2 拉到 U1 的建组/改名与自己离线期的建组，钟值与 seq 正确", async () => {
    // 两台设备都在钟 0 订阅。
    const sub2 = await subscribe(U2, C2);
    expect(sub2.body.result.treeVersion).toBe("0");

    // U1 联网：建组 gA，再改名（两条 op，钟 +2）。
    const c1 = await pushTree(U1, C1, [
      op(cid("b"), "nav_create_group", "yn8c_grp_gA", "0", { name: "U1原组名", parentId: "root" }),
    ]);
    expect(c1[0]?.status).toBe("accepted");
    const vAfterCreate = await treeVersion();
    const ren = await pushTree(U1, C1, [
      op(cid("b"), "nav_rename", "yn8c_grp_gA", vAfterCreate.toString(), { name: "U1改后名" }),
    ]);
    expect(ren[0]?.status).toBe("accepted");

    // U2 离线期基于钟 0 建【互不相交】组 gB：联网 push 自动合并 accepted。
    const c2 = await pushTree(U2, C2, [
      op(cid("b"), "nav_create_group", "yn8c_grp_gB", "0", { name: "U2离线组", parentId: "root" }),
    ]);
    expect(c2[0]?.status).toBe("accepted");

    const finalVersion = await treeVersion();
    expect(finalVersion).toBe(3n);

    // U2 从 0 全量拉：按 seq 升序收回 gA 建、gA 改名、gB 建三条；baseId 恒 null。
    const pulled = await pullTree(U2, C2, "0");
    expect(pulled.status).toBe(200);
    const page = pulled.body.result;
    expect(page.scope).toBe("workspace_tree");
    expect(page.scopeId).toBe("ws_default");
    expect(page.hasMore).toBe(false);
    expect(page.treeVersion).toBe("3");
    const navOps = page.ops;
    expect(navOps).toHaveLength(3);
    // seq 严格升序。
    for (let i = 1; i < navOps.length; i++) {
      expect(BigInt(navOps[i]!.seq) > BigInt(navOps[i - 1]!.seq)).toBe(true);
    }
    expect(navOps.map((o) => `${o.entityId}:${o.op}`)).toEqual([
      "yn8c_grp_gA:nav_create_group",
      "yn8c_grp_gA:nav_rename",
      "yn8c_grp_gB:nav_create_group",
    ]);
    for (const o of navOps) {
      expect(o.entityType).toBe("navnode");
      expect(o.baseId).toBeNull();
    }
    // 无记录明文：payload 只允许结构元数据键。
    const allowed = new Set(["op", "entityType", "workspaceId", "name", "parentId", "to", "orderedIds", "strategy", "from"]);
    for (const o of navOps) {
      for (const k of Object.keys(o.payload)) expect(allowed.has(k), `unexpected payload key ${k}`).toBe(true);
    }
    // newVersion 单调（钟随接受的 op 递增）。
    expect(navOps.map((o) => o.newVersion)).toEqual(["1", "2", "3"]);
  });
});

describe("C. keyset 分页与游标回显", () => {
  it("limit=1 逐页拉尽，最后空页回显 after", async () => {
    const seen: string[] = [];
    let cursor = "0";
    for (let pageNo = 0; pageNo < 6; pageNo++) {
      const r = await pullTree(U1, C1, cursor, 1);
      expect(r.status).toBe(200);
      const page = r.body.result;
      if (page.ops.length === 0) {
        // 空页：nextCursor 回显 after，hasMore=false（keyset 到底的唯一权威信号）。
        expect(page.nextCursor).toBe(cursor);
        expect(page.hasMore).toBe(false);
        break;
      }
      expect(page.ops).toHaveLength(1);
      seen.push(page.ops[0]!.seq);
      expect(BigInt(page.nextCursor) > BigInt(cursor)).toBe(true);
      cursor = page.nextCursor;
    }
    // 恰好 3 条（与 B 场景同库累计的 gA/gA rename/gB）。
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3); // 无重复/无漏（seq 唯一）。
  });
});

describe("D. 读写分离：无 manage_menu 的登录成员", () => {
  it("可读 /pull/tree 200，但写 /push/tree 被 rejected=PERMISSION_REVOKED", async () => {
    // 读：U3 未授权任何组织角色，登录即可拉树结构（与在线看树骨架同口径）。
    const got = await pullTree(U3, C3, "0");
    expect(got.status).toBe(200);
    expect(got.body.result.ops.length).toBeGreaterThan(0);

    // 写：无 manage_menu，逐条 rejected（组织动作无 quarantine 语义）。
    const denied = await pushTree(U3, C3, [
      op(cid("d"), "nav_create_group", "yn8c_grp_u3x", "0", { name: "无权组", parentId: "root" }),
    ]);
    expect(denied[0]?.status).toBe("rejected");
    expect(denied[0]?.reasonCode).toBe("SYNC_PERMISSION_REVOKED");
    // 主数据未落。
    expect(await h.prisma.navNode.findUnique({ where: { id: "yn8c_grp_u3x" } })).toBeNull();
  });
});

describe("E. 在线改树 → 离线端 pull 得到（__server__ op 双向贯通）", () => {
  it("同步 on 时在线 HTTP 建组落 clientId=__server__ 的 navnode op，订阅方 pull 能拉到", async () => {
    // 在线 UI 建组（走 /api/v1/nav/groups，manage_menu；A 片在线切面记 __server__ op）。
    const created = await h.app.request("/api/v1/nav/groups", {
      method: "POST",
      headers: await headers(U1),
      body: JSON.stringify({ name: "在线建给离线端的组", parentId: "root" }),
    });
    expect(created.status).toBe(201);
    const { id: onlineGid } = (await created.json()) as { id: string };

    // 离线订阅方（U2 的设备 C2）从 0 全量拉，应能找到该在线 op（pull 不按 clientId 裁剪，
    // 故 __server__ 在线变更与他人 push 的变更一样下发）。
    const got = await pullTree(U2, C2, "0");
    expect(got.status).toBe(200);
    const serverOp = got.body.result.ops.find(
      (o) => o.entityId === onlineGid && o.op === "nav_create_group",
    );
    expect(serverOp).toBeTruthy();
    expect(serverOp?.clientId).toBe("__server__");
    expect(serverOp?.baseId).toBeNull();
    // 钟值随在线写推进。
    expect(BigInt(got.body.result.treeVersion)).toBeGreaterThanOrEqual(BigInt(serverOp!.newVersion));
  });
});

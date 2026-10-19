// YN9 / v0.2.5-beta.2 S0 同步协议握手 / 脑裂防护契约测试。
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock；复用 orgHarness。）
// 设计权威：apps/api/src/domain/sync/protocol.ts（唯一真源）。
//
// 验收映射：
//  a 探针在 on+登录下宣告 protocolVersion/min/max=1 与 capabilities 数组。
//  b /push 不带 protocolVersion（旧客户端）：形状合法时按 v1 受理，不因缺字段被拒（additive）。
//  c /push 带 protocolVersion:1：不触发协议门，正常受理。
//  d /push 带 0（<min）：400 SYNC_PROTOCOL_TOO_OLD，且 sync_op_log/sync_incoming 无新增（fail-closed 不写库）。
//  e /push 带 2（>max）：400 SYNC_PROTOCOL_TOO_NEW，不写库。
//  f /push 带 "abc" 或 -1：400 SYNC_PROTOCOL_BAD_REQUEST。
//  g /push/tree 覆盖 d/e 各一，不写库。
//  h 读端点 GET /pull（合法 query，不带任何版本字段）正常 200（读路径不受门影响）。
//  i off 时探针仍 404 SYNC_DISABLED（总门→鉴权→协议门顺序未被破坏）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn9_owner";
const CLIENT = "yn9-client";
const PATH = "/api/v1/sync";

let baseId = "";
let tableId = "";
let pf = "";
let pushSeq = 0;
function cid(prefix: string): string {
  pushSeq += 1;
  return `${prefix}-${pushSeq}`;
}

async function syncTableCounts(): Promise<{ opLog: number; incoming: number }> {
  const [opLog, incoming] = await Promise.all([
    h.prisma.syncOpLog.count(),
    h.prisma.syncIncoming.count(),
  ]);
  return { opLog, incoming };
}

interface PushResp {
  status: number;
  code?: string;
  message?: string;
  results?: Array<{ status: string }>;
}

async function pushBase(
  ops: unknown[],
  protocolVersion?: unknown,
): Promise<PushResp> {
  const res = await h.app.request(`${PATH}/push`, {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({
      baseId, clientId: CLIENT, ops,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code, message: body.message, results: body.result?.results };
}

async function pushTree(ops: unknown[], protocolVersion?: unknown): Promise<{ status: number; code?: string }> {
  const res = await h.app.request(`${PATH}/push/tree`, {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT, ops,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code };
}

/** 一条形状合法的 record create op（gate 之后应能进入正常回放）。 */
function recordCreate(opId: string, recId: string): Record<string, unknown> {
  return {
    clientOpId: opId, entityType: "record", entityId: recId, op: "create",
    baseVersion: "0", payload: { tableId, fields: { [pf]: "x" } },
  };
}

/** 一条形状合法的 navnode 树 op（仅用于让信封本身合法；协议门会先拒）。 */
function treeOp(opId: string): Record<string, unknown> {
  return {
    clientOpId: opId, entityType: "navnode", entityId: `nav_${opId}`, op: "create",
    baseVersion: "0", payload: {},
  };
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const base = await createBase({ name: "yn9", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "dep" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;

  const sub = await h.app.request(`${PATH}/subscribe`, {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("a. 探针协议协商宣告", () => {
  it("on+登录：protocolVersion/min/max=1，capabilities 为字符串数组", async () => {
    const res = await h.app.request(PATH, { method: "GET", headers: await h.auth(OWNER) });
    expect(res.status).toBe(200);
    const body = await json<{
      protocolVersion: number;
      minProtocolVersion: number;
      maxProtocolVersion: number;
      capabilities: unknown;
    }>(res);
    expect(body.protocolVersion).toBe(1);
    expect(body.minProtocolVersion).toBe(1);
    expect(body.maxProtocolVersion).toBe(1);
    expect(Array.isArray(body.capabilities)).toBe(true);
    const caps = body.capabilities as unknown[];
    expect(caps).toContain("record-sync");
    for (const c of caps) expect(typeof c).toBe("string");
  });
});

describe("b/c. additive：旧客户端缺省与显式 v1 均受理", () => {
  it("b /push 不带 protocolVersion：形状合法按 v1 受理（accepted，不报协议错）", async () => {
    const r = await pushBase([recordCreate(cid("legacy"), `rec_yn9_legacy_${pushSeq}`)]);
    expect(r.status).toBe(200);
    expect(r.code).toBeUndefined();
    expect(r.results?.[0]?.status).toBe("accepted");
  });

  it("c /push 带 protocolVersion:1：不触发协议门，正常受理", async () => {
    const r = await pushBase([recordCreate(cid("v1"), `rec_yn9_v1_${pushSeq}`)], 1);
    expect(r.status).toBe(200);
    expect(r.results?.[0]?.status).toBe("accepted");
  });
});

describe("d/e/f. /push 协议门 fail-closed（不写库）", () => {
  it("d protocolVersion:0 → 400 SYNC_PROTOCOL_TOO_OLD，op_log/incoming 无新增", async () => {
    const before = await syncTableCounts();
    const r = await pushBase([recordCreate(cid("old"), `rec_yn9_old_${pushSeq}`)], 0);
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_TOO_OLD");
    expect(await syncTableCounts()).toEqual(before);
  });

  it("e protocolVersion:2（>max）→ 400 SYNC_PROTOCOL_TOO_NEW，不写库", async () => {
    const before = await syncTableCounts();
    const r = await pushBase([recordCreate(cid("new"), `rec_yn9_new_${pushSeq}`)], 2);
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_TOO_NEW");
    expect(await syncTableCounts()).toEqual(before);
  });

  it("f protocolVersion:'abc' → 400 SYNC_PROTOCOL_BAD_REQUEST", async () => {
    const before = await syncTableCounts();
    const r = await pushBase([recordCreate(cid("bad-str"), `rec_yn9_badstr_${pushSeq}`)], "abc");
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_BAD_REQUEST");
    expect(await syncTableCounts()).toEqual(before);
  });

  it("f protocolVersion:-1 → 400 SYNC_PROTOCOL_BAD_REQUEST", async () => {
    const before = await syncTableCounts();
    const r = await pushBase([recordCreate(cid("neg"), `rec_yn9_neg_${pushSeq}`)], -1);
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_BAD_REQUEST");
    expect(await syncTableCounts()).toEqual(before);
  });
});

describe("g. /push/tree 写端点同门", () => {
  it("g1 protocolVersion:0 → 400 SYNC_PROTOCOL_TOO_OLD，不写库", async () => {
    const before = await syncTableCounts();
    const r = await pushTree([treeOp(cid("tree-old"))], 0);
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_TOO_OLD");
    expect(await syncTableCounts()).toEqual(before);
  });

  it("g2 protocolVersion:2 → 400 SYNC_PROTOCOL_TOO_NEW，不写库", async () => {
    const before = await syncTableCounts();
    const r = await pushTree([treeOp(cid("tree-new"))], 2);
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_PROTOCOL_TOO_NEW");
    expect(await syncTableCounts()).toEqual(before);
  });
});

describe("h. 读路径不受协议门影响", () => {
  it("GET /pull 合法 query 且不带任何版本字段 → 200", async () => {
    const res = await h.app.request(
      `${PATH}/pull?baseId=${encodeURIComponent(baseId)}&after=0&limit=10`,
      { method: "GET", headers: await h.auth(OWNER) },
    );
    expect(res.status).toBe(200);
  });
});

describe("i. 总门顺序：off 仍 404 SYNC_DISABLED", () => {
  it("off 时探针 404（协议门未进组首中间件，不影响 off→404）", async () => {
    const prev = process.env.GX_SYNC_SERVER;
    delete process.env.GX_SYNC_SERVER;
    try {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth(OWNER) });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
    } finally {
      process.env.GX_SYNC_SERVER = prev;
    }
  });
});

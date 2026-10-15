// YN6 数据冲突弹窗（手动解决）契约测试
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock 决策）。
// 设计权威：DESIGN-OFFLINE-SYNC §7.1（记录级乐观锁/冲突判定）、§7.2（双版本保留 + 三选一 +
//   resolve 留痕 result=resolved/conflictOf，绝不静默覆盖）、§8.5（resolve 基于最新版本重放）、
//   §9.5（sync_conflict_resolved 审计不落字段明文）、§12（conflict→resolved/dropped 状态机）、
//   §13（POST /resolve {resolveOf, decision, clientOpId?, patch?}、GET /incoming 透出双版本）、
//   §15.2（YN6 验收：同行并发修改弹框、三选一都不丢数据、resolve 留痕）。
//
// 场景：owner 与受限编辑 ED 都有本库本表全权。owner 先建记录（v1），随后 owner 在线把记录改到 v2
//   （模拟"另一处先改了"）；ED 的离线改动基于 v1 push → conflict（不落地、存双版本）。再分别：
//   A 探针 YN6；B 冲突落库 + 双版本快照；C mine；D theirs；E custom 字段级挑选；F 非法入参/越权；
//   G oplog result=resolved/conflictOf 留痕 + 审计无明文。

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn6_owner";
const ED = "yn6_editor";
const C_ED = "yn6-client-ed";
const C_OWNER = "yn6-client-owner";

let baseId = "";
let tableId = "";
let pf = "";
let f2 = "";
let f3 = "";

// C：mine 目标（pf/f2 两字段）；B：theirs 目标（pf/f2）；E：custom 字段级挑选（pf/f2/f3）。
const RC = "rec_yn6_c";
const RB = "rec_yn6_b";
const RE = "rec_yn6_e";

const MINE_MARK = "YN6_MINE_WINS_zzz";
const THEIRS_MARK = "YN6_SERVER_KEPT_zzz";
const CUSTOM_MARK = "YN6_CUSTOM_PICK_zzz";

function op(clientOpId: string, opName: string, entityId: string, baseVersion: string, payload: Record<string, unknown>) {
  return { clientOpId, entityType: "record", entityId, op: opName, baseVersion, payload };
}

async function auth(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

/** 用超级管理员整份替换 role_restricted 对本 base 的库视野（c/r/u/d 全开、字段不隐藏）。 */
async function fullScopes(): Promise<number> {
  const res = await h.app.request("/api/v1/org/library-scopes", {
    method: "PUT",
    headers: await auth(OWNER),
    body: JSON.stringify({
      roleId: "role_restricted",
      items: [
        {
          libraryKind: "base",
          libraryId: baseId,
          visible: true,
          canManage: false,
          config: {
            tables: { [tableId]: { read: true, create: true, update: true, delete: true } },
            fields: {},
          },
        },
      ],
    }),
  });
  return res.status;
}

async function pushAs(user: string, clientId: string, ops: ReturnType<typeof op>[]) {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify({ baseId, clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    results: body.result?.results as Array<Record<string, unknown>> | undefined,
  };
}

async function listConflict(): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.request("/api/v1/sync/incoming?status=conflict", { headers: await h.auth(ED) });
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.result.items as Array<Record<string, unknown>>;
}

async function resolve(body: Record<string, unknown>, user = ED) {
  const res = await h.app.request("/api/v1/sync/resolve", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.code as string | undefined, result: json.result as Record<string, unknown> | undefined };
}

async function fieldsOf(id: string): Promise<Record<string, unknown>> {
  const rec = await h.prisma.record.findUniqueOrThrow({ where: { id } });
  return JSON.parse(rec.fields as string) as Record<string, unknown>;
}

async function readAudit(): Promise<string> {
  const file = path.join(h.tmpDir, ".audit", "audit.logl");
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(ED);
  await h.grantSystemRole(OWNER, "owner");
  await h.grantSystemRole(ED, "restricted");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const { createField } = await import("../../../../domain/fieldService.js");

  const base = await createBase({ name: "yn6", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "t" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;
  f2 = (await createField({ tableId, name: "f2", type: "text" }, OWNER)).field.id;
  f3 = (await createField({ tableId, name: "f3", type: "text" }, OWNER)).field.id;

  // owner 建三条种子（均 v1）。
  const seed = await pushAs(OWNER, C_OWNER, [
    op("seed-rc", "create", RC, "0", { tableId, fields: { [pf]: "RC", [f2]: "E" } }),
    op("seed-rb", "create", RB, "0", { tableId, fields: { [pf]: "RB", [f2]: "E" } }),
    op("seed-re", "create", RE, "0", { tableId, fields: { [pf]: "RE", [f2]: "E", [f3]: "E" } }),
  ]);
  expect(seed.results!.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);

  expect(await fullScopes()).toBe(200);
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: await auth(ED),
    body: JSON.stringify({ clientId: C_ED, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);

  // owner 在线把三条都改到 v2（模拟"ED 离线期间别人先改了"）。
  const online = await pushAs(OWNER, C_OWNER, [
    op("srv-rc", "patch", RC, "1", { tableId, changed: { [pf]: { from: "RC", to: "RC_S" }, [f2]: { from: "E", to: "S2" } } }),
    op("srv-rb", "patch", RB, "1", { tableId, changed: { [pf]: { from: "RB", to: THEIRS_MARK }, [f2]: { from: "E", to: "S2" } } }),
    op("srv-re", "patch", RE, "1", {
      tableId,
      changed: { [pf]: { from: "RE", to: "RE_S" }, [f2]: { from: "E", to: "S2" }, [f3]: { from: "E", to: THEIRS_MARK } },
    }),
  ]);
  expect(online.results!.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 探针阶段", () => {
  it("phase 刷到 YN7（YN6 冲突解决能力仍在）", async () => {
    const res = await h.app.request("/api/v1/sync", { headers: await h.auth(ED) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.phase).toBe("YN7");
  });
});

describe("B. 离线改动基于旧版本 push → conflict，双版本保留、不落地", () => {
  it("三条 ED 离线 patch（baseVersion=1，服务端已 v2）→ conflict + serverVersion=2 + 脱敏快照", async () => {
    const r = await pushAs(ED, C_ED, [
      op("ed-c", "patch", RC, "1", { tableId, changed: { [pf]: { from: "RC", to: MINE_MARK } } }),
      op("ed-b", "patch", RB, "1", { tableId, changed: { [pf]: { from: "RB", to: "ED_B" } } }),
      op("ed-e", "patch", RE, "1", { tableId, changed: { [f2]: { from: "E", to: CUSTOM_MARK }, [f3]: { from: "E", to: "ED_F3" } } }),
    ]);
    expect(r.status).toBe(200);
    expect(r.results!.map((x) => x.status)).toEqual(["conflict", "conflict", "conflict"]);
    for (const x of r.results!) {
      expect(x.reasonCode).toBe("SYNC_VERSION_CONFLICT");
      expect(x.serverVersion).toBe("2");
    }
    // 主数据原封不动（ED 的离线值一处都没落）。
    expect((await fieldsOf(RC))[pf]).toBe("RC_S");
    expect((await fieldsOf(RB))[pf]).toBe(THEIRS_MARK);
    // 没有为冲突写 oplog/推进版本（仍 v2）。
    expect(await h.prisma.syncOpLog.count({ where: { clientId: C_ED } })).toBe(0);
    const v = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: RC } });
    expect(v.version.toString()).toBe("2");
  });

  it("GET /incoming?status=conflict 透出本人三项 + 服务端当前版本快照（右版本）", async () => {
    const items = await listConflict();
    const byOp = new Map(items.map((i) => [String(i.clientOpId), i]));
    for (const cid of ["ed-c", "ed-b", "ed-e"]) expect(byOp.has(cid)).toBe(true);
    const cItem = byOp.get("ed-c")!;
    expect(cItem.serverVersion).toBe("2");
    const snap = cItem.conflictServerPayload as Record<string, unknown>;
    expect(snap).toBeTruthy();
    expect(snap.version).toBe("2");
    // 右侧是服务端当前值（owner 的 v2），供弹窗字段对照。
    expect((snap.fields as Record<string, unknown>)[pf]).toBe("RC_S");
    expect((snap.fields as Record<string, unknown>)[f2]).toBe("S2");
  });
});

describe("C. 采用我的（mine）：基于最新版本重放，我的值落地", () => {
  it("resolve mine → accepted、新版本 3、pf=我的值；原冲突项闭环不再待处理", async () => {
    const r = await resolve({ resolveOf: "ed-c", decision: "mine", clientOpId: "res-c-1" });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({
      resolveOf: "ed-c", decision: "mine", status: "accepted", newClientOpId: "res-c-1", newVersion: "3",
    });
    const f = await fieldsOf(RC);
    expect(f[pf]).toBe(MINE_MARK); // 我的改动覆盖
    expect(f[f2]).toBe("S2"); // 我没改的字段保持服务端最新（不是回滚到 E）
    // 原冲突行已闭环（置 resolved 留痕，不再出现在 conflict 待办）。
    const items = await listConflict();
    expect(items.some((i) => String(i.clientOpId) === "ed-c")).toBe(false);
    const orig = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "ed-c" } });
    expect(orig.status).toBe("resolved"); // 行不删除、只增状态留痕
    expect(orig.decidedBy).toBe(ED);
    // oplog 留痕：新 resolve op result=resolved、conflictOf 溯源。
    const resolved = await h.prisma.syncOpLog.findUniqueOrThrow({ where: { clientOpId: "res-c-1" } });
    expect(resolved.result).toBe("resolved");
    expect(resolved.conflictOf).toBe("ed-c");
    expect(resolved.op).toBe("patch");
    expect(resolved.newVersion.toString()).toBe("3");
  });

  it("幂等：重发同一 resolveOf（mine）→ 回首次结果、不重复落地、版本不再推进", async () => {
    const before = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: RC } });
    expect(before.version.toString()).toBe("3");
    // 重发（带相同 newClientOpId 也安全：原行已 resolved，根本不再重放）。
    const again = await resolve({ resolveOf: "ed-c", decision: "mine", clientOpId: "res-c-1" });
    expect(again.status).toBe(200);
    expect(again.result).toMatchObject({
      resolveOf: "ed-c", decision: "mine", status: "accepted", newClientOpId: "res-c-1", newVersion: "3",
    });
    const after = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: RC } });
    expect(after.version.toString()).toBe("3"); // 没有第二次写
    // oplog 仍只有一条 res-c-1。
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: "res-c-1" } })).toBe(1);
  });
});

describe("D. 采用服务端（theirs）：放弃本地、留痕 dropped，服务端不动", () => {
  it("resolve theirs → dropped；主数据保持服务端值；不产生 oplog", async () => {
    const before = await h.prisma.syncOpLog.count();
    const r = await resolve({ resolveOf: "ed-b", decision: "theirs" });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resolveOf: "ed-b", decision: "theirs", status: "dropped" });
    expect((await fieldsOf(RB))[pf]).toBe(THEIRS_MARK); // 服务端值保留
    expect((await fieldsOf(RB))[f2]).toBe("S2");
    // 行保留、状态 dropped（留痕，不删除），decidedBy 记账。
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "ed-b" } });
    expect(inc.status).toBe("dropped");
    expect(inc.decidedBy).toBe(ED);
    // 没产生任何新 oplog（放弃本地＝不写主数据）。
    expect(await h.prisma.syncOpLog.count()).toBe(before);
  });

  it("幂等：重发 theirs → 回 dropped、不产生 oplog", async () => {
    const before = await h.prisma.syncOpLog.count();
    const r = await resolve({ resolveOf: "ed-b", decision: "theirs" });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resolveOf: "ed-b", decision: "theirs", status: "dropped" });
    expect(await h.prisma.syncOpLog.count()).toBe(before);
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "ed-b" } });
    expect(inc.status).toBe("dropped"); // 状态不被重复改写
  });
});

describe("E. 逐字段挑选（custom）：拼一条新 patch，只让选中字段落地", () => {
  it("resolve custom（只选 f2=我的）→ accepted；f2=我的、f3 保持服务端最新（不被离线值覆盖）", async () => {
    const r = await resolve({
      resolveOf: "ed-e",
      decision: "custom",
      clientOpId: "res-e-1",
      patch: { tableId, changed: { [f2]: { to: CUSTOM_MARK } } },
    });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resolveOf: "ed-e", decision: "custom", status: "accepted", newVersion: "3" });
    const f = await fieldsOf(RE);
    expect(f[pf]).toBe("RE_S"); // 未挑选 → 服务端值
    expect(f[f2]).toBe(CUSTOM_MARK); // 挑选我的 → 落地
    expect(f[f3]).toBe(THEIRS_MARK); // 未挑选 → 保持服务端（ED_F3 不落，绝不静默覆盖）
    const resolved = await h.prisma.syncOpLog.findUniqueOrThrow({ where: { clientOpId: "res-e-1" } });
    expect(resolved.result).toBe("resolved");
    expect(resolved.conflictOf).toBe("ed-e");
  });

  it("custom 缺 changed → 400", async () => {
    // 再造一条冲突：RE 现 v3（custom 接受后），用旧版本 2 push 必冲突。
    const conflict = await pushAs(ED, C_ED, [op("ed-e2", "patch", RE, "2", { tableId, changed: { [pf]: { to: "X" } } })]);
    expect(conflict.results![0]!.status).toBe("conflict");
    const r = await resolve({ resolveOf: "ed-e2", decision: "custom", clientOpId: "res-e2-bad", patch: { tableId } });
    expect(r.status).toBe(400);
    expect(r.code).toBe("SYNC_RESOLVE_MALFORMED");
    // 失败后原冲突行仍在（用户可改选）。
    const items = await listConflict();
    expect(items.some((i) => String(i.clientOpId) === "ed-e2")).toBe(true);
  });
});

describe("F. 状态/身份/入参校验", () => {
  it("decision 非法 → 400；缺 resolveOf → 400", async () => {
    const bad = await resolve({ resolveOf: "ed-e2", decision: "coinflip" as unknown as string });
    expect(bad.status).toBe(400);
    const noOf = await h.app.request("/api/v1/sync/resolve", {
      method: "POST",
      headers: await auth(ED),
      body: JSON.stringify({ decision: "mine" }),
    });
    expect(noOf.status).toBe(400);
  });

  it("已解决项换 decision 重发 → 仍幂等回首次结果（首次裁决为准，不被翻转）", async () => {
    // ed-c 已被 mine 接受为 res-c-1（v3）；改用 theirs 重发也不放弃、不重放，仍回首次 accepted。
    const r = await resolve({ resolveOf: "ed-c", decision: "theirs" });
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resolveOf: "ed-c", status: "accepted", newClientOpId: "res-c-1" });
    expect((await fieldsOf(RC))[pf]).toBe(MINE_MARK); // 我的值仍在
  });

  it("别人的冲突项 → 404（不泄存在性）；不存在 → 404", async () => {
    // owner 去解 ED 的冲突（ed-e2 仍 conflict，actorId=ED）→ 404。
    const r = await resolve({ resolveOf: "ed-e2", decision: "theirs" }, OWNER);
    expect(r.status).toBe(404);
    const miss = await resolve({ resolveOf: "nope-nope", decision: "theirs" });
    expect(miss.status).toBe(404);
  });
});

describe("G. 审计：sync_conflict_resolved 落盘、不落字段明文", () => {
  it("mine/theirs/custom 各产生一条 resolved 审计；离线字段值明文不进日志", async () => {
    const log = await readAudit();
    const lines = log.split("\n").filter((l) => l.includes('"event":"sync_conflict_resolved"'));
    const has = (resolveOf: string, decision: string) =>
      lines.some((l) => l.includes(`"resolveOf":"${resolveOf}"`) && l.includes(`"decision":"${decision}"`) && l.includes(baseId));
    expect(has("ed-c", "mine")).toBe(true);
    expect(has("ed-b", "theirs")).toBe(true);
    expect(has("ed-e", "custom")).toBe(true);
    // 精确计数：每个冲突只在【首次解决】打一条；C/D 的幂等重发（mine 重发、theirs 重发、
    // ed-c 换 theirs 重发）都不得刷审计。全文件仅 3 条 resolved 事件（push 冲突本身不打点）。
    expect(lines.length).toBe(3);
    // 关键隐私断言：冲突解决的离线字段值绝不写进审计。
    expect(log).not.toContain(MINE_MARK);
    expect(log).not.toContain(CUSTOM_MARK);
    expect(log).not.toContain("ED_F3");
  });
});

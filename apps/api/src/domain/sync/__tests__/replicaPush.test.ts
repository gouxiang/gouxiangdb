// beta.2 S3a：出站推送泵契约测试。
// 设计权威：DESIGN-OFFLINE-SYNC.md §5/§8.5/§13。
//
// 哲学：真临时库 + 真迁移 + 真业务写造 outbox（不 mock DB，不碰 dev.db）；网络用假 transport
// （不起第二进程/HTTP server）。fetch 传输实现用桩 globalThis.fetch 验证信封/协议门/令牌头。
//
// ⚠ 加载顺序：本文件顶层【绝不静态 import db.ts 依赖链】（replicaPush→navRegistry→领域 Tx→db.ts 会在
// setupOrgHarness 注入临时 DATABASE_URL 前实例化单例 PrismaClient，误连 dev.db）。运行时一律在
// setupOrgHarness() 之后经动态 import() 取命名空间 mod；类型用 import type（编译期擦除、无运行时副作用）。
//
// 覆盖：
//   A. 纯适配 record：create→fields(after)、update→patch+changed{from,to}、delete/restore 只带 tableId、
//      坏 changes/坏 JSON/未知 op → ok:false；结构/树直通（含权威 handler 消费锚点）。
//   B. 编排 on：真造 record outbox → 假 transport 收到正确分组/顺序/baseVersion 串；DB acked+serverClientOpId。
//   C. 部分接受 accepted/conflict(带 serverVersion)/rejected 三态分别落位。
//   D. quarantined 落位。
//   E. 网络失败：本桶回 pending(attempts=1,lastError)、后续树桶不发送保持 pending；恢复后全部 acked（不丢不重）。
//   F. off 态：空 summary、假 transport 零调用、DB 无写。
//   G. fetch 传输：URL/头/body.protocolVersion=1/result 信封；非 2xx → ReplicaTransportError。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import type {
  ReplicaPushTransport, WirePushOp, WirePushResult, OutboxAdapterRow,
} from "../replicaPush.js";

// 运行时命名空间：setupOrgHarness 之后动态加载（见文件头加载顺序说明）。
type PushMod = typeof import("../replicaPush.js");
let mod: PushMod;

let h: OrgHarness;
const OWNER = "s3a_owner";
let baseId = "";
let tableId = "";
let pf = "";

const ENV_KEYS = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID", "GX_OFFLINE_CLIENT_ID"] as const;
type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;
function snapshotEnv(): EnvSnapshot {
  const s = {} as EnvSnapshot;
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
async function withReplicaOn<T>(fn: () => Promise<T>): Promise<T> {
  const prev = snapshotEnv();
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = "n1";
  process.env.GX_OFFLINE_CLIENT_ID = "c1";
  try { return await fn(); } finally { restoreEnv(prev); }
}

// ── 假 transport：记录调用、按可编程响应器回执 ──
interface BaseCall { kind: "base"; baseId: string; ops: WirePushOp[]; clientId: string }
interface TreeCall { kind: "tree"; ops: WirePushOp[]; clientId: string }
type Call = BaseCall | TreeCall;
const isThrow = (r: unknown): r is { throw: Error } =>
  typeof r === "object" && r !== null && "throw" in r;

class FakeTransport implements ReplicaPushTransport {
  calls: Call[] = [];
  constructor(private readonly responder: (call: Call) => WirePushResult[] | { throw: Error }) {}
  async pushBase(baseId: string, ops: WirePushOp[], clientId: string) {
    const call: BaseCall = { kind: "base", baseId, ops, clientId };
    this.calls.push(call);
    const r = this.responder(call);
    if (!isThrow(r)) return { baseId, results: r };
    throw r.throw;
  }
  async pushTree(ops: WirePushOp[], clientId: string) {
    const call: TreeCall = { kind: "tree", ops, clientId };
    this.calls.push(call);
    const r = this.responder(call);
    if (!isThrow(r)) return { scope: "workspace_tree" as const, results: r };
    throw r.throw;
  }
}
const acceptAll = (call: Call): WirePushResult[] =>
  call.ops.map((o) => ({ clientOpId: o.clientOpId, status: "accepted" as const, seq: "1", newVersion: o.baseVersion }));

function mkRow(partial: Partial<OutboxAdapterRow> & Pick<OutboxAdapterRow, "clientOpId" | "entityType" | "op">): OutboxAdapterRow {
  return { baseId: "b1", entityId: "e1", payload: "{}", baseVersion: 0n, ...partial };
}

beforeAll(async () => {
  h = await setupOrgHarness();
  // 临时库就位后再加载 db.ts 依赖链。
  mod = await import("../replicaPush.js");
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
  const { createBase } = await import("../../libraryService.js");
  const { createTable } = await import("../../tableService.js");
  const base = await createBase({ name: "s3a", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "dep" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.cleanup();
});

async function loadFields() {
  const { loadTableFields } = await import("../../recordService.js");
  return loadTableFields(tableId);
}
async function onlineCreate(recordId: string, value: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { createRecordTx } = await import("../../recordWrite.js");
  const fields = await loadFields();
  return withWriteTx("s3a.create", (tx) =>
    createRecordTx(tx, { tableId, recordId, payloadFields: { [pf]: value }, fields, userId: OWNER, isDraft: false }));
}
async function onlineUpdate(recordId: string, value: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { updateRecordTx } = await import("../../recordWrite.js");
  const fields = await loadFields();
  return withWriteTx("s3a.update", (tx) =>
    updateRecordTx(tx, { tableId, recordId, patch: { [pf]: value }, fields, userId: OWNER }));
}
async function onlineDelete(recordId: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { softDeleteRecordTx } = await import("../../recordWrite.js");
  return withWriteTx("s3a.del", (tx) => softDeleteRecordTx(tx, recordId, OWNER));
}

// ───────────────────────── A. 纯适配 ─────────────────────────

describe("纯适配 localOutboxRowToWireOp：record", () => {
  it("create：changes→fields 取 after，op 保留 create，baseVersion 串", () => {
    const r = mod.localOutboxRowToWireOp(mkRow({
      clientOpId: "local-1", entityType: "record", entityId: "rec1", op: "create", baseVersion: 0n,
      payload: JSON.stringify({ op: "create", entityType: "record", tableId: "t1",
        changes: [{ fieldId: "f1", fieldName: "F1", before: null, after: "v1" }] }),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op.op).toBe("create");
    expect(r.op.baseVersion).toBe("0");
    expect(r.op.payload).toMatchObject({ tableId: "t1", fields: { f1: "v1" } });
  });

  it("update：op 改名 patch，changes→changed{fid:{from,to}}", () => {
    const r = mod.localOutboxRowToWireOp(mkRow({
      clientOpId: "local-2", entityType: "record", entityId: "rec1", op: "update", baseVersion: 1n,
      payload: JSON.stringify({ tableId: "t1", changes: [{ fieldId: "f1", fieldName: "F1", before: "a", after: "b" }] }),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op.op).toBe("patch");
    expect(r.op.baseVersion).toBe("1");
    expect(r.op.payload).toMatchObject({ tableId: "t1", changed: { f1: { from: "a", to: "b" } } });
  });

  it("delete/restore：op 保留，payload 只带 tableId（空 changes）", () => {
    for (const op of ["delete", "restore"] as const) {
      const r = mod.localOutboxRowToWireOp(mkRow({
        clientOpId: `local-${op}`, entityType: "record", entityId: "rec1", op, baseVersion: 3n,
        payload: JSON.stringify({ tableId: "t1", changes: [] }),
      }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.op.op).toBe(op);
      expect(r.op.payload).toEqual({ tableId: "t1" });
    }
  });

  it("坏 changes（非数组）/ 坏 JSON / 未知 op → ok:false 且带原因", () => {
    const badChanges = mod.localOutboxRowToWireOp(mkRow({
      clientOpId: "x1", entityType: "record", op: "update",
      payload: JSON.stringify({ tableId: "t1", changes: { not: "array" } }),
    }));
    expect(badChanges.ok).toBe(false);
    if (badChanges.ok) throw new Error("应失败");
    expect(badChanges.reason).toBe("BAD_RECORD_CHANGES");

    const badJson = mod.localOutboxRowToWireOp(mkRow({ clientOpId: "x2", entityType: "record", op: "update", payload: "{not json" }));
    expect(badJson.ok).toBe(false);
    if (badJson.ok) throw new Error("应失败");
    expect(badJson.reason).toBe("BAD_JSON");

    const badOp = mod.localOutboxRowToWireOp(mkRow({
      clientOpId: "x3", entityType: "record", op: "upsert",
      payload: JSON.stringify({ tableId: "t1", changes: [] }),
    }));
    expect(badOp.ok).toBe(false);
    if (badOp.ok) throw new Error("应失败");
    expect(badOp.reason).toBe("UNSUPPORTED_RECORD_OP");
  });
});

// ───────────────── B. 编排：on 真造 outbox → 排空 acked ─────────────────

describe("编排：on 态真业务写造 record outbox → 假 transport 排空", () => {
  it("收到正确 base 分组/顺序/baseVersion 串；DB 行 acked 且落 serverClientOpId", () =>
    withReplicaOn(async () => {
      await onlineCreate("rec_s3a_happy", "hello");
      const before = await h.prisma.localOutbox.findMany({
        where: { entityId: "rec_s3a_happy" }, orderBy: { createdAt: "asc" },
      });
      expect(before).toHaveLength(1);
      expect(before[0]!.status).toBe("pending");

      const fake = new FakeTransport(acceptAll);
      const summary = await mod.pushOutboxOnce({ transport: fake });
      expect(summary.ran).toBe(true);
      expect(summary.transportError).toBe(false);
      expect(summary.hasRemaining).toBe(false);
      expect(summary.totals.acked).toBeGreaterThanOrEqual(1);

      const baseCalls = fake.calls.filter((c): c is BaseCall => c.kind === "base");
      const mine = baseCalls.flatMap((c) => c.ops.map((o) => ({ c, o })))
        .find((x) => x.o.entityId === "rec_s3a_happy");
      expect(mine).toBeTruthy();
      expect(mine!.c.baseId).toBe(baseId);
      expect(mine!.c.clientId).toBe("c1");
      expect(mine!.o.op).toBe("create");
      expect(mine!.o.baseVersion).toBe("0");
      expect(mine!.o.payload).toMatchObject({ tableId, fields: { [pf]: "hello" } });

      const after = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: before[0]!.clientOpId } });
      expect(after.status).toBe("acked");
      expect(after.serverClientOpId).toBe(after.clientOpId);
      expect(after.attempts).toBe(1);
    }));
});

// ───────────────── C. 部分接受 accepted/conflict/rejected ─────────────────

describe("编排：部分接受三态落位", () => {
  it("第1 accepted、第2 conflict(带 serverVersion)、第3 rejected，DB 分别落位", () =>
    withReplicaOn(async () => {
      const rid = "rec_s3a_partial";
      await onlineCreate(rid, "v0");
      await onlineUpdate(rid, "v1");
      await onlineDelete(rid);
      const rows = await h.prisma.localOutbox.findMany({
        where: { entityId: rid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(rows).toHaveLength(3);
      const [c, u, d] = rows.map((r) => r.clientOpId);

      const responder = (call: Call): WirePushResult[] =>
        call.ops.map((o) => {
          if (o.clientOpId === c) return { clientOpId: o.clientOpId, status: "accepted", seq: "10", newVersion: "1" };
          if (o.clientOpId === u) {
            return { clientOpId: o.clientOpId, status: "conflict", reasonCode: "SYNC_VERSION_CONFLICT", serverVersion: "7" };
          }
          return { clientOpId: o.clientOpId, status: "rejected", reasonCode: "SYNC_PERMISSION_REVOKED" };
        });
      const summary = await mod.pushOutboxOnce({ transport: new FakeTransport(responder) });
      expect(summary.transportError).toBe(false);

      const rc = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: c! } });
      const ru = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: u! } });
      const rd = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: d! } });
      expect(rc.status).toBe("acked");
      expect(ru.status).toBe("conflict");
      expect(ru.reasonCode).toBe("SYNC_VERSION_CONFLICT");
      expect(ru.conflictPayload).toBeTruthy();
      expect(JSON.parse(ru.conflictPayload!).serverVersion).toBe("7");
      expect(rd.status).toBe("rejected");
      expect(rd.reasonCode).toBe("SYNC_PERMISSION_REVOKED");
    }));
});

// ───────────────── D. quarantined ─────────────────

describe("编排：quarantined 落位", () => {
  it("回执 quarantined → 本地落 quarantined 终态", () =>
    withReplicaOn(async () => {
      const rid = "rec_s3a_q";
      await onlineCreate(rid, "q");
      const [r0] = await h.prisma.localOutbox.findMany({ where: { entityId: rid } });
      const fake = new FakeTransport((call) =>
        call.ops.map((o) => ({ clientOpId: o.clientOpId, status: "quarantined" as const, reasonCode: "SYNC_QUARANTINED" })));
      await mod.pushOutboxOnce({ transport: fake });
      const after = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: r0!.clientOpId } });
      expect(after.status).toBe("quarantined");
      expect(after.reasonCode).toBe("SYNC_QUARANTINED");
    }));
});

// ───────────────── E. 网络失败回 pending + 恢复排空 ─────────────────

describe("编排：网络失败不丢不重 + 恢复排空", () => {
  it("base 桶抛错回 pending(attempts=1,lastError)、树桶保持 pending 未发送；恢复后全部 acked", () =>
    withReplicaOn(async () => {
      const { withWriteTx } = await import("../../../db.js");
      const { recordLocalTreeReplicaTx } = await import("../localOutbox.js");
      const { createGroupTx } = await import("../../nav/groups.js");

      const rid = "rec_s3a_net";
      await onlineCreate(rid, "n");
      let treeOpId = "";
      await withWriteTx("s3a.treeRow", async (tx) => {
        const gid = await createGroupTx(tx, { name: "G-net" });
        const rec = await recordLocalTreeReplicaTx(
          tx,
          { entityType: "navnode", entityId: gid, op: "nav_create_group", actorId: OWNER, payload: { name: "G-net", parentId: null } },
          { nodeId: "n1", clientId: "c1" },
        );
        treeOpId = rec!.clientOpId;
      });

      const [recRow0] = await h.prisma.localOutbox.findMany({ where: { entityId: rid } });
      const failing = new FakeTransport((call) =>
        call.kind === "base" ? { throw: new mod.ReplicaTransportError("ECONNREFUSED") } : acceptAll(call));
      const s1 = await mod.pushOutboxOnce({ transport: failing });
      expect(s1.transportError).toBe(true);
      expect(s1.hasRemaining).toBe(true);

      const recAfter = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: recRow0!.clientOpId } });
      expect(recAfter.status).toBe("pending");
      expect(recAfter.attempts).toBe(1);
      expect(recAfter.lastError).toContain("ECONNREFUSED");
      const treeAfter = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: treeOpId } });
      expect(treeAfter.status).toBe("pending");
      expect(treeAfter.attempts).toBe(0);
      expect(failing.calls.filter((c) => c.kind === "tree")).toHaveLength(0);

      const recovered = new FakeTransport(acceptAll);
      const s2 = await mod.pushOutboxOnce({ transport: recovered });
      expect(s2.transportError).toBe(false);
      expect(s2.hasRemaining).toBe(false);
      const recFinal = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: recRow0!.clientOpId } });
      const treeFinal = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: treeOpId } });
      expect(recFinal.status).toBe("acked");
      expect(treeFinal.status).toBe("acked");
      const baseSends = recovered.calls.filter((c): c is BaseCall => c.kind === "base")
        .flatMap((c) => c.ops).filter((o) => o.clientOpId === recRow0!.clientOpId);
      expect(baseSends).toHaveLength(1);
    }));
});

// ───────────────── F. off 态零行为 ─────────────────

describe("默认关：pushOutboxOnce 零查询零写", () => {
  it("GX_OFFLINE_REPLICA 未设：空 summary(ran=false)、transport 零调用、pending 行原封不动", async () => {
    await withReplicaOn(() => onlineCreate("rec_s3a_off_pump", "x"));
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const fake = new FakeTransport(acceptAll);
      const before = await h.prisma.localOutbox.count({ where: { status: "pending" } });
      const summary = await mod.pushOutboxOnce({ transport: fake });
      const after = await h.prisma.localOutbox.count({ where: { status: "pending" } });
      expect(summary.ran).toBe(false);
      expect(summary.buckets).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
      expect(after).toBe(before);
    } finally {
      restoreEnv(prev);
    }
  });
});

// ─────────── A2. 结构/树直通 + 权威 handler 消费锚点（防「想当然直通」） ───────────

describe("结构/树适配直通：wire payload 可被权威注册表 handler 直接消费", () => {
  it("create_table：适配出的 payload 喂给 structureRegistry handler.resolve/apply 成功建表", () =>
    withReplicaOn(async () => {
      const { withWriteTx } = await import("../../../db.js");
      const { recordLocalStructureReplicaTx } = await import("../localOutbox.js");
      const { getStructureOpHandler } = await import("../structureRegistry.js");

      const newTableId = "tbl_s3a_anchor";
      await withWriteTx("s3a.structRow", (tx) =>
        recordLocalStructureReplicaTx(
          tx,
          { entityType: "table", entityId: newTableId, tableId: newTableId, baseId,
            op: "create_table", actorId: OWNER, payload: { name: "锚点表", withDefaults: false } },
          { nodeId: "n1", clientId: "c1" },
        ));
      const ob = await h.prisma.localOutbox.findFirstOrThrow({ where: { entityId: newTableId } });
      const adapted = mod.localOutboxRowToWireOp(ob);
      expect(adapted.ok).toBe(true);
      if (!adapted.ok) return;
      expect(adapted.op.op).toBe("create_table");
      expect(adapted.op.payload["name"]).toBe("锚点表");
      expect(adapted.op.payload["withDefaults"]).toBe(false);

      const handler = getStructureOpHandler("table", "create_table");
      expect(handler).toBeTruthy();
      if (!handler) return;
      const incoming = {
        clientOpId: ob.clientOpId, entityType: "table", entityId: newTableId,
        op: "create_table", baseVersion: BigInt(adapted.op.baseVersion), payload: adapted.op.payload,
      };
      await withWriteTx("s3a.structConsume", async (tx) => {
        const resolution = await handler.resolve(tx, baseId, incoming);
        expect(resolution.tableId).toBe(newTableId);
        const outcome = await handler.apply(tx, OWNER, baseId, incoming);
        expect(outcome.tableId).toBe(newTableId);
      });
      const created = await h.prisma.table.findUniqueOrThrow({ where: { id: newTableId } });
      expect(created.name).toBe("锚点表");
    }));

  it("nav_create_group：适配出的 payload 通过 navRegistry handler.assertTx 校验（业务键齐全）", () =>
    withReplicaOn(async () => {
      const { withWriteTx } = await import("../../../db.js");
      const { recordLocalTreeReplicaTx } = await import("../localOutbox.js");
      const { createGroupTx } = await import("../../nav/groups.js");
      const { getTreeOpHandler } = await import("../navRegistry.js");

      let opId = "";
      let gid = "";
      await withWriteTx("s3a.treeRowAnchor", async (tx) => {
        gid = await createGroupTx(tx, { name: "锚点组" });
        const rec = await recordLocalTreeReplicaTx(
          tx,
          { entityType: "navnode", entityId: gid, op: "nav_create_group", actorId: OWNER,
            payload: { name: "锚点组", parentId: null, ord: 3 } },
          { nodeId: "n1", clientId: "c1" },
        );
        opId = rec!.clientOpId;
      });
      const ob = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: opId } });
      expect(ob.baseId).toBe(null);
      const adapted = mod.localOutboxRowToWireOp(ob);
      expect(adapted.ok).toBe(true);
      if (!adapted.ok) return;
      expect(adapted.op.op).toBe("nav_create_group");
      expect(adapted.op.payload).toMatchObject({ name: "锚点组", parentId: null, ord: 3 });

      const handler = getTreeOpHandler("navnode", "nav_create_group");
      expect(handler).toBeTruthy();
      if (!handler) return;
      await withWriteTx("s3a.treeConsume", (tx) =>
        handler.assertTx(tx, {
          clientOpId: opId, entityType: "navnode", entityId: gid,
          op: "nav_create_group", baseVersion: BigInt(adapted.op.baseVersion), payload: adapted.op.payload,
        }));
    }));
});

// ───────────────── G. fetch 传输：信封/协议门/令牌头/错误归一 ─────────────────

describe("createFetchPushTransport", () => {
  it("POST /push 带 X-GX-Token 与 protocolVersion=1，解析 result 信封", async () => {
    const origFetch = globalThis.fetch;
    let captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({
        result: { baseId: "b1", results: [{ clientOpId: "local-1", status: "accepted", seq: "1", newVersion: "1" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const t = mod.createFetchPushTransport({ baseUrl: "http://127.0.0.1:9999/", token: "tok-abc" });
      const resp = await t.pushBase("b1", [{
        clientOpId: "local-1", entityType: "record", entityId: "e1", op: "create", baseVersion: "0",
        payload: { tableId: "t1", fields: {} },
      }], "c1");
      expect(captured.url).toBe("http://127.0.0.1:9999/api/v1/sync/push");
      const headers = captured.init!.headers as Record<string, string>;
      expect(headers["X-GX-Token"]).toBe("tok-abc");
      const body = JSON.parse(captured.init!.body as string);
      expect(body.protocolVersion).toBe(1);
      expect(body.baseId).toBe("b1");
      expect(body.clientId).toBe("c1");
      expect(resp.results[0]!.status).toBe("accepted");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("非 2xx → ReplicaTransportError", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    try {
      const t = mod.createFetchPushTransport({ baseUrl: "http://127.0.0.1:9999", token: "t" });
      await expect(t.pushTree([], "c1")).rejects.toBeInstanceOf(mod.ReplicaTransportError);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

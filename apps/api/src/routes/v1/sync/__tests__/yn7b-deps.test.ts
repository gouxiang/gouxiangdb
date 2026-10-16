// YN7#788-A 数据 op 的结构依赖门（§19.2 baseSchemaVersion / §19.3 场景 4 父表软删）契约测试。
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock。）
// 设计权威：DESIGN-OFFLINE-SYNC §19.2、§19.3-4、§20.5（additive/默认零行为）。
//
// 验收映射：
//   A record op 携带 baseSchemaVersion 且落后 → conflict=SYNC_STRUCTURE_DEPENDENCY_CONFLICT，
//     主数据不动、incoming 落 conflict，serverVersion=当前结构版本。
//   B baseSchemaVersion 与当前一致 → 正常 accepted（结构对齐放行）。
//   C 不携带 baseSchemaVersion（旧客户端）→ 结构版本门不启用，即便结构已前进仍按记录版本正常回放
//     （additive、默认零行为变化的硬保证）。
//   D baseSchemaVersion 超前（结构 op 尚未被服务端接受）→ 同样挂起 STRUCTURE_DEPENDENCY。
//   E 父表被（对方）软删 → 数据 op（含无结构版本者）→ conflict=SYNC_TABLE_DELETED（§19.3-4）。
//   F 坏信封：baseSchemaVersion 非数字串 → 整单 400。
//   G 幂等：同 clientOpId 的依赖冲突重放回同一回执、不重复落终态。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn7b_owner";
const CLIENT = "yn7b-client";

let baseId = "";
let tableId = "";
let pf = "";
let pushSeq = 0;
function cid(prefix: string): string {
  pushSeq += 1;
  return `${prefix}-${pushSeq}`;
}

interface OpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined";
  reasonCode?: string;
  reasonDetail?: string;
  newVersion?: string;
  entityId?: string;
  serverVersion?: string;
}

/** 构造一条 record op，baseSchemaVersion 缺省=不携带（模拟旧客户端）。 */
function rop(
  clientOpId: string,
  op: "create" | "patch" | "delete" | "restore",
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
  baseSchemaVersion?: string,
) {
  return {
    clientOpId, entityType: "record", entityId, op, baseVersion, payload,
    ...(baseSchemaVersion !== undefined ? { baseSchemaVersion } : {}),
  };
}

async function pushRaw(ops: unknown[]): Promise<{ status: number; code?: string; results?: OpResult[] }> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ baseId, clientId: CLIENT, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code, results: body.result?.results };
}

async function schemaVersion(): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: `table_schema:${tableId}` },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const base = await createBase({ name: "yn7b", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "dep" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;

  const sub = await h.app.request("/api/v1/sync/subscribe", {
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

describe("A/B/C/D. 数据 op 的结构版本依赖门", () => {
  const REC = "rec_yn7b_dep";

  it("准备：带当前结构版本的 create accepted，记录版本=1", async () => {
    const v0 = await schemaVersion();
    expect(v0).toBe(1n); // 在线建表已推进一次结构钟
    const r = await pushRaw([rop(cid("c"), "create", REC, "0", { tableId, fields: { [pf]: "原值" } }, v0.toString())]);
    expect(r.status).toBe(200);
    expect(r.results![0]!.status).toBe("accepted");
    expect(r.results![0]!.newVersion).toBe("1");
  });

  it("A 在线加字段推进结构钟后，离线 patch 带旧 baseSchemaVersion → conflict=STRUCTURE_DEPENDENCY，主数据不动", async () => {
    const before = await schemaVersion();
    const { createField } = await import("../../../../domain/fieldService.js");
    await createField({ tableId, name: "在线新字段", type: "text" }, OWNER);
    const after = await schemaVersion();
    expect(after).toBe(before + 1n);

    const opId = cid("patch-stale");
    const r = await pushRaw([
      rop(opId, "patch", REC, "1", { tableId, changed: { [pf]: { from: "原值", to: "离线改" } } }, before.toString()),
    ]);
    expect(r.results![0]!.status).toBe("conflict");
    expect(r.results![0]!.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");
    expect(r.results![0]!.serverVersion).toBe(after.toString());

    // 主数据未被改动；incoming 落 conflict 挂起。
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: REC } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("原值");
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: opId } });
    expect(inc.status).toBe("conflict");
    expect(inc.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");
    expect(inc.op).toBe("patch");
  });

  it("B 同一 patch 改用当前结构版本（且记录版本仍=1）→ accepted，按最新结构重放", async () => {
    const cur = await schemaVersion();
    const r = await pushRaw([
      rop(cid("patch-ok"), "patch", REC, "1", { tableId, changed: { [pf]: { from: "原值", to: "对齐后改" } } }, cur.toString()),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: REC } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("对齐后改");
  });

  it("C 旧客户端（不带 baseSchemaVersion）：结构已前进也不受结构门，按记录版本正常回放", async () => {
    // 记录当前版本=2（上一条 patch）。不带结构版本字段，即便结构钟领先也应放行（零行为变化）。
    const r = await pushRaw([
      rop(cid("patch-legacy"), "patch", REC, "2", { tableId, changed: { [pf]: { from: "对齐后改", to: "旧客户端改" } } }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: REC } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("旧客户端改");
  });

  it("D baseSchemaVersion 超前（服务端尚未接受对应结构 op）→ conflict=STRUCTURE_DEPENDENCY", async () => {
    const cur = await schemaVersion();
    const r = await pushRaw([
      rop(cid("patch-ahead"), "patch", REC, "3", { tableId, changed: { [pf]: { from: "旧客户端改", to: "超前" } } }, (cur + 5n).toString()),
    ]);
    expect(r.results![0]!.status).toBe("conflict");
    expect(r.results![0]!.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");
    expect(r.results![0]!.serverVersion).toBe(cur.toString());
  });
});

describe("E. 父表软删（§19.3 场景 4）", () => {
  it("整表被软删后，挂在其上的 record patch（带结构版本）→ conflict=TABLE_DELETED", async () => {
    const delTableId = `tbl_yn7b_del_${pushSeq}`;
    // 用结构 op 离线建一张表（独立结构钟），再在其上建记录。
    const createTableOp = {
      clientOpId: cid("ct-del"), entityType: "table", entityId: delTableId, op: "create_table",
      baseVersion: "0", payload: { name: "将删表", withDefaults: true },
    };
    const r0 = await pushRaw([createTableOp]);
    expect(r0.results![0]!.status).toBe("accepted");
    const livePf = await h.prisma.field.findFirstOrThrow({
      where: { tableId: delTableId, deletedAt: null, name: "名称" }, select: { id: true },
    });
    const recId = `rec_yn7b_del_${pushSeq}`;
    const r1 = await pushRaw([
      rop(cid("c-del-rec"), "create", recId, "0", { tableId: delTableId, fields: { [livePf.id]: "x" } }, "1"),
    ]);
    expect(r1.results![0]!.status).toBe("accepted");

    // 对方软删整表（领域原语：表/字段/记录级联墓碑）。
    const { withWriteTx } = await import("../../../../db.js");
    const { softDeleteTableTx } = await import("../../../../domain/tableServiceTx.js");
    await withWriteTx("test.softDeleteTable", (tx) => softDeleteTableTx(tx, delTableId, OWNER));

    const opId = cid("patch-deleted-table");
    const r2 = await pushRaw([
      rop(opId, "patch", recId, "1", { tableId: delTableId, changed: { [livePf.id]: { from: "x", to: "y" } } }, "1"),
    ]);
    expect(r2.results![0]!.status).toBe("conflict");
    expect(r2.results![0]!.reasonCode).toBe("SYNC_TABLE_DELETED");
    // 即便旧客户端不带结构版本，也应被父表软删拦下（不悄悄当幂等成功丢弃）。
    const opId2 = cid("patch-deleted-table-legacy");
    const r3 = await pushRaw([
      rop(opId2, "delete", recId, "1", { tableId: delTableId }),
    ]);
    expect(r3.results![0]!.status).toBe("conflict");
    expect(r3.results![0]!.reasonCode).toBe("SYNC_TABLE_DELETED");
  });
});

describe("F/G. 信封与幂等", () => {
  it("F baseSchemaVersion 非数字串 → 整单 400 SYNC_BAD_CURSOR", async () => {
    const r = await pushRaw([
      {
        clientOpId: cid("bad-sv"), entityType: "record", entityId: "rec_x", op: "patch",
        baseVersion: "0", baseSchemaVersion: "abc", payload: {},
      },
    ]);
    expect(r.status).toBe(400);
  });

  it("G 依赖冲突同 clientOpId 重放回同一 conflict 回执，不重复落终态", async () => {
    const t2 = `tbl_yn7b_idem_${pushSeq}`;
    const r0 = await pushRaw([{
      clientOpId: cid("ct-idem"), entityType: "table", entityId: t2, op: "create_table",
      baseVersion: "0", payload: { name: "幂等表" },
    }]);
    expect(r0.results![0]!.status).toBe("accepted");
    // 在线推进一次结构钟。
    const { createField } = await import("../../../../domain/fieldService.js");
    await createField({ tableId: t2, name: "f", type: "text" }, OWNER);
    const cur = await h.prisma.syncEntityVersion.findUniqueOrThrow({
      where: { id: `table_schema:${t2}` }, select: { version: true },
    });

    const recId = `rec_yn7b_idem_${pushSeq}`;
    const opId = cid("create-stale-idem");
    const payload = { tableId: t2, fields: {} };
    const op = () => rop(opId, "create", recId, "0", payload, "1");
    const r1 = await pushRaw([op()]);
    expect(r1.results![0]!.status).toBe("conflict");
    expect(r1.results![0]!.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");
    expect(r1.results![0]!.serverVersion).toBe(cur.version.toString());
    const r2 = await pushRaw([op()]);
    expect(r2.results![0]).toMatchObject({
      clientOpId: opId, status: "conflict", reasonCode: "SYNC_STRUCTURE_DEPENDENCY_CONFLICT",
    });
    expect(r2.results![0]!.serverVersion).toBe(cur.version.toString());
    expect(await h.prisma.syncIncoming.count({ where: { clientOpId: opId } })).toBe(1);
    expect(await h.prisma.record.count({ where: { id: recId } })).toBe(0);
  });
});

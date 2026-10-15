// YN1 在线写版本切面 + oplog 契约测试（真 HTTP records 路由 + 真迁移临时库，不 mock 同步层）。
// 设计权威：DESIGN-OFFLINE-SYNC §5.1/§6.4/§8.5/§8.6/§11/§15.2。
//
// 验收（§15.2 YN1）：
//   - 开关 on：在线 create/update/softDelete（含批量路径）都在同事务推进 sync_entity_versions
//     （连续 version、墓碑正确）并追加 sync_op_log（全局连续 seq、clientOpId 唯一、payload 带字段 diff）；
//   - 开关 off（出厂默认）：同样的在线写不产生任何 sync_* 写（零额外 IO、旧行为逐字节不变）。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

// 固定身份 owner（与 _realApp 夹具约定一致，必须在顶部 hoist）。
vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let tableId: string;
let primaryFieldId: string;

function setSync(on: boolean): void {
  if (on) process.env.GX_SYNC_SERVER = "on";
  else delete process.env.GX_SYNC_SERVER;
}

beforeAll(async () => {
  h = await setupHarness("gx-yn1-oplog-");
  setSync(false);
  const baseId = await h.makeBase();
  const t = await h.makeTable(baseId, "yn1");
  tableId = t.id;
  primaryFieldId = t.primaryFieldId;
}, 120_000);

afterAll(async () => {
  setSync(false);
  await h.teardown();
});

beforeEach(async () => {
  await h.prisma.syncOpLog.deleteMany({});
  await h.prisma.syncEntityVersion.deleteMany({});
  await h.prisma.linkRow.deleteMany({});
  await h.prisma.record.deleteMany({});
});

/** 建一条记录，返回其 id（POST 201 返回 {record:{id}}）。 */
async function createRecord(value?: string): Promise<string> {
  const fields = value === undefined ? {} : { [primaryFieldId]: value };
  const res = await h.request("POST", `/records?tableId=${tableId}`, { fields });
  expect(res.status).toBe(201);
  const body = await res.json();
  const id = body?.record?.id ?? body?.id;
  if (typeof id !== "string") throw new Error(`create 未返回 id：${JSON.stringify(body).slice(0, 200)}`);
  return id;
}

describe("YN1 开关 off（出厂默认）：在线写零同步写", () => {
  it("create → update → softDelete 后 sync_op_log / sync_entity_versions 恒空", async () => {
    setSync(false);
    const id = await createRecord("离线默认");
    await h.request("PATCH", `/records/${id}`, { fields: { [primaryFieldId]: "改了" } });
    await h.request("DELETE", `/records/${id}`);

    expect(await h.prisma.syncOpLog.count()).toBe(0);
    expect(await h.prisma.syncEntityVersion.count()).toBe(0);
  });
});

describe("YN1 开关 on：在线写产生连续 seq/version", () => {
  it("create/update/softDelete 推进版本；seq 全局连续、version 每实体连续、墓碑正确", async () => {
    setSync(true);
    const id = await createRecord("第一条");

    // create：version 1 / seq 1
    let v = await h.prisma.syncEntityVersion.findUnique({ where: { id } });
    expect(v).not.toBeNull();
    expect(v!.version).toBe(BigInt(1));
    expect(v!.lastSeq).toBe(BigInt(1));
    expect(v!.isDeleted).toBe(false);
    expect(v!.entityType).toBe("record");
    expect(typeof v!.baseId).toBe("string");

    let ops = await h.prisma.syncOpLog.findMany({ orderBy: { seq: "asc" } });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.seq).toBe(BigInt(1));
    expect(ops[0]!.op).toBe("create");
    expect(ops[0]!.entityId).toBe(id);
    expect(ops[0]!.newVersion).toBe(BigInt(1));
    expect(ops[0]!.baseVersion).toBe(BigInt(0));
    expect(ops[0]!.clientId).toBe("__server__");
    expect(ops[0]!.actorId).toBe(OWNER_ID);
    expect(ops[0]!.clientOpId.startsWith("srv-")).toBe(true);
    const createPayload = JSON.parse(ops[0]!.payload) as {
      op: string; tableId: string; changes: Array<{ after: unknown }>;
    };
    expect(createPayload.op).toBe("create");
    expect(createPayload.tableId).toBe(tableId);
    expect(createPayload.changes[0]?.after).toBe("第一条");

    // update：version 2 / seq 2，payload 仅带被改字段（含 before/after）
    const upd = await h.request("PATCH", `/records/${id}`, { fields: { [primaryFieldId]: "第二条" } });
    expect(upd.status).toBe(200);
    v = await h.prisma.syncEntityVersion.findUnique({ where: { id } });
    expect(v!.version).toBe(BigInt(2));
    expect(v!.lastSeq).toBe(BigInt(2));
    ops = await h.prisma.syncOpLog.findMany({ orderBy: { seq: "asc" } });
    expect(ops).toHaveLength(2);
    expect(ops[1]!.seq).toBe(BigInt(2));
    expect(ops[1]!.op).toBe("update");
    expect(ops[1]!.baseVersion).toBe(BigInt(1));
    expect(ops[1]!.newVersion).toBe(BigInt(2));
    const updPayload = JSON.parse(ops[1]!.payload) as {
      changes: Array<{ before: unknown; after: unknown }>;
    };
    expect(updPayload.changes[0]?.before).toBe("第一条");
    expect(updPayload.changes[0]?.after).toBe("第二条");

    // softDelete：version 3 / seq 3，置墓碑
    const del = await h.request("DELETE", `/records/${id}`);
    expect(del.status).toBe(200);
    v = await h.prisma.syncEntityVersion.findUnique({ where: { id } });
    expect(v!.version).toBe(BigInt(3));
    expect(v!.isDeleted).toBe(true);
    expect(v!.deletedBy).toBe(OWNER_ID);
    ops = await h.prisma.syncOpLog.findMany({ orderBy: { seq: "asc" } });
    expect(ops.map((o) => o.seq)).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
    expect(ops[2]!.op).toBe("delete");
    expect(ops[2]!.newVersion).toBe(BigInt(3));
    // clientOpId 全局唯一
    expect(new Set(ops.map((o) => o.clientOpId)).size).toBe(3);
  });

  it("多条记录的 seq 全局单调（不在同实体上各自从 1 起）", async () => {
    setSync(true);
    const a = await createRecord("A");
    const b = await createRecord("B");
    const ops = await h.prisma.syncOpLog.findMany({ orderBy: { seq: "asc" } });
    expect(ops.map((o) => [o.entityId, o.seq.toString()])).toEqual([
      [a, "1"],
      [b, "2"],
    ]);
    const va = await h.prisma.syncEntityVersion.findUnique({ where: { id: a } });
    const vb = await h.prisma.syncEntityVersion.findUnique({ where: { id: b } });
    expect(va!.version).toBe(BigInt(1));
    expect(vb!.version).toBe(BigInt(1));
  });

  it("批量软删逐条推进版本并落墓碑（bulk-delete 旁路路径）", async () => {
    setSync(true);
    const a = await createRecord("批删A");
    const b = await createRecord("批删B");
    const res = await h.request("POST", "/records/bulk-delete", { ids: [a, b] });
    expect(res.status).toBe(200);
    const ops = await h.prisma.syncOpLog.findMany({ where: { op: "delete" }, orderBy: { seq: "asc" } });
    expect(ops).toHaveLength(2);
    for (const id of [a, b]) {
      const v = await h.prisma.syncEntityVersion.findUnique({ where: { id } });
      expect(v!.isDeleted).toBe(true);
      expect(v!.version).toBe(BigInt(2)); // create=1, delete=2
    }
  });
});

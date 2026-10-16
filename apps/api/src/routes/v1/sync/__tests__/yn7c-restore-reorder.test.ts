// YN7#788-B 结构 op restore_table / restore_field / reorder_fields 回放 + 在线切面 契约测试。
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock。）
// 设计权威：DESIGN-OFFLINE-SYNC §19.1（词表）、§19.3-4（父表恢复后整体重放）、§19.4（restore/reorder
//   按当前角色判 manage_schema；在线回收站仍走 manage_table，默认权限行为零变化）、§8.6（在线恢复/重排
//   也推进结构版本）、§20.1（注册表分派，引擎无模块特判）、§8.4（保留离线 cuid）。
//
// 验收映射：
//   A restore_table 回放：在线建表+记录→对方软删整表（级联软删字段/记录）→push restore_table accepted，
//     表/字段/记录复活、视图重新可见、结构钟 +1、oplog 落 table:restore_table。
//   B restore_field 回放：软删字段（含 partner 对称软删）→push restore_field accepted，字段复活、结构钟 +1。
//   C reorder_fields 回放：有序 fieldId 列表 accepted，order 按列表重写、结构钟 +1；
//     列表与当前活字段集合不一致（离线期间有增删）→ rejected=MALFORMED，原顺序不动。
//   D 在线切面（§8.6）：在线 restoreTable / restoreField / reorderFields 推进 table_schema 钟 + 落 __server__ oplog。
//   E 当前权限：无 manage_schema 的受限成员推 restore_table → rejected=PERMISSION_REVOKED，表不恢复。
//   F 幂等：同 clientOpId 重放回同一版本，恢复只生效一次。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn7c_owner";
const ED = "yn7c_editor";
const CLIENT = "yn7c-client-owner";
const C_ED = "yn7c-client-ed";

let baseId = "";
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

function sop(
  clientOpId: string,
  entityType: "table" | "field" | "view",
  op: string,
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
) {
  return { clientOpId, entityType, entityId, op, baseVersion, payload };
}

async function auth(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

async function pushAs(user: string, clientId: string, ops: unknown[]): Promise<{ status: number; results?: OpResult[] }> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify({ baseId, clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, results: body.result?.results };
}

async function schemaVersion(tableId: string): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: `table_schema:${tableId}` },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

/** 在线建一张活表（withDefaults：名称/数量/状态/日期/备注 共 5 字段），结构钟自 1 起。 */
async function onlineTable(name: string): Promise<{ tableId: string; primaryFieldId: string }> {
  const { createTable } = await import("../../../../domain/tableService.js");
  const t = await createTable({ baseId, name, withDefaults: true }, OWNER);
  return { tableId: t.tableId, primaryFieldId: t.primaryFieldId };
}

/** 在指定表插一条活记录（走 push record create，带当前结构版本）。 */
async function pushRecord(tableId: string, recId: string, primaryFieldId: string, value: string): Promise<void> {
  const v = await schemaVersion(tableId);
  const r = await pushAs(OWNER, CLIENT, [{
    clientOpId: cid("rec"),
    entityType: "record",
    entityId: recId,
    op: "create",
    baseVersion: "0",
    baseSchemaVersion: v.toString(),
    payload: { tableId, fields: { [primaryFieldId]: value } },
  }]);
  expect(r.status).toBe(200);
  expect(r.results![0]!.status).toBe("accepted");
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(ED);
  await h.grantSystemRole(OWNER, "owner");
  await h.grantSystemRole(ED, "restricted");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const base = await createBase({ name: "yn7c", withStarter: false }, OWNER);
  baseId = base.id;

  // OWNER 订阅；受限成员 ED 在 E 用例配库可见 scope 后再订阅（与 yn7-structure 同序）。
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: await auth(OWNER),
    body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. restore_table 回放", () => {
  it("整表级联软删后 restore_table accepted，表/字段/记录/视图复活且结构钟 +1", async () => {
    const { tableId, primaryFieldId } = await onlineTable("待恢复表");
    await pushRecord(tableId, "rec_yn7c_a", primaryFieldId, "一条数据");

    // 对方软删整表（级联软删字段/记录、视图 order=-1）。
    const { softDeleteTable } = await import("../../../../domain/tableService.js");
    const { withWriteTx } = await import("../../../../db.js");
    const { softDeleteTableTx } = await import("../../../../domain/tableServiceTx.js");
    await withWriteTx("test.softDelete", (tx) => softDeleteTableTx(tx, tableId, OWNER));
    void softDeleteTable;
    const deletedAt = (await h.prisma.table.findUnique({ where: { id: tableId }, select: { deletedAt: true } }))!.deletedAt;
    expect(deletedAt).not.toBeNull();
    expect((await h.prisma.record.findUnique({ where: { id: "rec_yn7c_a" } }))!.deletedAt).not.toBeNull();

    const vBefore = await schemaVersion(tableId);
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("restore_table"), "table", "restore_table", tableId, vBefore.toString(), {}),
    ]);
    expect(r.status).toBe(200);
    const res = r.results![0]!;
    expect(res.status).toBe("accepted");
    expect(res.newVersion).toBe((vBefore + 1n).toString());

    // 表 / 字段 / 记录全部复活。
    const t = await h.prisma.table.findUnique({ where: { id: tableId } });
    expect(t!.deletedAt).toBeNull();
    const liveFields = await h.prisma.field.count({ where: { tableId, deletedAt: null } });
    expect(liveFields).toBe(5);
    const rec = await h.prisma.record.findUnique({ where: { id: "rec_yn7c_a" } });
    expect(rec!.deletedAt).toBeNull();
    // 视图由 order=-1 恢复为可见（无 order=-1 残留）。
    const hiddenViews = await h.prisma.view.count({ where: { tableId, order: -1 } });
    expect(hiddenViews).toBe(0);
    // oplog 落 table:restore_table。
    const log = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "table", entityId: tableId, op: "restore_table" },
    });
    expect(log).not.toBeNull();
  });
});

describe("B. restore_field 回放", () => {
  it("软删字段后 restore_field accepted，字段复活且结构钟 +1", async () => {
    const { tableId } = await onlineTable("字段恢复表");
    const { createField, deleteField } = await import("../../../../domain/fieldService.js");
    const created = await createField({ tableId, name: "待恢复字段", type: "text" }, OWNER);
    const fieldId = created.field.id;
    await deleteField(fieldId, OWNER);
    expect((await h.prisma.field.findUnique({ where: { id: fieldId } }))!.deletedAt).not.toBeNull();

    const vBefore = await schemaVersion(tableId);
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("restore_field"), "field", "restore_field", fieldId, vBefore.toString(), {}),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    expect(r.results![0]!.newVersion).toBe((vBefore + 1n).toString());
    const restored = await h.prisma.field.findUnique({ where: { id: fieldId } });
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.name).toBe("待恢复字段");
    const log = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "field", entityId: fieldId, op: "restore_field" },
    });
    expect(log).not.toBeNull();
  });
});

describe("C. reorder_fields 回放", () => {
  it("有序 fieldId 列表 accepted，order 按列表重写、结构钟 +1", async () => {
    const { tableId } = await onlineTable("重排表");
    const before = await h.prisma.field.findMany({
      where: { tableId, deletedAt: null }, orderBy: { order: "asc" }, select: { id: true },
    });
    const reversed = [...before].reverse().map((x) => x.id);

    const vBefore = await schemaVersion(tableId);
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("reorder"), "field", "reorder_fields", tableId, vBefore.toString(), { tableId, fieldIds: reversed }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    expect(r.results![0]!.newVersion).toBe((vBefore + 1n).toString());

    const after = await h.prisma.field.findMany({
      where: { tableId, deletedAt: null }, orderBy: { order: "asc" }, select: { id: true },
    });
    expect(after.map((x) => x.id)).toEqual(reversed);
  });

  it("列表与当前活字段集合不一致（缺字段）→ rejected=MALFORMED，原顺序不动", async () => {
    const { tableId } = await onlineTable("重排拒绝表");
    const live = await h.prisma.field.findMany({
      where: { tableId, deletedAt: null }, orderBy: { order: "asc" }, select: { id: true },
    });
    const originalOrder = live.map((x) => x.id);
    const missingOne = originalOrder.slice(1); // 故意丢掉第一个字段

    const vBefore = await schemaVersion(tableId);
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("reorder_bad"), "field", "reorder_fields", tableId, vBefore.toString(), { tableId, fieldIds: missingOne }),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_MALFORMED_PAYLOAD");
    const still = await h.prisma.field.findMany({
      where: { tableId, deletedAt: null }, orderBy: { order: "asc" }, select: { id: true },
    });
    expect(still.map((x) => x.id)).toEqual(originalOrder);
    // 被拒不推进结构钟。
    expect(await schemaVersion(tableId)).toBe(vBefore);
  });
});

describe("D. 在线恢复/重排切面（§8.6）", () => {
  it("在线 restoreTable / restoreField / reorderFields 推进结构钟并落 __server__ oplog", async () => {
    const { tableId } = await onlineTable("在线切面表");
    const { createField, deleteField, restoreField, reorderFields } = await import("../../../../domain/fieldService.js");
    const { restoreTable } = await import("../../../../domain/tableService.js");
    const { withWriteTx } = await import("../../../../db.js");
    const { softDeleteTableTx } = await import("../../../../domain/tableServiceTx.js");

    // 在线恢复字段。
    const created = await createField({ tableId, name: "切面字段", type: "text" }, OWNER);
    const fieldId = created.field.id;
    await deleteField(fieldId, OWNER);
    const vDelField = await schemaVersion(tableId);
    await restoreField(fieldId, OWNER);
    expect(await schemaVersion(tableId)).toBe(vDelField + 1n);
    const fieldLog = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "field", entityId: fieldId, op: "restore_field", clientId: "__server__" },
    });
    expect(fieldLog).not.toBeNull();

    // 在线重排（反序）。
    const live = await h.prisma.field.findMany({
      where: { tableId, deletedAt: null }, orderBy: { order: "asc" }, select: { id: true },
    });
    const vBeforeReorder = await schemaVersion(tableId);
    await reorderFields(tableId, [...live].reverse().map((x) => x.id), OWNER);
    expect(await schemaVersion(tableId)).toBe(vBeforeReorder + 1n);
    const reorderLog = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "field", entityId: tableId, op: "reorder_fields", clientId: "__server__" },
    });
    expect(reorderLog).not.toBeNull();

    // 在线恢复整表。
    await withWriteTx("test.softDelete2", (tx) => softDeleteTableTx(tx, tableId, OWNER));
    const vDelTable = await schemaVersion(tableId);
    await restoreTable(tableId, OWNER);
    expect(await schemaVersion(tableId)).toBe(vDelTable + 1n);
    const tableLog = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "table", entityId: tableId, op: "restore_table", clientId: "__server__" },
    });
    expect(tableLog).not.toBeNull();
  });
});

describe("E. 当前权限重判（manage_schema）", () => {
  it("受限成员推 restore_table → rejected=PERMISSION_REVOKED，表保持软删", async () => {
    const { tableId } = await onlineTable("恢复权限表");
    // ED 对本 base 可见但 canManage=false（无 manage_schema）。
    const put = await h.app.request("/api/v1/org/library-scopes", {
      method: "PUT",
      headers: await auth(OWNER),
      body: JSON.stringify({
        roleId: "role_restricted",
        items: [{ libraryKind: "base", libraryId: baseId, visible: true, canManage: false, config: { tables: {}, fields: {} } }],
      }),
    });
    expect(put.status).toBe(200);

    // 授权可见后再订阅（建立成员关系，库门 enter 可过；结构动作仍被 manage_schema 拦下）。
    const sub = await h.app.request("/api/v1/sync/subscribe", {
      method: "POST",
      headers: await auth(ED),
      body: JSON.stringify({ clientId: C_ED, scopeType: "base", scopeId: baseId }),
    });
    expect(sub.status).toBe(200);

    const { withWriteTx } = await import("../../../../db.js");
    const { softDeleteTableTx } = await import("../../../../domain/tableServiceTx.js");
    await withWriteTx("test.softDelete3", (tx) => softDeleteTableTx(tx, tableId, OWNER));

    const vBefore = await schemaVersion(tableId);
    const r = await pushAs(ED, C_ED, [
      sop(cid("ed_restore"), "table", "restore_table", tableId, vBefore.toString(), {}),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_PERMISSION_REVOKED");
    expect((await h.prisma.table.findUnique({ where: { id: tableId } }))!.deletedAt).not.toBeNull();
    expect(await schemaVersion(tableId)).toBe(vBefore);
  });
});

describe("F. 幂等", () => {
  it("restore_table 同 clientOpId 重放回同一版本，只恢复一次", async () => {
    const { tableId } = await onlineTable("恢复幂等表");
    const { withWriteTx } = await import("../../../../db.js");
    const { softDeleteTableTx } = await import("../../../../domain/tableServiceTx.js");
    await withWriteTx("test.softDelete4", (tx) => softDeleteTableTx(tx, tableId, OWNER));
    const vBefore = await schemaVersion(tableId);
    const op = sop(cid("restore_idem"), "table", "restore_table", tableId, vBefore.toString(), {});

    const r1 = await pushAs(OWNER, CLIENT, [op]);
    expect(r1.results![0]!.status).toBe("accepted");
    const v1 = r1.results![0]!.newVersion;
    const r2 = await pushAs(OWNER, CLIENT, [op]);
    expect(r2.results![0]!.status).toBe("accepted");
    expect(r2.results![0]!.newVersion).toBe(v1);
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: op.clientOpId } })).toBe(1);
  });
});

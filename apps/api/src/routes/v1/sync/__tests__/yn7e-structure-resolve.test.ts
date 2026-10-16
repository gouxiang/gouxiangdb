// YN7#788-D 结构冲突人工 resolve（mine/theirs/compound）+ 挂起数据 op 按新结构重放 契约测试。
// 真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock。
//
// 验收映射（DESIGN-OFFLINE-SYNC §19.3）：
//   A 结构版本分叉：双方都 alter 同一字段（类型/改名），后推者 baseVersion 落后 → conflict=
//     SYNC_STRUCTURE_VERSION_CONFLICT + 结构快照；theirs→dropped；mine 基于当前 schemaVersion 重放 accepted，
//     oplog result=resolved/conflictOf、结构钟再 +1。
//   B 场景 2：我离线改名的字段被对方删了 → alter_field 落 conflict=SYNC_ENTITY_DELETED；
//     compound(restore_field + alter_field) 原子 accepted，字段复活且改名、两步各一条 resolved oplog；
//     任一步非法（未登记 op）→ 400 且不产生任何写。
//   C 场景 3：对方把文本字段改成 number 后，我离线推的数据 op 因 baseSchemaVersion 落后挂起
//     (SYNC_STRUCTURE_DEPENDENCY_CONFLICT)；replayData 把可转值 "12" 显式转成 number 12 落库 accepted。
//   D 场景 3 不可转：挂起数据值是「张三」→ replayData 落 conflict=SYNC_SCHEMA_REPLAY_VALUE_CONFLICT，
//     绝不静默写脏值/不丢；原冲突行保留。
//   E 字段被对方删除后挂起数据 op 引用该字段 → replayData 落数据冲突（提示重新选字段/放弃）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn7e_owner";
const CLIENT = "yn7e-client";
let baseId = "";
let pushSeq = 0;
function cid(p: string): string { pushSeq += 1; return `${p}-${pushSeq}`; }

interface OpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined" | "dropped";
  reasonCode?: string;
  reasonDetail?: string;
  newVersion?: string;
  serverVersion?: string;
  entityId?: string;
}

async function auth(): Promise<Record<string, string>> {
  return { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
}

async function pushOne(op: Record<string, unknown>): Promise<{ http: number; r: OpResult }> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST", headers: await auth(),
    body: JSON.stringify({ baseId, clientId: CLIENT, ops: [op] }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, r: body.result?.results?.[0] };
}

async function resolve(body: Record<string, unknown>): Promise<{ http: number; result: any }> {
  const res = await h.app.request("/api/v1/sync/resolve", {
    method: "POST", headers: await auth(), body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { http: res.status, result: parsed.result ?? parsed };
}

async function schemaVersion(tableId: string): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: `table_schema:${tableId}` }, select: { version: true },
  });
  return row?.version ?? 0n;
}

async function onlineTable(name: string): Promise<{ tableId: string; primaryFieldId: string }> {
  const { createTable } = await import("../../../../domain/tableService.js");
  return createTable({ baseId, name, withDefaults: true }, OWNER);
}

async function addTextField(tableId: string, name: string): Promise<string> {
  const { createField } = await import("../../../../domain/fieldService.js");
  return (await createField({ tableId, name, type: "singleLineText" }, OWNER)).field.id;
}

/**
 * 模拟「对方」接受了一次改字段类型（推进服务端结构钟）。在线 updateField 刻意不落 type，故走
 * push alter_field——这正是 YN7 结构回放第一条真正改 type 的路径（C 片安全门放行空存量）。
 */
async function onlineAlterType(tableId: string, fieldId: string, type: string): Promise<void> {
  const v = await schemaVersion(tableId);
  const r = await pushOne({
    clientOpId: cid("peer_alter_type"), entityType: "field", entityId: fieldId, op: "alter_field",
    baseVersion: v.toString(), payload: { changed: { type } },
  });
  expect(r.http).toBe(200);
  expect(r.r.status).toBe("accepted");
}

async function softDeleteField(fieldId: string): Promise<void> {
  const { deleteField } = await import("../../../../domain/fieldService.js");
  await deleteField(fieldId, OWNER);
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
  const { createBase } = await import("../../../../domain/libraryService.js");
  baseId = (await createBase({ name: "yn7e", withStarter: false }, OWNER)).id;
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST", headers: await auth(),
    body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 结构版本分叉：mine/theirs", () => {
  it("落后的 alter_field 落结构冲突(带快照)；theirs 丢弃；mine 基于当前版本重放 accepted 且 oplog 留痕", async () => {
    const { tableId: t } = await onlineTable("分叉表");
    const f = await addTextField(t, "列一");
    const v0 = await schemaVersion(t);
    // 服务端（对方）先把字段改名 → 结构钟 +1。
    const serverRename = await pushOne({
      clientOpId: cid("srv_rename"), entityType: "field", entityId: f, op: "alter_field",
      baseVersion: v0.toString(), payload: { changed: { name: "对方改的名" } },
    });
    expect(serverRename.r.status).toBe("accepted");
    const v1 = await schemaVersion(t);
    expect(v1).toBe(v0 + 1n);

    // 我离线也改名（基于 v0）→ 结构冲突。
    const mine0 = await pushOne({
      clientOpId: cid("my_rename"), entityType: "field", entityId: f, op: "alter_field",
      baseVersion: v0.toString(), payload: { changed: { name: "我改的名" } },
    });
    expect(mine0.r.status).toBe("conflict");
    expect(mine0.r.reasonCode).toBe("SYNC_STRUCTURE_VERSION_CONFLICT");
    // 结构快照已落 conflictServerPayload。
    const conflictRow = await h.prisma.syncIncoming.findUniqueOrThrow({
      where: { clientOpId: mine0.r.clientOpId },
    });
    expect(conflictRow.status).toBe("conflict");
    const snap = JSON.parse(conflictRow.conflictServerPayload ?? "{}");
    expect(snap.kind).toBe("structure");
    expect(snap.fields.some((x: { id: string }) => x.id === f)).toBe(true);

    // theirs：放弃我的改名 → dropped，字段仍是对方的名、钟不进。
    const theirs = await resolve({ resolveOf: mine0.r.clientOpId, decision: "theirs" });
    expect(theirs.http).toBe(200);
    expect(theirs.result.status).toBe("dropped");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).name).toBe("对方改的名");
    expect(await schemaVersion(t)).toBe(v1);

    // 再来一次分叉用于 mine：对方再改名推进钟，我基于旧版本再推一条。
    await pushOne({
      clientOpId: cid("srv_rename2"), entityType: "field", entityId: f, op: "alter_field",
      baseVersion: v1.toString(), payload: { changed: { name: "对方又改" } },
    });
    const v2 = await schemaVersion(t);
    const mineB = await pushOne({
      clientOpId: cid("my_rename2"), entityType: "field", entityId: f, op: "alter_field",
      baseVersion: v1.toString(), payload: { changed: { name: "我最终的名" } },
    });
    expect(mineB.r.status).toBe("conflict");

    // mine：基于当前结构版本重放我的改名 → accepted，钟再 +1，字段变我的名。
    const mineRes = await resolve({
      resolveOf: mineB.r.clientOpId, decision: "mine", clientOpId: cid("resmine"),
    });
    expect(mineRes.http).toBe(200);
    expect(mineRes.result.status).toBe("accepted");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).name).toBe("我最终的名");
    expect(await schemaVersion(t)).toBe(v2 + 1n);
    // oplog result=resolved/conflictOf 溯源。
    const resolvedLog = await h.prisma.syncOpLog.findFirst({
      where: { conflictOf: mineB.r.clientOpId, result: "resolved" },
      orderBy: { seq: "desc" },
    });
    expect(resolvedLog).not.toBeNull();
    // 原冲突行置 resolved。
    expect((await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: mineB.r.clientOpId } })).status)
      .toBe("resolved");
  });
});

describe("B. 场景2：rename 撞上删字段 → compound(restore_field+alter_field)", () => {
  it("复合 resolve 原子恢复并改名；非法步骤 400 不产生写", async () => {
    const { tableId: t } = await onlineTable("复合表");
    const f = await addTextField(t, "待删列");
    const v0 = await schemaVersion(t);
    // 对方软删该字段（在线）→ 钟 +1。
    await softDeleteField(f);
    const v1 = await schemaVersion(t);
    expect(v1).toBe(v0 + 1n);
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).deletedAt).not.toBeNull();

    // 我离线改名（基于 v0）→ 结构冲突 ENTITY_DELETED。
    const rename = await pushOne({
      clientOpId: cid("rename_deleted"), entityType: "field", entityId: f, op: "alter_field",
      baseVersion: v0.toString(), payload: { changed: { name: "我想改的名" } },
    });
    expect(rename.r.status).toBe("conflict");
    expect(rename.r.reasonCode).toBe("SYNC_ENTITY_DELETED");

    // 非法 compound（未登记 op）→ 400，字段仍软删、钟不变。
    const bad = await resolve({
      resolveOf: rename.r.clientOpId, decision: "compound",
      compound: { steps: [{ entityType: "navnode", entityId: "x", op: "nav_create_group", payload: {} }] },
    });
    expect(bad.http).toBe(400);
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).deletedAt).not.toBeNull();

    // 合法 compound：restore_field + alter_field（两步都基于当前结构，钟连续 +2）。
    const runId = cid("rescmp");
    const ok = await resolve({
      resolveOf: rename.r.clientOpId, decision: "compound", clientOpId: runId,
      compound: {
        steps: [
          { entityType: "field", entityId: f, op: "restore_field", payload: {} },
          {
            entityType: "field", entityId: f, op: "alter_field",
            payload: { changed: { name: "复活并改名" } },
          },
        ],
      },
    });
    expect(ok.http).toBe(200);
    expect(ok.result.status).toBe("accepted");
    const after = await h.prisma.field.findUniqueOrThrow({ where: { id: f } });
    expect(after.deletedAt).toBeNull();
    expect(after.name).toBe("复活并改名");
    // restore + alter 各推进一次：v1 → v3。
    expect(await schemaVersion(t)).toBe(v1 + 2n);
    // 两步 oplog 都 result=resolved/conflictOf=原 op。
    const logs = await h.prisma.syncOpLog.findMany({
      where: { conflictOf: rename.r.clientOpId, result: "resolved" },
      orderBy: { seq: "asc" },
    });
    expect(logs.length).toBe(2);
    expect(logs.map((x) => x.clientOpId)).toEqual([`${runId}-0`, `${runId}-1`]);
    // 原冲突行 resolved。
    expect((await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: rename.r.clientOpId } })).status)
      .toBe("resolved");
  });
});

describe("C. 场景3：类型变更后挂起数据 op，可转值重放", () => {
  it("文本→number 后，挂起的 \"12\" 经 replayData 转成 number 12 落库", async () => {
    const { tableId: t } = await onlineTable("类型重放表");
    const f = await addTextField(t, "数值列");
    const v0 = await schemaVersion(t);
    // 对方把该列改成 number（存量为空，C 片安全门放行）→ 钟 +1。
    await onlineAlterType(t, f, "number");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).type).toBe("number");
    const v1 = await schemaVersion(t);
    expect(v1).toBe(v0 + 1n);

    // 我离线基于 v0 推一条 create（值是数字串）→ 结构依赖挂起。
    const recId = cid("offrec");
    const dep = await pushOne({
      clientOpId: cid("dep_create"), entityType: "record", entityId: recId, op: "create",
      baseVersion: "0", baseSchemaVersion: v0.toString(),
      payload: { tableId: t, fields: { [f]: "12" } },
    });
    expect(dep.r.status).toBe("conflict");
    expect(dep.r.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");
    // 挂起期间主数据不存在。
    expect(await h.prisma.record.findUnique({ where: { id: recId } })).toBeNull();

    // 用户在结构面板确认对齐 → replayData：可转值显式转 number。
    const rr = await resolve({ resolveOf: dep.r.clientOpId, decision: "replayData" });
    expect(rr.http).toBe(200);
    expect(rr.result.status).toBe("accepted");
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: recId } });
    expect(rec.deletedAt).toBeNull();
    expect(JSON.parse(rec.fields)[f]).toBe(12);
    expect((await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: dep.r.clientOpId } })).status)
      .toBe("resolved");
  });
});

describe("D. 场景3：不可转值 → 数据冲突，绝不静默写脏", () => {
  it("「张三」→number 重放落 conflict=SCHEMA_REPLAY_VALUE，记录不产生、原冲突行保留", async () => {
    const { tableId: t } = await onlineTable("不可转表");
    const f = await addTextField(t, "名字数值列");
    const v0 = await schemaVersion(t);
    await onlineAlterType(t, f, "number");

    const recId = cid("badrec");
    const dep = await pushOne({
      clientOpId: cid("dep_bad"), entityType: "record", entityId: recId, op: "create",
      baseVersion: "0", baseSchemaVersion: v0.toString(),
      payload: { tableId: t, fields: { [f]: "张三" } },
    });
    expect(dep.r.status).toBe("conflict");

    const rr = await resolve({ resolveOf: dep.r.clientOpId, decision: "replayData" });
    expect(rr.http).toBe(200);
    expect(rr.result.status).toBe("conflict");
    expect(rr.result.reasonCode).toBe("SYNC_SCHEMA_REPLAY_VALUE_CONFLICT");
    // 脏值绝不入库。
    expect(await h.prisma.record.findUnique({ where: { id: recId } })).toBeNull();
    // 原挂起冲突行仍是 conflict（用户可改值后用 custom 或放弃）。
    expect((await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: dep.r.clientOpId } })).status)
      .toBe("conflict");
  });
});

describe("E. 挂起数据引用被对方删除的字段 → 数据冲突", () => {
  it("replayData 落 SCHEMA_REPLAY_VALUE 提示重新选字段", async () => {
    const { tableId: t } = await onlineTable("删字段表");
    const f = await addTextField(t, "将删列");
    const v0 = await schemaVersion(t);
    await softDeleteField(f); // 钟 +1。

    const recId = cid("gonefldrec");
    const dep = await pushOne({
      clientOpId: cid("dep_gone"), entityType: "record", entityId: recId, op: "create",
      baseVersion: "0", baseSchemaVersion: v0.toString(),
      payload: { tableId: t, fields: { [f]: "x" } },
    });
    expect(dep.r.status).toBe("conflict");
    expect(dep.r.reasonCode).toBe("SYNC_STRUCTURE_DEPENDENCY_CONFLICT");

    const rr = await resolve({ resolveOf: dep.r.clientOpId, decision: "replayData" });
    expect(rr.result.status).toBe("conflict");
    expect(rr.result.reasonCode).toBe("SYNC_SCHEMA_REPLAY_VALUE_CONFLICT");
    expect(await h.prisma.record.findUnique({ where: { id: recId } })).toBeNull();
  });
});

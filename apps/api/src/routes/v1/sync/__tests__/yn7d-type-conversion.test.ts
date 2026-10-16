// YN7#788-C 结构 op 改字段类型 / 改主字段 对服务端存量数据的安全门 契约测试（§19.3 场景 3/5）。
// 真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock。
//
// 验收映射：
//   A 文本存量值是数字串 → alter_field 改 number accepted，field.type 落库、存量值不被重写（零破坏）、结构钟 +1。
//   B 存量值「张三」不可转数字 → rejected=SYNC_TYPE_CONVERSION_BLOCKED，type 不动、钟不进、incoming rejected、原因含数量。
//   C 字段值为空不阻碍类型变更（空值永远可转换）。
//   D checkbox：「是」可转、「maybe」不可转（rejected）。
//   E 文本→singleSelect：存量值命中新 option id 才 accepted，否则 rejected。
//   F 危险方向：number→links / number→formula → rejected=SYNC_TYPE_CHANGE_UNSUPPORTED。
//   G 改主字段：目标字段存在空值 → rejected=SYNC_PRIMARY_FIELD_HAS_EMPTY；全非空 → accepted。
//   H 幂等失败不留半成品：被拒后重发同一可接受 op 仍能成功（证明被拒事务确实整体回滚）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn7d_owner";
const CLIENT = "yn7d-client";
let baseId = "";
let pushSeq = 0;
function cid(p: string): string { pushSeq += 1; return `${p}-${pushSeq}`; }

interface OpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined";
  reasonCode?: string;
  reasonDetail?: string;
  newVersion?: string;
}

async function auth(): Promise<Record<string, string>> {
  return { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
}

async function pushStruct(op: Record<string, unknown>): Promise<{ status: number; r: OpResult }> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: await auth(),
    body: JSON.stringify({ baseId, clientId: CLIENT, ops: [op] }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, r: body.result?.results?.[0] };
}

async function schemaVersion(tableId: string): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: `table_schema:${tableId}` }, select: { version: true },
  });
  return row?.version ?? 0n;
}

async function onlineTable(name: string): Promise<string> {
  const { createTable } = await import("../../../../domain/tableService.js");
  return (await createTable({ baseId, name, withDefaults: false }, OWNER)).tableId;
}

async function addTextField(tableId: string, name: string): Promise<string> {
  const { createField } = await import("../../../../domain/fieldService.js");
  return (await createField({ tableId, name, type: "singleLineText" }, OWNER)).field.id;
}

/** 直接在表内造一条活记录（写入路径不按类型校验，便于构造"脏存量值"）。 */
async function insertRecord(tableId: string, cells: Record<string, unknown>, id?: string): Promise<string> {
  const rec = await h.prisma.record.create({
    data: {
      ...(id ? { id } : {}),
      tableId,
      fields: JSON.stringify(cells),
      createdBy: OWNER,
      updatedBy: OWNER,
    },
  });
  return rec.id;
}

function alterType(fieldId: string, baseVersion: string, changed: Record<string, unknown>) {
  return { clientOpId: cid("alter"), entityType: "field", entityId: fieldId, op: "alter_field", baseVersion, payload: { changed } };
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
  const { createBase } = await import("../../../../domain/libraryService.js");
  baseId = (await createBase({ name: "yn7d", withStarter: false }, OWNER)).id;
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

describe("A/B/C. 文本→数字 的存量值可转换门", () => {
  it("A 数字串可转 → accepted，type 落库且存量值保持原样", async () => {
    const t = await onlineTable("可转数字表");
    const f = await addTextField(t, "数字文本");
    await insertRecord(t, { [f]: "12" });
    const v = await schemaVersion(t);
    const { r } = await pushStruct(alterType(f, v.toString(), { type: "number" }));
    expect(r.status).toBe("accepted");
    const field = await h.prisma.field.findUniqueOrThrow({ where: { id: f } });
    expect(field.type).toBe("number");
    // 存量值不被重写（元数据-only 转换，零破坏）。
    const rec = await h.prisma.record.findFirstOrThrow({ where: { tableId: t } });
    expect(JSON.parse(rec.fields)[f]).toBe("12");
    expect(await schemaVersion(t)).toBe(v + 1n);
  });

  it("B 非数字存量值 → rejected=TYPE_CONVERSION_BLOCKED，type/钟不变、原因含数量", async () => {
    const t = await onlineTable("不可转数字表");
    const f = await addTextField(t, "名字列");
    await insertRecord(t, { [f]: "张三" });
    await insertRecord(t, { [f]: "李四" });
    const v = await schemaVersion(t);
    const { r } = await pushStruct(alterType(f, v.toString(), { type: "number" }));
    expect(r.status).toBe("rejected");
    expect(r.reasonCode).toBe("SYNC_TYPE_CONVERSION_BLOCKED");
    expect(r.reasonDetail).toContain("2 条");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).type).toBe("singleLineText");
    expect(await schemaVersion(t)).toBe(v);
    const incoming = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: r.clientOpId } });
    expect(incoming?.status).toBe("rejected");
  });

  it("C 存量值全空 → 无阻碍，accepted", async () => {
    const t = await onlineTable("空值表");
    const f = await addTextField(t, "空列");
    await insertRecord(t, { [f]: null });
    await insertRecord(t, {});
    const v = await schemaVersion(t);
    const { r } = await pushStruct(alterType(f, v.toString(), { type: "number" }));
    expect(r.status).toBe("accepted");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).type).toBe("number");
  });
});

describe("D. checkbox 转换", () => {
  it("「是」可转 accepted；「maybe」不可转 rejected", async () => {
    const tOk = await onlineTable("勾选可转表");
    const fOk = await addTextField(tOk, "勾");
    await insertRecord(tOk, { [fOk]: "是" });
    const vOk = await schemaVersion(tOk);
    const ok = await pushStruct(alterType(fOk, vOk.toString(), { type: "checkbox" }));
    expect(ok.r.status).toBe("accepted");

    const tBad = await onlineTable("勾选不可转表");
    const fBad = await addTextField(tBad, "勾2");
    await insertRecord(tBad, { [fBad]: "maybe" });
    const vBad = await schemaVersion(tBad);
    const bad = await pushStruct(alterType(fBad, vBad.toString(), { type: "checkbox" }));
    expect(bad.r.status).toBe("rejected");
    expect(bad.r.reasonCode).toBe("SYNC_TYPE_CONVERSION_BLOCKED");
  });
});

describe("E. 文本→singleSelect 选项命中门", () => {
  const options = [
    { id: "o1", name: "选项一", color: "#D3F0E4" },
    { id: "o2", name: "选项二", color: "#F7E1D7" },
  ];
  it("存量值命中 option id → accepted", async () => {
    const t = await onlineTable("单选命中表");
    const f = await addTextField(t, "单选");
    await insertRecord(t, { [f]: "o1" });
    const v = await schemaVersion(t);
    const { r } = await pushStruct(alterType(f, v.toString(), { type: "singleSelect", options }));
    expect(r.status).toBe("accepted");
  });
  it("存量值是显示名而非 option id → rejected", async () => {
    const t = await onlineTable("单选不命中表");
    const f = await addTextField(t, "单选2");
    await insertRecord(t, { [f]: "选项一" });
    const v = await schemaVersion(t);
    const { r } = await pushStruct(alterType(f, v.toString(), { type: "singleSelect", options }));
    expect(r.status).toBe("rejected");
    expect(r.reasonCode).toBe("SYNC_TYPE_CONVERSION_BLOCKED");
  });
});

describe("F. 危险转换方向", () => {
  it("number → links / formula → rejected=TYPE_CHANGE_UNSUPPORTED", async () => {
    const { createField } = await import("../../../../domain/fieldService.js");
    const t = await onlineTable("危险方向表");
    const numId = (await createField({ tableId: t, name: "数量列", type: "number" }, OWNER)).field.id;
    await insertRecord(t, { [numId]: 5 });
    const v = await schemaVersion(t);
    const links = await pushStruct(alterType(numId, v.toString(), { type: "links", relatedTableId: t, relationKind: "mm" }));
    expect(links.r.status).toBe("rejected");
    expect(links.r.reasonCode).toBe("SYNC_TYPE_CHANGE_UNSUPPORTED");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: numId } })).type).toBe("number");

    const formula = await pushStruct(alterType(numId, v.toString(), { type: "formula", formula: "1+1" }));
    expect(formula.r.status).toBe("rejected");
    expect(formula.r.reasonCode).toBe("SYNC_TYPE_CHANGE_UNSUPPORTED");
  });
});

describe("G. 改主字段全表非空门（§19.3-5）", () => {
  it("目标字段有空值 → rejected=PRIMARY_FIELD_HAS_EMPTY；换全非空字段 → accepted", async () => {
    const t = await onlineTable("主字段门表");
    // 建一个真主字段（表初始 primaryFieldId 为空，先给它一个字段）。
    const nameField = await addTextField(t, "标题");
    await h.prisma.table.update({ where: { id: t }, data: { primaryFieldId: nameField } });
    const sparse = await addTextField(t, "有空缺");
    const full = await addTextField(t, "都填满");
    await insertRecord(t, { [nameField]: "r1", [sparse]: "x", [full]: "a" });
    await insertRecord(t, { [nameField]: "r2", [sparse]: null, [full]: "b" });
    const v = await schemaVersion(t);

    const blocked = await pushStruct({
      clientOpId: cid("pf_bad"), entityType: "table", entityId: t, op: "update_table_settings",
      baseVersion: v.toString(), payload: { primaryFieldId: sparse },
    });
    expect(blocked.r.status).toBe("rejected");
    expect(blocked.r.reasonCode).toBe("SYNC_PRIMARY_FIELD_HAS_EMPTY");
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: t } })).primaryFieldId).toBe(nameField);

    const ok = await pushStruct({
      clientOpId: cid("pf_ok"), entityType: "table", entityId: t, op: "update_table_settings",
      baseVersion: v.toString(), payload: { primaryFieldId: full },
    });
    expect(ok.r.status).toBe("accepted");
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: t } })).primaryFieldId).toBe(full);
  });
});

describe("H. 被拒事务整体回滚后可重试", () => {
  it("先因脏值被拒，清理脏值后同一字段改类型可成功", async () => {
    const t = await onlineTable("重试表");
    const f = await addTextField(t, "混合列");
    const recId = await insertRecord(t, { [f]: "abc" });
    const v1 = await schemaVersion(t);
    const bad = await pushStruct(alterType(f, v1.toString(), { type: "number" }));
    expect(bad.r.status).toBe("rejected");
    // 模拟用户改值后重试：把存量值改成可转数字。
    await h.prisma.record.update({
      where: { id: recId },
      data: { fields: JSON.stringify({ [f]: "42" }) },
    });
    const good = await pushStruct(alterType(f, v1.toString(), { type: "number" }));
    expect(good.r.status).toBe("accepted");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: f } })).type).toBe("number");
  });
});

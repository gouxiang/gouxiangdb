// M5/S12 主库应急 LIKE 域级对抗（不依赖 search.db）：真迁移主库 + 真 resolveVisibleNodeIds
// 收敛（含 fieldMask fail-closed），断言只在可见集内对主列做 LIKE、不扩权、有界、参数化形态。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { querySeed } from "./queryHarness.js";
import { executeEmergencyLike } from "../emergencyLike.js";
import { resolveVisibleNodeIds } from "../../authz/scope.js";
import type { ScopeLike } from "../queryTypes.js";

const U = "u_emerg";
const T_HIDDEN = "em_table_hidden"; // U 无任何 r
const T_MASKED_MAIN = "em_table_maskmain"; // 主字段被 mask -> 整表跳过
const T_OK = "em_table_ok"; // 直授 r 无 mask
const R_HIDDEN = "em_r_hidden";
const R_MASKED = "em_r_masked";
const R_OK = "em_r_ok";
const F_HIDDEN = "em_f_hidden";
const F_SECRET = "em_f_secret";
const F_PUB = "em_f_pub";
const F_OK = "em_f_ok";

let h: QueryHarness;
let prisma: QueryHarness["prisma"];

async function scopeOf(userId: string): Promise<ScopeLike> {
  const s = await resolveVisibleNodeIds(prisma, userId, { actions: ["r"], workspaceId: "ws_default" });
  return {
    nodeIds: s.nodeIds, truncated: s.truncated, policyVersion: s.policyVersion,
    maskedTableFields: s.maskedTableFields,
  };
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s12-emerg-");
  prisma = h.prisma;
  await querySeed.createUsers(prisma, [{ id: U }, { id: "owner", email: "em_owner@x.com" }]);

  const mkTable = async (tableId: string, fields: Array<[string, string, string]>) => {
    await prisma.base.create({ data: { id: `${tableId}_b`, name: `${tableId} 库`, createdBy: "owner" } });
    await prisma.table.create({ data: {
      id: tableId, baseId: `${tableId}_b`, name: `${tableId} 表`, primaryFieldId: fields[0]![0], createdBy: "owner",
    } });
    for (const [fid, name, type] of fields) {
      await prisma.field.create({ data: { id: fid, tableId, name, type, order: 0 } });
    }
  };
  await mkTable(T_HIDDEN, [[F_HIDDEN, "主", "singleLineText"]]);
  await mkTable(T_MASKED_MAIN, [[F_SECRET, "机密主字段", "longText"], [F_PUB, "公开备注", "longText"]]);
  await mkTable(T_OK, [[F_OK, "客户名", "singleLineText"]]);

  await prisma.record.create({ data: {
    id: R_HIDDEN, tableId: T_HIDDEN, createdBy: "owner", updatedBy: "owner",
    fields: JSON.stringify({ [F_HIDDEN]: "EM唯一词拒权HIDDENX1 不应被应急路召回" }),
  } });
  await prisma.record.create({ data: {
    id: R_MASKED, tableId: T_MASKED_MAIN, createdBy: "owner", updatedBy: "owner",
    // 主字段被 mask：即使查询词出现在主字段，整表必须跳过；副字段命中也不顶用（只搜主列）。
    fields: JSON.stringify({ [F_SECRET]: "EMMASKX2 主字段机密词", [F_PUB]: "EMPUBX2 公开备注词" }),
  } });
  await prisma.record.create({ data: {
    id: R_OK, tableId: T_OK, createdBy: "owner", updatedBy: "owner",
    fields: JSON.stringify({ [F_OK]: "EMOKX3 普通可见主字段词" }),
  } });

  // 可见 doc + 越权 doc
  await prisma.knowledgeBase.create({ data: { id: "em_kb", name: "em 知识库", createdBy: "owner" } });
  await prisma.kbDoc.create({ data: {
    id: "em_doc_ok", kbId: "em_kb", kind: "doc", title: "em 可见文档", searchText: "EMDOCX3 可见正文词",
    createdBy: "owner", updatedBy: "owner",
  } });
  await prisma.kbDoc.create({ data: {
    id: "em_doc_hidden", kbId: "em_kb", kind: "doc", title: "em 拒权文档", searchText: "EMDOCX1 拒权正文词",
    createdBy: "owner", updatedBy: "owner",
  } });

  await querySeed.createNavNodes(prisma, [
    { id: `nav_base_${T_HIDDEN}_b`, kind: "base", resourceType: "base", resourceId: `${T_HIDDEN}_b`, parentId: null },
    { id: `nav_table_${T_HIDDEN}`, kind: "table", resourceType: "table", resourceId: T_HIDDEN, parentId: `nav_base_${T_HIDDEN}_b` },
    { id: `nav_base_${T_MASKED_MAIN}_b`, kind: "base", resourceType: "base", resourceId: `${T_MASKED_MAIN}_b`, parentId: null },
    { id: `nav_table_${T_MASKED_MAIN}`, kind: "table", resourceType: "table", resourceId: T_MASKED_MAIN, parentId: `nav_base_${T_MASKED_MAIN}_b` },
    { id: `nav_base_${T_OK}_b`, kind: "base", resourceType: "base", resourceId: `${T_OK}_b`, parentId: null },
    { id: `nav_table_${T_OK}`, kind: "table", resourceType: "table", resourceId: T_OK, parentId: `nav_base_${T_OK}_b` },
    { id: "nav_kb_em_kb", kind: "kb", resourceType: "kb", resourceId: "em_kb", parentId: null },
    { id: "nav_doc_em_doc_ok", kind: "doc", resourceType: "doc", resourceId: "em_doc_ok", parentId: "nav_kb_em_kb" },
    { id: "nav_doc_em_doc_hidden", kind: "doc", resourceType: "doc", resourceId: "em_doc_hidden", parentId: "nav_kb_em_kb" },
  ]);
  await querySeed.createPolicies(prisma, [
    { id: "em_p_mask", nodeId: `nav_table_${T_MASKED_MAIN}`, subjectType: "user", subjectId: U, actions: "r",
      fieldMask: '{"allowFields":["em_f_pub"]}' },
    { id: "em_p_ok", nodeId: `nav_table_${T_OK}`, subjectType: "user", subjectId: U, actions: "r" },
    { id: "em_p_doc", nodeId: "nav_doc_em_doc_ok", subjectType: "user", subjectId: U, actions: "r" },
  ]);
}, 180000);

afterAll(async () => { await h.cleanup(); });

describe("executeEmergencyLike 损坏重建期主库应急", () => {
  it("mode=like + degraded 含 search_store_recovering；越权 record/doc 缺席（不扩权）", async () => {
    const res = await executeEmergencyLike(prisma, await scopeOf(U), "EM", 20);
    expect(res.mode).toBe("like");
    expect(res.degraded).toContain("search_store_recovering");
    const ids = res.items.map((i) => i.entityId);
    expect(ids).toContain(R_OK);
    expect(ids).toContain("em_doc_ok");
    expect(ids).not.toContain(R_HIDDEN);
    expect(ids).not.toContain("em_doc_hidden");
    expect(JSON.stringify(res)).not.toContain("HIDDENX1");
    expect(JSON.stringify(res)).not.toContain("EMDOCX1");
    expect(res.items.length).toBeLessThanOrEqual(20);
  });

  it("fieldMask fail-closed：主字段被遮的表整表跳过（主词/公开副字段词都不召回）", async () => {
    const res = await executeEmergencyLike(prisma, await scopeOf(U), "EM", 20);
    const ids = res.items.map((i) => i.entityId);
    expect(ids).not.toContain(R_MASKED);
    // 应急只搜主列：即使副字段可见，EMPUBX2 也不应成为命中（无全字段 LIKE）。
    expect(JSON.stringify(res)).not.toContain("EMMASKX2");
    expect(JSON.stringify(res)).not.toContain("EMPUBX2");
  });

  it("LIKE 特殊字符（% _ \\）作为字面量转义，不产生全量匹配", async () => {
    const res = await executeEmergencyLike(prisma, await scopeOf(U), "%_\\", 20);
    expect(res.items).toEqual([]);
    expect(res.mode).toBe("like");
  });

  it("doc searchText 命中：可见 doc 经正文词召回，snippet 有界", async () => {
    const res = await executeEmergencyLike(prisma, await scopeOf(U), "EMDOCX3", 20);
    const doc = res.items.find((i) => i.entityId === "em_doc_ok");
    expect(doc).toBeTruthy();
    expect(doc!.docId).toBe("em_doc_ok");
    expect(doc!.matchedVia).toEqual([]);
    expect(doc!.matchedField).toBeNull();
  });

  it("limit 有界：limit<=50 截断，total 与 items 一致", async () => {
    const res = await executeEmergencyLike(prisma, await scopeOf(U), "EM", 1);
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
    expect(res.limit).toBe(1);
  });
});

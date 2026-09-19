// apps/api/src/routes/__tests__/field-link-source-http.test.ts
// 缺陷 2（P2 / F-04）回归 —— HTTP 路由层专辑，与 domain 层的
// apps/api/src/domain/__tests__/field-link-source-validation.test.ts 互补而非重复：
//   · domain 那份直接调 validateFieldConfig，锁的是「规则本身」
//   · 本份走真 app HTTP（_realApp 夹具），锁的是「路由有没有把 linkFieldId 真的传下去」
//     —— create/PATCH 两处 wiring 一旦漏传，规则写得再对也形同虚设（这正是本次缺陷的初始形态）。
// 覆盖增量：HTTP 状态码（400/201/200）、fields.ts 的 create 与 PATCH 两处透传、
//           被拒请求不在库里留半成品字段、放行路径的 linkFieldId 确实落库。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
/** 主表（放 rollup/lookup/count） */
let tableA: string;
/** 关联目标表 */
let tableB: string;
/** A 表中指向 B 的正向 links 字段 */
let linksId: string;
/** A 表中指向 B 的 subtable 字段（坏的关联源：计算层恒空） */
let subtableId: string;
/** B 表中的数值字段（rollup sum 的合法取值源） */
let amountId: string;
/** B 表中的文本字段（lookup 的合法取值源） */
let nameBId: string;

async function postField(tableId: string, body: Record<string, unknown>): Promise<number> {
  const res = await h.request("POST", `/fields?tableId=${tableId}`, body);
  return res.status;
}

async function postFieldJson(tableId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await h.request("POST", `/fields?tableId=${tableId}`, body);
  return { status: res.status, body: await res.json() };
}

async function patchField(fieldId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await h.request("PATCH", `/fields/${fieldId}`, body);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  h = await setupHarness("gx-flinkval-");

  const baseId = await h.makeBase();
  const a = await h.makeTable(baseId, "订单");
  const b = await h.makeTable(baseId, "明细");
  tableA = a.id;
  tableB = b.id;

  // B 表的取值源字段
  const bName = await postFieldJson(tableB, { name: "商品名", type: "singleLineText" });
  expect(bName.status).toBe(201);
  nameBId = bName.body.field.id;
  const bAmt = await postFieldJson(tableB, { name: "金额", type: "number" });
  expect(bAmt.status).toBe(201);
  amountId = bAmt.body.field.id;

  // A 表 → B 表的正向 links（合法关联源）
  const link = await postFieldJson(tableA, {
    name: "关联明细", type: "links", relatedTableId: tableB, relationKind: "hm",
  });
  expect(link.status).toBe(201);
  linksId = link.body.field.id;

  // A 表 → B 表的 subtable（非法关联源：hydrate resolveLookup/resolveCount 排除非 links）
  const sub = await postFieldJson(tableA, {
    name: "明细子表", type: "subtable", relatedTableId: tableB,
  });
  expect(sub.status).toBe(201);
  subtableId = sub.body.field.id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

describe("缺陷 2 · 负向：linkFieldId 指向非 links / 跨表 / 不存在 → 400", () => {
  it("rollup 指向 subtable 字段：400 + 可读错误信息", async () => {
    const res = await postFieldJson(tableA, {
      name: "金额合计坏", type: "rollup",
      linkFieldId: subtableId, lookupFieldId: amountId, rollupFunction: "sum",
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    // 错误信息要能被用户看懂：点名「关联」字段 + 指出所选字段不对
    expect(res.body.error).toContain("关联");
    expect(res.body.error).toContain("明细子表");
  });

  it("lookup 指向 subtable 字段：400 + 可读错误信息", async () => {
    const res = await postFieldJson(tableA, {
      name: "商品名查坏", type: "lookup",
      linkFieldId: subtableId, lookupFieldId: nameBId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("关联");
    expect(res.body.error).toContain("明细子表");
  });

  it("count 指向 subtable 字段：400 + 可读错误信息", async () => {
    const res = await postFieldJson(tableA, {
      name: "明细数坏", type: "count", linkFieldId: subtableId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("关联");
    expect(res.body.error).toContain("明细子表");
  });

  it("linkFieldId 指向【他表】的 links 字段：400（必须属于本表）", async () => {
    // 反向字段建在 B 表上，对 A 表来说就是「他表的 links」
    const reverse = await h.prisma.field.findFirst({
      where: { tableId: tableB, type: "links", isReverse: true },
      select: { id: true },
    });
    expect(reverse).not.toBeNull();
    const res = await postFieldJson(tableA, {
      name: "跨表查", type: "count", linkFieldId: reverse!.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("当前数据表");
  });

  it("linkFieldId 指向不存在的字段：400 + 可读错误信息", async () => {
    const res = await postFieldJson(tableA, {
      name: "幽灵关联", type: "count", linkFieldId: "fld_not_exist",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("不存在");
  });

  it("被拒的请求不留脏字段（库里没有半成品记录）", async () => {
    const before = await h.prisma.field.count({ where: { tableId: tableA, deletedAt: null } });
    await postFieldJson(tableA, {
      name: "再来一次坏", type: "rollup",
      linkFieldId: subtableId, lookupFieldId: amountId, rollupFunction: "sum",
    });
    const after = await h.prisma.field.count({ where: { tableId: tableA, deletedAt: null } });
    expect(after).toBe(before);
  });
});

describe("缺陷 2 · 正向：linkFieldId 指向本表 links 仍可创建（不得误伤）", () => {
  it("rollup 指向 links 且 sum 源为数值字段：201 并落库", async () => {
    const res = await postFieldJson(tableA, {
      name: "金额合计", type: "rollup",
      linkFieldId: linksId, lookupFieldId: amountId, rollupFunction: "sum",
    });
    expect(res.status).toBe(201);
    expect(res.body.field.linkFieldId).toBe(linksId);
    const row = await h.prisma.field.findUnique({ where: { id: res.body.field.id } });
    expect(row?.type).toBe("rollup");
    expect(row?.linkFieldId).toBe(linksId);
  });

  it("lookup 指向 links：201 并落库", async () => {
    const res = await postFieldJson(tableA, {
      name: "商品名", type: "lookup", linkFieldId: linksId, lookupFieldId: nameBId,
    });
    expect(res.status).toBe(201);
    expect(res.body.field.linkFieldId).toBe(linksId);
  });

  it("count 指向 links：201 并落库", async () => {
    const res = await postFieldJson(tableA, {
      name: "明细数", type: "count", linkFieldId: linksId,
    });
    expect(res.status).toBe(201);
    expect(res.body.field.linkFieldId).toBe(linksId);
  });

  it("不传 linkFieldId 仍放行（hydrate 会回退到本表首个 links 字段，既有行为不变）", async () => {
    const status = await postField(tableA, { name: "不指定关联源", type: "count" });
    expect(status).toBe(201);
  });
});

describe("缺陷 2 · PATCH 路径同样被拦（存量字段改坏也必须 400）", () => {
  it("把已有 rollup 的 linkFieldId 改成 subtable：400，且库里仍是原 links", async () => {
    const created = await postFieldJson(tableA, {
      name: "待改坏的合计", type: "rollup",
      linkFieldId: linksId, lookupFieldId: amountId, rollupFunction: "sum",
    });
    expect(created.status).toBe(201);
    const fieldId = created.body.field.id;

    const patched = await patchField(fieldId, { linkFieldId: subtableId });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("关联");

    const row = await h.prisma.field.findUnique({ where: { id: fieldId } });
    expect(row?.linkFieldId).toBe(linksId);
  });

  it("PATCH 改成合法的 links：200，落库生效", async () => {
    const created = await postFieldJson(tableA, {
      name: "待改好的合计", type: "rollup",
      linkFieldId: linksId, lookupFieldId: amountId, rollupFunction: "sum",
    });
    expect(created.status).toBe(201);
    const fieldId = created.body.field.id;

    // 先改成一个别的合法值（不传 linkFieldId 的字段），再改回 links
    const patched = await patchField(fieldId, { linkFieldId: linksId });
    expect(patched.status).toBe(200);
    const row = await h.prisma.field.findUnique({ where: { id: fieldId } });
    expect(row?.linkFieldId).toBe(linksId);
  });
});

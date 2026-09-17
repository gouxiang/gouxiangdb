// RC-35 反向默认值重算（真 app HTTP + 真迁移临时库，不 mock 重算函数）。
//
// 配置（按代码实际支持的形态）：
//   父表 A：正向 links 字段「子项」(relationKind=hm → 关联 B) +
//           数值字段「总额」defaultConfig = { mode:"formula", formula:"SUM({子项.金额})" }
//           ——「落库的默认值公式」，引用点字段（含 "."），子表变化时由反向联动重算并落库。
//   子表 B：数值字段「金额」。
// 链路：
//   1) 在 B 新建子记录并通过【反向字段】挂到父 P → applyReverseDefaultsForChild → P.总额 落库 10；
//   2) PATCH 子记录金额 10→30 → 反向重算 → P.总额=30；
//   3) 软删子记录（linkRow 同步软删，includeDeleted 仍定位到 P）→ 重算无活跃子项 → P.总额=0。
// 全程读父记录【落库的 fields】断言，不经过实时 hydrate，证明值确实被服务端重算并持久化。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let prisma: PrismaClient;
let tableA: string;
let tableB: string;
let parentPrimaryFieldId: string;
let reverseFieldId: string;
let childAmountFieldId: string;
let parentTotalFieldId: string;

beforeAll(async () => {
  h = await setupHarness("gx-rc35-revdefault-");
  prisma = h.prisma;
  const baseId = await h.makeBase();
  const a = await h.makeTable(baseId, "A");
  const b = await h.makeTable(baseId, "B");
  tableA = a.id;
  tableB = b.id;
  parentPrimaryFieldId = a.primaryFieldId;

  // 子表数值列「金额」
  childAmountFieldId = (await prisma.field.create({
    data: { tableId: tableB, name: "金额", type: "number", order: 1, precision: 2 },
  })).id;

  // 父表正向 links「子项」→ B（hm）。HTTP 走真实建对与配置校验。
  const linkRes = await h.request("POST", `/fields?tableId=${tableA}`, {
    name: "子项",
    type: "links",
    relatedTableId: tableB,
    relationKind: "hm",
  });
  expect(linkRes.status).toBe(201);
  const linkBody = await linkRes.json();
  reverseFieldId = linkBody.reverseField.id;
  expect(reverseFieldId).toBeTruthy();

  // 父表数值列「总额」，默认内容=点引用求和公式（落库默认值，区别于实时公式字段）
  const totalRes = await h.request("POST", `/fields?tableId=${tableA}`, {
    name: "总额",
    type: "number",
    precision: 2,
    defaultConfig: { mode: "formula", formula: "SUM({子项.金额})" },
  });
  expect(totalRes.status).toBe(201);
  const totalBody = await totalRes.json();
  parentTotalFieldId = totalBody.field.id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  await prisma.comment.deleteMany({});
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.changeEvent.deleteMany({});
});

async function parentStoredTotal(parentId: string): Promise<unknown> {
  const row = await prisma.record.findUnique({ where: { id: parentId } });
  if (!row) throw new Error("parent record missing");
  return JSON.parse(row.fields)[parentTotalFieldId];
}

describe("RC-35 子表记录变化 → 父表落库默认值公式反向重算", () => {
  it("新增挂接 / 改金额 / 软删 三步后父表「总额」依次为 10 / 30 / 0", async () => {
    // 父记录 P（先无子项）。POST payload 键是字段 id。
    const parentCreate = await h.request("POST", `/records?tableId=${tableA}`, {
      fields: { [parentPrimaryFieldId]: "P" },
    });
    expect(parentCreate.status).toBe(201);
    const parentId = (await parentCreate.json()).record.id;

    // 初始：无子项，SUM 空集=0（创建期默认公式落 0）
    expect(await parentStoredTotal(parentId)).toBe(0);

    // 1) 在子表 B 建记录，金额=10，并经【反向字段】挂到父 P
    const c1 = await h.request("POST", `/records?tableId=${tableB}`, {
      fields: { [childAmountFieldId]: 10, [reverseFieldId]: [parentId] },
    });
    expect(c1.status).toBe(201);
    const c1Body = await c1.json();
    const childId = c1Body.record.id;
    // POST 响应回吐受影响父记录
    expect(c1Body.affectedParents).toEqual(
      expect.arrayContaining([expect.objectContaining({ tableId: tableA, recordId: parentId })]),
    );
    expect(await parentStoredTotal(parentId)).toBe(10);

    // 2) PATCH 子记录金额 10→30 → 父表反向重算
    const patch = await h.request("PATCH", `/records/${childId}`, {
      fields: { [childAmountFieldId]: 30 },
    });
    expect(patch.status).toBe(200);
    expect(await parentStoredTotal(parentId)).toBe(30);

    // 3) 软删子记录：linkRow 同步软删，includeDeleted 仍据其定位父 P → 重算为 0
    const del = await h.request("DELETE", `/records/${childId}`);
    expect(del.status).toBe(200);
    expect(await parentStoredTotal(parentId)).toBe(0);
  });

  it("多个子项求和：10+30+5.5=45.5（真实点引用聚合，非单值直取）", async () => {
    const parentCreate = await h.request("POST", `/records?tableId=${tableA}`, {
      fields: { [parentPrimaryFieldId]: "P2" },
    });
    expect(parentCreate.status).toBe(201);
    const parentId = (await parentCreate.json()).record.id;

    for (const amount of [10, 30, 5.5]) {
      const r = await h.request("POST", `/records?tableId=${tableB}`, {
        fields: { [childAmountFieldId]: amount, [reverseFieldId]: [parentId] },
      });
      expect(r.status).toBe(201);
    }
    expect(await parentStoredTotal(parentId)).toBe(45.5);
  });
});

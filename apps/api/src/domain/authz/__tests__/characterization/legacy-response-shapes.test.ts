// M4/S0 旧响应形状 characterization golden（只锁现状，不修正；禁改生产码）。
//
// 这些是 M4-S6 fieldMask 落地后【引擎 off 态逐字节不变】的金标准：
//   1. records 列表 off 态恰好七键：records/total/filteredTotal/fields/allFields/groups/aggregations；
//      keyset 默认 off，不含 nextCursor/hasMore/degraded（additive 仅 on 态）；
//   2. 详情恰好 {record, fields}；
//   3. CSV 表头列序 = 活字段顺序的 f.name（BOM 前缀），逗号连接。
// 真库真迁移，经真 HTTP 打旧 /api。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "../../../nav/__tests__/characterization/charHarness.js";

let h: CharHarness;

beforeAll(async () => {
  h = await setupCharHarness("gx-m4-shapes-");
  await h.createUser("owner");
}, 120000);
afterAll(() => h.cleanup());

async function makeBase(): Promise<{ baseId: string; tableId: string }> {
  const b = await h.app.request("/api/bases", {
    method: "POST",
    headers: { ...(await h.auth("owner")), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "形状库" }),
  });
  const baseId = (await json<{ base: { id: string } }>(b)).base.id;
  const t = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("owner") });
  const tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;
  return { baseId, tableId };
}

describe("records 列表响应形状（off 态金标准）", () => {
  it("恰好七键，顺序固定，无 keyset 附加键", async () => {
    const { tableId } = await makeBase();
    await h.app.request(`/api/records?tableId=${tableId}`, {
      method: "POST",
      headers: { ...(await h.auth("owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {} }),
    });
    const res = await h.app.request(`/api/records?tableId=${tableId}`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body)).toEqual([
      "records",
      "total",
      "filteredTotal",
      "fields",
      "allFields",
      "groups",
      "aggregations",
    ]);
    expect(Array.isArray(body.records)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.filteredTotal).toBe("number");
    expect(Array.isArray(body.fields)).toBe(true);
    expect(Array.isArray(body.allFields)).toBe(true);
    // 无 view 时 visibleFields === 全部活字段。
    expect(body.fields).toEqual(body.allFields);
    expect(body.groups).toBeNull();
    expect(body.aggregations).toBeNull();
    // keyset 默认 off：additive 三键缺席。
    expect(body).not.toHaveProperty("nextCursor");
    expect(body).not.toHaveProperty("hasMore");
    expect(body).not.toHaveProperty("degraded");
  });
});

describe("record 详情响应形状（off 态金标准）", () => {
  it("恰好 {record, fields} 两键", async () => {
    const { tableId } = await makeBase();
    const created = await h.app.request(`/api/records?tableId=${tableId}`, {
      method: "POST",
      headers: { ...(await h.auth("owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {} }),
    });
    const recordId = (await json<{ record: { id: string } }>(created)).record.id;
    const res = await h.app.request(`/api/records/${recordId}`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual(["fields", "record"]);
    expect((body.record as { id: string }).id).toBe(recordId);
    expect(Array.isArray(body.fields)).toBe(true);
  });
});

describe("CSV 表头列序（off 态金标准）", () => {
  it("表头 = BOM + 活字段 name 顺序，逗号连接；新增字段追加在尾", async () => {
    const { tableId } = await makeBase();
    // 建表默认带一个主字段；按固定序再建两列。
    for (const name of ["金额列", "备注列"]) {
      const r = await h.app.request(`/api/fields?tableId=${tableId}`, {
        method: "POST",
        headers: { ...(await h.auth("owner")), "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "singleLineText" }),
      });
      expect(r.status).toBe(201);
    }
    const fieldsRes = await h.app.request(`/api/records?tableId=${tableId}`, { headers: await h.auth("owner") });
    const fieldNames = ((await json<{ fields: Array<{ name: string }> }>(fieldsRes)).fields).map((f) => f.name);
    expect(fieldNames.length).toBeGreaterThanOrEqual(3);

    const res = await h.app.request(`/api/tables/${tableId}/export.csv`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // csvHeaderLine 写了 UTF-8 BOM；用原始字节锁定（Response.text() 会剥离前导 BOM）。
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(buf.slice(3));
    const firstLine = text.split("\r\n")[0]!;
    // BOM 后字段名逐列逗号连接（simpleText 名称无逗号/引号，转义后恒等）。
    expect(firstLine).toBe(fieldNames.join(","));
    expect(firstLine.split(",").length).toBe(fieldNames.length);
  });
});

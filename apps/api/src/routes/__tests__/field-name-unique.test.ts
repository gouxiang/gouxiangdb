// 字段名【同表唯一 + trim】契约测试（真 app HTTP + 真迁移临时库）。
// 覆盖：建字段重名 409（含 trim 后同名）、纯空格 400 不落库；改名撞名 409 原名不变、
// 改成自己现名 200、只改别的字段 200、纯空格改名 400；软删字段后名字可复用。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let tableId: string;

beforeAll(async () => {
  h = await setupHarness("gx-field-name-unique-");
  const baseId = await h.makeBase();
  tableId = (await h.makeTable(baseId, "t")).id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> =>
  res.json() as Promise<Record<string, any>>;

async function liveFieldNames(): Promise<string[]> {
  const rows = await h.prisma.field.findMany({
    where: { tableId, deletedAt: null },
    select: { name: true },
  });
  return rows.map((r) => r.name).sort();
}

async function createField(name: string): Promise<Response> {
  return h.request("POST", `/fields?tableId=${tableId}`, { name, type: "singleLineText" });
}

describe("建字段：同表名字唯一 + trim", () => {
  it("重名 → 409，且不产生新字段", async () => {
    expect((await createField("客户名")).status).toBe(201);
    const dup = await createField("客户名");
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("字段名「客户名」已存在");
    expect(await liveFieldNames()).toEqual(["名称", "客户名"].sort());
  });

  it("trim 后同名即重名：先建「 客户名 」落库为「客户名」，再建「客户名」409", async () => {
    const ok = await createField("  备注  ");
    expect(ok.status).toBe(201);
    expect((await json(ok)).field.name).toBe("备注");
    const dup = await createField("备注");
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("字段名「备注」已存在");
  });

  it("纯空格名 → 400，不落库", async () => {
    const before = await h.prisma.field.count({ where: { tableId, deletedAt: null } });
    const res = await createField("    ");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("字段名不能为空");
    expect(await h.prisma.field.count({ where: { tableId, deletedAt: null } })).toBe(before);
  });

  it("软删字段后其名字可以重新建", async () => {
    const created = await json(await createField("临时字段"));
    expect((await h.request("DELETE", `/fields/${created.field.id}`)).status).toBe(200);
    const again = await createField("临时字段");
    expect(again.status).toBe(201);
  });
});

describe("改字段名：事务内查重排除自己 + trim", () => {
  it("改名撞上同表另一字段 → 409，原名保持不变（事务回滚）", async () => {
    const _a = await json(await createField("字段A"));
    const b = await json(await createField("字段B"));
    const res = await h.request("PATCH", `/fields/${b.field.id}`, { name: "字段A" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("字段名「字段A」已存在");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: b.field.id } })).name).toBe("字段B");
  });

  it("改成自己现在的名字 → 200（排除自己的回归锁）", async () => {
    const a = await json(await createField("自己名"));
    const res = await h.request("PATCH", `/fields/${a.field.id}`, { name: "自己名" });
    expect(res.status).toBe(200);
    expect((await json(res)).field.name).toBe("自己名");
  });

  it("改名带首尾空格：查重按 trim 比、写库按 trim 存", async () => {
    const a = await json(await createField("原名X"));
    const ok = await h.request("PATCH", `/fields/${a.field.id}`, { name: "  新名X  " });
    expect(ok.status).toBe(200);
    expect((await json(ok)).field.name).toBe("新名X");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: a.field.id } })).name).toBe("新名X");

    // trim 后撞名应被拦
    const b = await json(await createField("别的字段"));
    const dup = await h.request("PATCH", `/fields/${b.field.id}`, { name: " 新名X " });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("字段名「新名X」已存在");
  });

  it("只改 description（不带 name）→ 200，不被查重误伤", async () => {
    const a = await json(await createField("仅改描述"));
    const res = await h.request("PATCH", `/fields/${a.field.id}`, { description: "新的说明" });
    expect(res.status).toBe(200);
    expect((await json(res)).field.name).toBe("仅改描述");
  });

  it("改名传纯空格 → 400，原名保持不变", async () => {
    const a = await json(await createField("原名不变X"));
    const res = await h.request("PATCH", `/fields/${a.field.id}`, { name: "   " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("字段名不能为空");
    expect((await h.prisma.field.findUniqueOrThrow({ where: { id: a.field.id } })).name).toBe("原名不变X");
  });
});

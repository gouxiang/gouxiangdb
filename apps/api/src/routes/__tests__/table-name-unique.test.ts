// 数据表【表名库内唯一】契约测试（真 app HTTP + 真迁移临时库，不 mock 路由）。
//
// 产品口径：同一 Base 内表名强制唯一，重名拦下来，口径与字段重名一致——
//   409 + { error: `表名「X」已存在` }（字段名那边是 `字段名「X」已存在`，见 routes/fields.ts）。
//
// 作用域与边界：
//   - 唯一性范围 = 同一个 baseId；跨库同名允许。
//   - 只比未软删的表（deletedAt: null）。
//   - trim 后精确匹配，不做大小写折叠。
//   - 不加数据库唯一索引（存量库已有重复表名），只在「新建 / 改名 / 显式命名复制」三条
//     写路径拦；复制走默认「X 副本」时不打断，自动排号到「X 副本 2」…
//
// 夹具沿用 _realApp.ts 的 "entities" 挂载（bases + tables + kb），身份固定 owner。
// makeTable 直接落库（绕过路由）用于铺存量数据；被测动作一律走 HTTP。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  setupHarness,
  type Harness,
  OWNER_ID,
} from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;

beforeAll(async () => {
  h = await setupHarness("gx-table-name-unique-", "entities");
});

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;

/**
 * 该库下未软删的表名列表。统一排序后再断言——createdAt 相同时 SQLite 的返回次序不确定，
 * 排序后两侧用同一比较器，期望才稳定（不依赖物理行序）。
 */
async function namesOf(baseId: string): Promise<string[]> {
  const rows = await h.prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { name: true },
  });
  return rows.map((r) => r.name).sort();
}

/** 该库下未软删表的数量。 */
async function liveCount(baseId: string): Promise<number> {
  return h.prisma.table.count({ where: { baseId, deletedAt: null } });
}

/** 直接落库一张同名/rand 表（绕路由），用于铺存量重复。 */
async function seedRawTable(baseId: string, name: string): Promise<string> {
  const t = await h.prisma.table.create({
    data: { baseId, name, primaryFieldId: "", createdBy: OWNER_ID },
  });
  return t.id;
}

// ============ 1) 建表重名 ============

describe("建表：同库表名唯一", () => {
  it("同库建两张同名表 → 第二次 409，文案口径与字段重名一致", async () => {
    const baseId = await h.makeBase("DUP-CREATE");
    const created = await h.request("POST", `/tables?baseId=${baseId}`, { name: "客户表" });
    expect(created.status).toBe(201);
    expect((await json(created)).table.name).toBe("客户表");

    const before = await liveCount(baseId);
    const dup = await h.request("POST", `/tables?baseId=${baseId}`, { name: "客户表" });
    expect(dup.status).toBe(409);
    const body = await json(dup);
    expect(body.error).toBe("表名「客户表」已存在");
    expect(body.code).toBe("CONFLICT");

    // 事务整体回滚：库里只多出 1 张表（本次两张请求实际只成功一张），
    // 也没留下无 primaryField / 无视图的半截表
    expect(await liveCount(baseId)).toBe(before);
    expect(await namesOf(baseId)).toEqual(["客户表"]);
    const row = await h.prisma.table.findFirstOrThrow({ where: { baseId, deletedAt: null } });
    expect(row.primaryFieldId).not.toBe("");
    expect(await h.prisma.field.count({ where: { tableId: row.id, deletedAt: null } })).toBe(1);
    expect(await h.prisma.view.count({ where: { tableId: row.id } })).toBe(1);
  });

  it("trim 后同名即为同名：先建「 客户表 」落库为「客户表」，再建「客户表」是 409", async () => {
    const baseId = await h.makeBase("DUP-CREATE-TRIM");
    const ok = await h.request("POST", `/tables?baseId=${baseId}`, { name: " 客户表 " });
    expect(ok.status).toBe(201);
    expect((await json(ok)).table.name).toBe("客户表");

    const dup = await h.request("POST", `/tables?baseId=${baseId}`, { name: "客户表" });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("表名「客户表」已存在");
    expect(await namesOf(baseId)).toEqual(["客户表"]);
  });

  it("不做大小写折叠：Table 与 table 可以共存", async () => {
    const baseId = await h.makeBase("DUP-CREATE-CASE");
    expect((await h.request("POST", `/tables?baseId=${baseId}`, { name: "Table" })).status).toBe(201);
    const second = await h.request("POST", `/tables?baseId=${baseId}`, { name: "table" });
    expect(second.status).toBe(201);
    expect(await namesOf(baseId)).toEqual(["Table", "table"].sort());
  });

  it("软删的表不参与查重：可以复用已删表的名字", async () => {
    const baseId = await h.makeBase("DUP-CREATE-SOFTDEL");
    const { id } = await h.makeTable(baseId, "归档表");
    const del = await h.request("DELETE", `/tables/${id}`);
    expect(del.status).toBe(200);
    expect(await liveCount(baseId)).toBe(0);

    const res = await h.request("POST", `/tables?baseId=${baseId}`, { name: "归档表" });
    expect(res.status).toBe(201);
    expect(await namesOf(baseId)).toEqual(["归档表"]);
  });

  it("纯空格表名 → 400，不落库（不留名字看不见的空串表）", async () => {
    const baseId = await h.makeBase("CREATE-BLANK");
    const before = await liveCount(baseId);
    const res = await h.request("POST", `/tables?baseId=${baseId}`, { name: "   " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("表名不能为空");
    // 不许落库：否则第二次建表会被唯一性拦成「表名「」已存在」，用户读不懂
    expect(await liveCount(baseId)).toBe(before);
    expect(await namesOf(baseId)).toEqual([]);
  });
});

// ============ 2) 作用域 ============

describe("作用域：唯一性限于同一个 Base", () => {
  it("不同库建同名表 → 都成功（没被搞成全局唯一）", async () => {
    const b1 = await h.makeBase("SCOPE-A");
    const b2 = await h.makeBase("SCOPE-B");
    const r1 = await h.request("POST", `/tables?baseId=${b1}`, { name: "同名表" });
    const r2 = await h.request("POST", `/tables?baseId=${b2}`, { name: "同名表" });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await json(r1)).table.baseId).toBe(b1);
    expect((await json(r2)).table.baseId).toBe(b2);
    expect(await namesOf(b1)).toEqual(["同名表"]);
    expect(await namesOf(b2)).toEqual(["同名表"]);
  });
});

// ============ 3) 改名 ============

describe("改名：撞同库别的表 409，改成自己现在的名字放行", () => {
  it("改名撞上同库另一张表 → 409，且名字未被改动（事务回滚）", async () => {
    const baseId = await h.makeBase("RENAME-DUP");
    await h.makeTable(baseId, "表A");
    const { id: b } = await h.makeTable(baseId, "表B");

    const res = await h.request("PATCH", `/tables/${b}`, { name: "表A" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("表名「表A」已存在");

    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: b } })).name).toBe("表B");
    expect(await namesOf(baseId)).toEqual(["表A", "表B"].sort());
  });

  it("改名成自己现在的名字 → 200（排除自己的回归锁）", async () => {
    const baseId = await h.makeBase("RENAME-SELF");
    const { id } = await h.makeTable(baseId, "自己");
    const res = await h.request("PATCH", `/tables/${id}`, { name: "自己" });
    expect(res.status).toBe(200);
    expect((await json(res)).table.name).toBe("自己");
    expect(await namesOf(baseId)).toEqual(["自己"]);
  });

  it("改名带首尾空格：查重按 trim 比，写入按 trim 存", async () => {
    const baseId = await h.makeBase("RENAME-TRIM");
    const { id } = await h.makeTable(baseId, "原名");
    const ok = await h.request("PATCH", `/tables/${id}`, { name: "  新名  " });
    expect(ok.status).toBe(200);
    expect((await json(ok)).table.name).toBe("新名");
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id } })).name).toBe("新名");

    // 已有「新名」时，把另一张表改成「 新名 」应被拦
    const { id: other } = await h.makeTable(baseId, "另一张");
    const dup = await h.request("PATCH", `/tables/${other}`, { name: " 新名 " });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("表名「新名」已存在");
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: other } })).name).toBe("另一张");
  });

  it("只改 icon（不带 name）→ 200，不被查重误伤", async () => {
    const baseId = await h.makeBase("RENAME-ICON-ONLY");
    // 铺两张表：若查重漏了「只在 name !== undefined 时校验」，这条会 409
    const { id: t1 } = await h.makeTable(baseId, "图标表1");
    await h.makeTable(baseId, "图标表2");

    const res = await h.request("PATCH", `/tables/${t1}`, { icon: "star", iconColor: "#123456" });
    expect(res.status).toBe(200);
    expect((await json(res)).table).toMatchObject({ icon: "star", iconColor: "#123456" });
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: t1 } })).name).toBe("图标表1");
  });

  it("改名传纯空格 → 400，原名保持不变（不许改成空串名）", async () => {
    const baseId = await h.makeBase("RENAME-BLANK");
    const { id } = await h.makeTable(baseId, "原名不变");
    const res = await h.request("PATCH", `/tables/${id}`, { name: "   " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("表名不能为空");
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id } })).name).toBe("原名不变");
  });

  it("改名可以用别的库已在用的名字（作用域不串库）", async () => {
    const b1 = await h.makeBase("RENAME-CROSS-A");
    const b2 = await h.makeBase("RENAME-CROSS-B");
    await h.makeTable(b1, "共用名");
    const { id } = await h.makeTable(b2, "待改名");
    const res = await h.request("PATCH", `/tables/${id}`, { name: "共用名" });
    expect(res.status).toBe(200);
    expect(await namesOf(b2)).toEqual(["共用名"]);
  });
});

// ============ 4) 复制表 ============

describe("复制表：默认名自动排号，显式命名冲突则 409", () => {
  it("默认名冲突时逐级后延：「X 副本」「X 副本 2」「X 副本 3」已存在 → 落到「X 副本 4」", async () => {
    const baseId = await h.makeBase("COPY-AUTONUM");
    const { id: src } = await h.makeTable(baseId, "数据表");
    await seedRawTable(baseId, "数据表 副本");
    await seedRawTable(baseId, "数据表 副本 2");
    await seedRawTable(baseId, "数据表 副本 3");

    const res = await h.request("POST", `/tables/${src}/duplicate`);
    expect(res.status).toBe(201);
    expect((await json(res)).table.name).toBe("数据表 副本 4");
  });

  it("存量库里 3 张同名「X 副本」也被绕开 → 「X 副本 2」，返回 201 而不是 409", async () => {
    const baseId = await h.makeBase("COPY-AUTONUM-LEGACY");
    const { id: src } = await h.makeTable(baseId, "数据表 1");
    for (let i = 0; i < 3; i += 1) await seedRawTable(baseId, "数据表 1 副本");

    const res = await h.request("POST", `/tables/${src}/duplicate`);
    expect(res.status).toBe(201);
    expect((await json(res)).table.name).toBe("数据表 1 副本 2");
    // 再复制一次 → 3（排号从当前占用情况现算）
    const twice = await h.request("POST", `/tables/${src}/duplicate`);
    expect(twice.status).toBe(201);
    expect((await json(twice)).table.name).toBe("数据表 1 副本 3");
  });

  it("首次复制（无同名副本）→ 默认名就是「X 副本」", async () => {
    const baseId = await h.makeBase("COPY-FIRST");
    const { id: src } = await h.makeTable(baseId, "源表");
    const res = await h.request("POST", `/tables/${src}/duplicate`);
    expect(res.status).toBe(201);
    expect((await json(res)).table.name).toBe("源表 副本");
  });

  it("显式传一个已存在的名字复制 → 409，且不产生新表", async () => {
    const baseId = await h.makeBase("COPY-EXPLICIT");
    const { id: src } = await h.makeTable(baseId, "源表X");
    await h.makeTable(baseId, "被占用");

    const before = await liveCount(baseId);
    const res = await h.request("POST", `/tables/${src}/duplicate`, { name: "被占用" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("表名「被占用」已存在");
    expect(await liveCount(baseId)).toBe(before);
    expect(await namesOf(baseId)).toEqual(["源表X", "被占用"].sort());
  });

  it("显式传新名字复制 → 201，落库按 trim 后的名字", async () => {
    const baseId = await h.makeBase("COPY-EXPLICIT-OK");
    const { id: src } = await h.makeTable(baseId, "源表Y");
    const res = await h.request("POST", `/tables/${src}/duplicate`, { name: "  明确新名  " });
    expect(res.status).toBe(201);
    expect((await json(res)).table.name).toBe("明确新名");
    expect(await namesOf(baseId)).toEqual(["源表Y", "明确新名"].sort());
  });

  it("自动排号不受其它库同名表影响（作用域隔离）", async () => {
    const b1 = await h.makeBase("COPY-SCOPE-A");
    const b2 = await h.makeBase("COPY-SCOPE-B");
    const { id: src } = await h.makeTable(b1, "共享表");
    await seedRawTable(b2, "共享表 副本");

    const res = await h.request("POST", `/tables/${src}/duplicate`);
    expect(res.status).toBe(201);
    expect((await json(res)).table.name).toBe("共享表 副本");
  });
});

// ============ 5) 存量重复不受影响 ============

describe("存量重复表不被自动改名或清理", () => {
  it("已存在的同名表在读接口里照常全部返回（只拦写路径）", async () => {
    const baseId = await h.makeBase("LEGACY-DUP");
    await seedRawTable(baseId, "老重复");
    await seedRawTable(baseId, "老重复");
    const list = await json(await h.request("GET", `/tables?baseId=${baseId}`));
    expect(list.tables.filter((t: any) => t.name === "老重复").length).toBe(2);
  });
});

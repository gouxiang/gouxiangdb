// GET /api/records/:recordId/changes 端到端测试（真迁移临时库 + 真 records 路由）。
// 只 mock JWT 的 getUserId（可变 currentUserId），守卫/写队列/事务/迁移全是真的——变更历史挂在
// 真实主写事务里，用假 db 测不出「与主写共生死」这层语义。开关 GX_RECORD_CHANGES 运行时读 env，
// 故本文件可在进程内切开关。夹具见 _recordChangesHarness.ts；纯函数层见 diff.test.ts。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_ID,
  VIEWER_ID,
  setupRecordChangesHarness,
  type RecordChangesHarness,
} from "./_recordChangesHarness.js";

let currentUserId: string | null = OWNER_ID;
// 只替换 getUserId，其余导出保留真身（路由装配要用 auth.js 的其它件）。
vi.mock("../../auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: RecordChangesHarness;

beforeAll(async () => {
  process.env.GX_RECORD_CHANGES = "on";
  h = await setupRecordChangesHarness();
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(() => {
  currentUserId = OWNER_ID;
  process.env.GX_RECORD_CHANGES = "on";
});

// ============ 1) 写侧：create / update ============

describe("写入侧：create / update", () => {
  it("新建一条记录 → 一条 create 条目，changes 含初始值（before 恒 null）", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲", [t.fSel]: "opt_todo" });

    const rows = await h.rawChanges(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("create");
    expect(rows[0]!.actorId).toBe(OWNER_ID);
    expect(rows[0]!.actorName).toBe("U1");
    expect(rows[0]!.tableId).toBe(t.tableId);
    expect(JSON.parse(rows[0]!.changes)).toEqual([
      { fieldId: t.fName, fieldName: "名称", before: null, after: "甲" },
      { fieldId: t.fSel, fieldName: "状态", before: null, after: "opt_todo" },
    ]);
  });

  it("改两个字段 → 一条 update，changes 恰好这两个字段且前后值正确", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲", [t.fNote]: "原备注", [t.fSel]: "opt_todo" });
    await h.patchRecord(id, { [t.fName]: "乙", [t.fSel]: "opt_done" });

    const rows = await h.rawChanges(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.op).toBe("update");
    expect(JSON.parse(rows[1]!.changes)).toEqual([
      { fieldId: t.fName, fieldName: "名称", before: "甲", after: "乙" },
      { fieldId: t.fSel, fieldName: "状态", before: "opt_todo", after: "opt_done" },
    ]);
  });

  it("只改一个字段时，其它字段不出现在 changes 里", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲", [t.fNote]: "原备注", [t.fSel]: "opt_todo" });
    await h.patchRecord(id, { [t.fName]: "乙" });

    const rows = await h.rawChanges(id);
    expect(rows).toHaveLength(2);
    const parsed = JSON.parse(rows[1]!.changes);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ fieldId: t.fName, fieldName: "名称", before: "甲", after: "乙" });
  });

  it("写入重复值（值没变）不落行：空转写不进日志", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.patchRecord(id, { [t.fName]: "甲" });
    const rows = await h.rawChanges(id);
    expect(rows).toHaveLength(1); // 只有 create
  });
});

// ============ 2) 写侧：delete / restore ============
describe("写入侧：delete / restore", () => {
  it("删除 → delete 条目且 changes 为 []；恢复 → restore 条目", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });

    const del = await h.request("DELETE", `/records/${id}`);
    expect(del.status).toBe(200);
    let rows = await h.rawChanges(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.op).toBe("delete");
    expect(JSON.parse(rows[1]!.changes)).toEqual([]);

    const rst = await h.request("POST", `/records/trash/${id}/restore`, { kind: "record" });
    expect(rst.status).toBe(200);
    rows = await h.rawChanges(id);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.op).toBe("restore");
    expect(JSON.parse(rows[2]!.changes)).toEqual([]);
    expect(rows[2]!.actorId).toBe(OWNER_ID);
  });
});

// ============ 3) 读端点 ============
describe("读端点 GET /records/:recordId/changes", () => {
  it("返回 items/nextCursor/hasMore，按时间倒序（新的在前）", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.patchRecord(id, { [t.fName]: "乙" });
    await h.patchRecord(id, { [t.fName]: "丙" });

    const body = await h.changes(id);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((x: any) => x.op)).toEqual(["update", "update", "create"]);
    expect(body.items[0]!.changes[0]).toMatchObject({ fieldName: "名称", before: "乙", after: "丙" });
    expect(body.items[2]!.changes[0]).toMatchObject({ fieldName: "名称", before: null, after: "甲" });
    expect(Number.isNaN(Date.parse(body.items[0]!.changedAt))).toBe(false);
  });

  it("软删记录的 /changes 仍能读到（这是关键用例：要看「谁删的」）", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.patchRecord(id, { [t.fName]: "乙" });
    await h.request("DELETE", `/records/${id}`);

    // 与详情 GET /records/:id 的口径刻意不同：历史端点不判 deletedAt。
    const rec = await h.prisma.record.findUnique({ where: { id } });
    expect(rec?.deletedAt).not.toBeNull();

    const body = await h.changes(id);
    expect(body.items.map((x: any) => x.op)).toEqual(["delete", "update", "create"]);
    expect(body.items[0]!.changes).toEqual([]);
    expect(body.items[0]!.actorName).toBe("U1");
  });

  it("选项字段的 before/after 是选项名，绝不吐 optionId", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲", [t.fSel]: "opt_todo" });
    await h.patchRecord(id, { [t.fSel]: "opt_done" });

    const body = await h.changes(id);
    const all = JSON.stringify(body.items);
    expect(all).not.toContain("opt_todo");
    expect(all).not.toContain("opt_done");
    expect(body.items[0]!.changes[0]).toMatchObject({ before: "待办", after: "完成" });
    const created = body.items[1]!.changes as Array<{ after: unknown }>;
    expect(created.some((c) => c.after === "待办")).toBe(true);
  });

  it("记录不存在 → 404；无权用户 → 403", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    expect((await h.request("GET", "/records/nope/changes")).status).toBe(404);

    currentUserId = "u3-ghost";
    expect((await h.request("GET", `/records/${id}/changes`)).status).toBe(403);
  });
});

// ============ 4) 字段权限两层掩码 ============

describe("字段掩码", () => {
  it("被掩码字段从 changes 剔除；只剩被掩码字段的条目整条消失", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    // ① 一次变更同时动了可见字段与隐藏字段 → 隐藏字段被剔除，可见字段保留
    await h.patchRecord(id, { [t.fName]: "乙", [t.fSecret]: "机密" });
    // ② 一次变更只动了隐藏字段 → 整条不返回
    await h.patchRecord(id, { [t.fSecret]: "绝密" });
    await h.grantMaskedViewer(t.baseId, t.tableId, t.fSecret);

    currentUserId = OWNER_ID;
    const asOwner = await h.changes(id);
    expect(asOwner.items).toHaveLength(3); // update(密级) + update(名称+密级) + create

    currentUserId = VIEWER_ID;
    const asViewer = await h.changes(id);
    // 只动密级的那条整体消失；同时动了两字段的那条只剩「名称」
    expect(asViewer.items).toHaveLength(2);
    const serialized = JSON.stringify(asViewer.items);
    expect(serialized).not.toContain("机密");
    expect(serialized).not.toContain("绝密");
    expect(serialized).not.toContain("密级");
    expect(asViewer.items[0]!.changes).toEqual([
      { fieldId: t.fName, fieldName: "名称", before: "甲", after: "乙" },
    ]);
  });

  it("delete/restore 豁免「过滤后为空则整条消失」（它们本就恒空）", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲", [t.fSecret]: "机密" });
    await h.request("DELETE", `/records/${id}`);
    await h.grantMaskedViewer(t.baseId, t.tableId, t.fSecret);

    currentUserId = VIEWER_ID;
    const body = await h.changes(id);
    expect(body.items.map((x: any) => x.op)).toEqual(["delete", "create"]);
    expect(body.items[0]!.changes).toEqual([]);
    expect(body.items[1]!.changes).toEqual([
      { fieldId: t.fName, fieldName: "名称", before: null, after: "甲" },
    ]);
  });
});

// ============ 5) 开关与分页 ============
describe("开关与分页", () => {
  it("GX_RECORD_CHANGES 显式 off 时不写表（零行）", async () => {
    const t = await h.makeTableWithFields();
    // 开关已翻成默认开启，故这里**必须显式 off** 才成立（旧语义下不设即关，现在不行了）
    process.env.GX_RECORD_CHANGES = "off";
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.patchRecord(id, { [t.fName]: "乙" });
    // 只断言本次记录没有历史行：库是本文件共享的，前面用例留下的行不算数
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(0);
    // 读端点仍然可用（只是没历史），不 500
    const body = await h.changes(id);
    expect(body.items).toEqual([]);
  });

  // 「开关开启但历史写入失败 → 主写仍成功」的旁路验收单独成文件 recordChangesBypass.test.ts
  //（它要临时把历史表改名，不该与常规用例共用同一个临时库）。

  it("limit/cursor 翻页正确，且严格倒序", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    // 把 create 条目钉到 1 小时前，使下面 5 条播种严格更新。
    // 旧实现把种子播在硬编码的未来日期（2026-10-10），一旦墙钟越过该日期，
    // create 的「甲」反而最新、排序翻转，断言确定性失败（日期炸弹）。全部改为相对过去时刻。
    await h.prisma.recordChange.updateMany({
      where: { recordId: id, op: "create" },
      data: { changedAt: new Date(Date.now() - 3600_000) },
    });
    // 直接播种 5 条不同时刻的历史（相对墙钟、间隔 1s，不依赖毫秒精度，翻页断言才稳定）
    const base = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      await h.prisma.recordChange.create({
        data: {
          tableId: t.tableId, recordId: id, op: "update", actorId: OWNER_ID, actorName: "U1",
          changedAt: new Date(base + i * 1000),
          changes: JSON.stringify([
            { fieldId: t.fName, fieldName: "名称", before: `v${i}`, after: `v${i + 1}` },
          ]),
        },
      });
    }

    const p1 = await h.changes(id, "?limit=2");
    expect(p1.items.map((x: any) => x.changes[0].after)).toEqual(["v5", "v4"]);
    expect(p1.hasMore).toBe(true);
    expect(typeof p1.nextCursor).toBe("string");

    const p2 = await h.changes(id, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`);
    expect(p2.items.map((x: any) => x.changes[0].after)).toEqual(["v3", "v2"]);
    expect(p2.hasMore).toBe(true);

    // 末页：还剩播种的 v1 与更早的 create 条目（after="甲"）
    const p3 = await h.changes(id, `?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`);
    expect(p3.items.map((x: any) => x.changes[0].after)).toEqual(["v1", "甲"]);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
  });

  it("limit 上限 200、缺省 50；坏游标 400", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    const big = await h.changes(id, "?limit=9999");
    expect(big.items.length).toBeLessThanOrEqual(200);
    const bad = await h.request("GET", `/records/${id}/changes?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
  });
});

// ============ 6) 清理联动 ============
describe("purge 清理", () => {
  it("记录物理删 → 历史行一并清掉，不留悬挂", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.patchRecord(id, { [t.fName]: "乙" });
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(2);

    await h.request("DELETE", `/records/${id}`);
    const purge = await h.request("DELETE", `/records/trash/${id}?kind=record`);
    expect(purge.status).toBe(200);
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(0);
  });

  it("表物理删 → 该表全部历史按 tableId 清掉", async () => {
    const t = await h.makeTableWithFields();
    await h.createRecord(t.tableId, { [t.fName]: "甲" });
    expect(await h.prisma.recordChange.count({ where: { tableId: t.tableId } })).toBe(1);

    const purge = await h.request("DELETE", `/records/trash/${t.tableId}?kind=table`);
    expect(purge.status).toBe(200);
    expect(await h.prisma.recordChange.count({ where: { tableId: t.tableId } })).toBe(0);
  });
});

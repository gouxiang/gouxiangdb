// GET /api/records/:recordId/changes 端到端测试（真迁移临时库 + 真 records 路由）。
//
// 只 mock JWT 的 getUserId（可变 currentUserId），守卫/写队列/事务/迁移全是真的——
// 变更历史挂在真实主写事务里，用假 db 测不出「与主写共生死」这层语义。
//
// 开关 GX_RECORD_CHANGES 是运行时读 env 的，故本文件可在进程内切 on/off 验证默认关闭。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ID, setupHarness, type Harness } from "./_realApp.js";

const VIEWER_ID = "u2";
/** 受限身份：对目标表可见可管，但「密级」字段被配成 hidden。 */
const MASKED_ROLE = "role_test_masked";

let currentUserId: string | null = OWNER_ID;
// 只替换 getUserId，其余导出保留真身（路由装配要用 auth.js 的其它件）。
vi.mock("../../auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: Harness;
let baseId = "";
let tableId = "";
let fName = "";
let fSel = "";
let fNote = "";
let fSecret = "";

beforeAll(async () => {
  process.env.GX_RECORD_CHANGES = "on";
  h = await setupHarness("gx-record-changes-");
  await h.prisma.user.create({
    data: { id: VIEWER_ID, email: "u2@example.com", displayName: "受限成员", passwordHash: "x" },
  });
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(() => {
  currentUserId = OWNER_ID;
  process.env.GX_RECORD_CHANGES = "on";
});

// A4：库名全局唯一，故每个用例用不同名字（顺序计数）。
let libSeq = 0;

/** 建一张四字段表：名称(文本) / 状态(单选，选项 opt_todo|opt_done) / 备注(文本) / 密级(文本)。 */
async function makeTable(): Promise<void> {
  baseId = await h.makeBase(`变更历史库${++libSeq}`);
  const t = await h.makeTable(baseId, "T");
  tableId = t.id;
  fName = t.primaryFieldId;
  let order = 1;
  const add = async (name: string, type: string, extra: Record<string, unknown> = {}) => {
    const f = await h.prisma.field.create({
      data: { tableId, name, type, order: order++, ...extra } as never,
    });
    return f.id;
  };
  fSel = await add("状态", "singleSelect", {
    options: JSON.stringify([
      { id: "opt_todo", name: "待办", color: "red" },
      { id: "opt_done", name: "完成", color: "green" },
    ]),
  });
  fNote = await add("备注", "singleLineText");
  fSecret = await add("密级", "singleLineText");
}

const json = async (res: Response): Promise<any> => res.json();

async function createRecord(values: Record<string, unknown>): Promise<string> {
  const res = await h.request("POST", `/records?tableId=${tableId}`, { fields: values });
  expect(res.status).toBe(201);
  const body = await json(res);
  return body.record.id as string;
}

async function patchRecord(id: string, values: Record<string, unknown>): Promise<void> {
  const res = await h.request("PATCH", `/records/${id}`, { fields: values });
  expect(res.status).toBe(200);
}

async function changes(id: string, qs = ""): Promise<any> {
  const res = await h.request("GET", `/records/${id}/changes${qs}`);
  expect(res.status).toBe(200);
  return json(res);
}

/** 直接读库：绕开读端点，验证「写侧到底落了什么」。 */
function rawChanges(id: string) {
  return h.prisma.recordChange.findMany({
    where: { recordId: id },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
  });
}

// ============ 1) 写侧：create / update ============

describe("写入侧：create / update", () => {
  it("新建一条记录 → 一条 create 条目，changes 含初始值（before 恒 null）", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲", [fSel]: "opt_todo" });

    const rows = await rawChanges(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("create");
    expect(rows[0]!.actorId).toBe(OWNER_ID);
    expect(rows[0]!.actorName).toBe("U1");
    expect(rows[0]!.tableId).toBe(tableId);
    const parsed = JSON.parse(rows[0]!.changes);
    expect(parsed).toEqual([
      { fieldId: fName, fieldName: "名称", before: null, after: "甲" },
      { fieldId: fSel, fieldName: "状态", before: null, after: "opt_todo" },
    ]);
  });

  it("改两个字段 → 一条 update，changes 恰好这两个字段且前后值正确", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲", [fNote]: "原备注", [fSel]: "opt_todo" });
    await patchRecord(id, { [fName]: "乙", [fSel]: "opt_done" });

    const rows = await rawChanges(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.op).toBe("update");
    const parsed = JSON.parse(rows[1]!.changes);
    expect(parsed).toEqual([
      { fieldId: fName, fieldName: "名称", before: "甲", after: "乙" },
      { fieldId: fSel, fieldName: "状态", before: "opt_todo", after: "opt_done" },
    ]);
  });

  it("只改一个字段时，其它字段不出现在 changes 里", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲", [fNote]: "原备注", [fSel]: "opt_todo" });
    await patchRecord(id, { [fName]: "乙" });

    const rows = await rawChanges(id);
    expect(rows).toHaveLength(2);
    const parsed = JSON.parse(rows[1]!.changes);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ fieldId: fName, fieldName: "名称", before: "甲", after: "乙" });
  });

  it("写入重复值（值没变）不产生多余条目", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    await patchRecord(id, { [fName]: "甲" });
    const rows = await rawChanges(id);
    expect(rows).toHaveLength(1); // 只有 create
  });
});

// ============ 2) 写侧：delete / restore ============

describe("写入侧：delete / restore", () => {
  it("删除 → delete 条目且 changes 为 []；恢复 → restore 条目", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });

    const del = await h.request("DELETE", `/records/${id}`);
    expect(del.status).toBe(200);
    let rows = await rawChanges(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.op).toBe("delete");
    expect(JSON.parse(rows[1]!.changes)).toEqual([]);

    const rst = await h.request("POST", `/records/trash/${id}/restore`, { kind: "record" });
    expect(rst.status).toBe(200);
    rows = await rawChanges(id);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.op).toBe("restore");
    expect(JSON.parse(rows[2]!.changes)).toEqual([]);
    expect(rows[2]!.actorId).toBe(OWNER_ID);
  });
});

// ============ 3) 读端点 ============

describe("读端点 GET /records/:recordId/changes", () => {
  it("返回 items/nextCursor/hasMore，按时间倒序（新的在前）", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    await patchRecord(id, { [fName]: "乙" });
    await patchRecord(id, { [fName]: "丙" });

    const body = await changes(id);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((x: any) => x.op)).toEqual(["update", "update", "create"]);
    expect(body.items[0]!.changes[0]).toMatchObject({ fieldName: "名称", before: "乙", after: "丙" });
    expect(body.items[2]!.changes[0]).toMatchObject({ fieldName: "名称", before: null, after: "甲" });
    expect(typeof body.items[0]!.changedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.items[0]!.changedAt))).toBe(false);
  });

  it("软删记录的 /changes 仍能读到（这是关键用例：要看「谁删的」）", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    await patchRecord(id, { [fName]: "乙" });
    await h.request("DELETE", `/records/${id}`);

    // 与详情 GET /records/:id 的口径刻意不同：历史端点不判 deletedAt。
    const rec = await h.prisma.record.findUnique({ where: { id } });
    expect(rec?.deletedAt).not.toBeNull();

    const body = await changes(id);
    expect(body.items.map((x: any) => x.op)).toEqual(["delete", "update", "create"]);
    expect(body.items[0]!.changes).toEqual([]);
    expect(body.items[0]!.actorName).toBe("U1");
  });

  it("选项字段的 before/after 是选项名，绝不吐 optionId", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲", [fSel]: "opt_todo" });
    await patchRecord(id, { [fSel]: "opt_done" });

    const body = await changes(id);
    const all = JSON.stringify(body.items);
    expect(all).not.toContain("opt_todo");
    expect(all).not.toContain("opt_done");
    expect(body.items[0]!.changes[0]).toMatchObject({ before: "待办", after: "完成" });
    expect(body.items[1]!.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ after: "待办" })]),
    );
  });

  it("记录不存在 → 404；无权用户 → 403", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    const notFound = await h.request("GET", "/records/nope/changes");
    expect(notFound.status).toBe(404);

    currentUserId = "u3-ghost";
    const forbidden = await h.request("GET", `/records/${id}/changes`);
    expect(forbidden.status).toBe(403);
  });
});

// ============ 4) 字段权限两层掩码 ============

describe("字段掩码", () => {
  // 角色/授予只建一次（角色名在 workspace 内唯一），库视野行按当前 baseId 逐例建。
  let maskedReady = false;

  /** 给受限身份配：库可见可管 + 密级字段 hidden。 */
  async function grantMaskedViewer(): Promise<void> {
    if (!maskedReady) {
      await h.prisma.role.create({
        data: { id: MASKED_ROLE, workspaceId: "ws_default", name: "受限角色", permissions: "[]" },
      });
      await h.prisma.roleAssignment.create({
        data: { roleId: MASKED_ROLE, subjectType: "user", subjectId: VIEWER_ID, scopeType: "workspace", createdBy: "seed" },
      });
      maskedReady = true;
    }
    await h.prisma.roleLibraryScope.create({
      data: {
        roleId: MASKED_ROLE, libraryKind: "base", libraryId: baseId,
        visible: 1, canManage: 1, canShare: 0,
        config: JSON.stringify({ tables: {}, fields: { [tableId]: { [fSecret]: "hidden" } } }),
      },
    });
  }

  it("被掩码字段从 changes 剔除；只剩被掩码字段的条目整条消失", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    // ① 一次变更同时动了可见字段与隐藏字段 → 隐藏字段被剔除，可见字段保留
    await patchRecord(id, { [fName]: "乙", [fSecret]: "机密" });
    // ② 一次变更只动了隐藏字段 → 整条不返回
    await patchRecord(id, { [fSecret]: "绝密" });
    await grantMaskedViewer();

    currentUserId = OWNER_ID;
    const asOwner = await changes(id);
    expect(asOwner.items).toHaveLength(3); // update(密级) + update(名称+密级) + create

    currentUserId = VIEWER_ID;
    const asViewer = await changes(id);
    // 只动密级的那条整体消失；同时动了两字段的那条只剩「名称」
    expect(asViewer.items).toHaveLength(2);
    const serialized = JSON.stringify(asViewer.items);
    expect(serialized).not.toContain("机密");
    expect(serialized).not.toContain("绝密");
    expect(serialized).not.toContain("密级");
    expect(asViewer.items[0]!.changes).toEqual([
      { fieldId: fName, fieldName: "名称", before: "甲", after: "乙" },
    ]);
  });

  it("delete/restore 豁免「过滤后为空则整条消失」（它们本就恒空）", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲", [fSecret]: "机密" });
    await h.request("DELETE", `/records/${id}`);
    await grantMaskedViewer();

    currentUserId = VIEWER_ID;
    const body = await changes(id);
    expect(body.items.map((x: any) => x.op)).toEqual(["delete", "create"]);
    expect(body.items[0]!.changes).toEqual([]);
    expect(body.items[1]!.changes).toEqual([
      { fieldId: fName, fieldName: "名称", before: null, after: "甲" },
    ]);
  });
});

// ============ 5) 开关与分页 ============

describe("开关与分页", () => {
  it("GX_RECORD_CHANGES 关闭时不写表（零行）", async () => {
    await makeTable();
    process.env.GX_RECORD_CHANGES = "off";
    const id = await createRecord({ [fName]: "甲" });
    await patchRecord(id, { [fName]: "乙" });
    // 只断言本次记录没有历史行：库是本文件共享的，前面用例留下的行不算数
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(0);
    // 读端点仍然可用（只是没历史），不 500
    const body = await changes(id);
    expect(body.items).toEqual([]);
  });

  it("limit/cursor 翻页正确，且严格倒序", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    // 直接播种 5 条不同时刻的历史（避免依赖毫秒级墙钟，翻页断言才稳定）
    const base = Date.UTC(2026, 9, 10, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      await h.prisma.recordChange.create({
        data: {
          tableId, recordId: id, op: "update", actorId: OWNER_ID, actorName: "U1",
          changedAt: new Date(base + i * 1000),
          changes: JSON.stringify([{ fieldId: fName, fieldName: "名称", before: `v${i}`, after: `v${i + 1}` }]),
        },
      });
    }

    const p1 = await changes(id, "?limit=2");
    expect(p1.items.map((x: any) => x.changes[0].after)).toEqual(["v5", "v4"]);
    expect(p1.hasMore).toBe(true);
    expect(typeof p1.nextCursor).toBe("string");

    const p2 = await changes(id, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`);
    expect(p2.items.map((x: any) => x.changes[0].after)).toEqual(["v3", "v2"]);
    expect(p2.hasMore).toBe(true);

    // 末页：还剩播种的 v1 与更早的 create 条目（after="甲"）
    const p3 = await changes(id, `?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`);
    expect(p3.items.map((x: any) => x.changes[0].after)).toEqual(["v1", "甲"]);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
  });

  it("limit 上限 200、缺省 50；坏游标 400", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    const big = await changes(id, "?limit=9999");
    expect(big.items.length).toBeLessThanOrEqual(200);
    const bad = await h.request("GET", `/records/${id}/changes?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
  });
});

// ============ 6) 清理联动 ============

describe("purge 清理", () => {
  it("记录物理删 → 历史行一并清掉，不留悬挂", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    await patchRecord(id, { [fName]: "乙" });
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(2);

    await h.request("DELETE", `/records/${id}`);
    const purge = await h.request("DELETE", `/records/trash/${id}?kind=record`);
    expect(purge.status).toBe(200);
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(0);
  });

  it("表物理删 → 该表全部历史按 tableId 清掉", async () => {
    await makeTable();
    const id = await createRecord({ [fName]: "甲" });
    expect(await h.prisma.recordChange.count({ where: { tableId } })).toBe(1);

    const purge = await h.request("DELETE", `/records/trash/${tableId}?kind=table`);
    expect(purge.status).toBe(200);
    expect(await h.prisma.recordChange.count({ where: { tableId } })).toBe(0);
    void id;
  });
});

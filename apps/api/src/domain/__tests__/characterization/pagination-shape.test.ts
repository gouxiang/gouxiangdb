// M1/S0 Characterization：GET /records 列表 JSON 现状
//
// 直接驱动真实路由模块 records（Hono 实例）+ 内存 fake prisma，不碰真实 SQLite/JWT，
// 把列表响应的【顶层键集合、每条记录形状、分页 slice 口径、total 口径】钉死，
// 供 M1 S7 keyset 接入做 additive 对照（S7 只能新增游标字段，不得改变现有键语义）。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// ---- 内存态 ----
interface FakeRecordRow {
  id: string;
  tableId: string;
  fields: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: Date | null;
}

let recRows: FakeRecordRow[] = [];
let fieldRows: Record<string, unknown>[] = [];

vi.mock("../../../auth.js", () => ({
  // 跳过 JWT：恒为已登录用户 u1
  getUserId: () => Promise.resolve("u1"),
}));

// 写门面在 GET 路径不被调用；仍提供桩以忠实模拟 db 模块导出形态
vi.mock("../../../db.js", () => ({
  withWriteTx: async () => null,
  withWriteBatch: async () => undefined,
  runWrite: async () => null,
  prisma: {
    table: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === "T1" ? { baseId: "B1" } : null),
    },
    member: {
      // 权限核心模型（二）后 members.role 不再参与放行；保留桩只为不破坏旧断言形态。
      findUnique: () => Promise.resolve({ role: "editor" }),
    },
    // 新放行链只走「角色 × 库」：effectiveRoleRows 先查部门归属，再查授予行。
    // u1 无部门，直接给一条超级管理员授予 -> libraryPolicy 短路为全权，不再查视野表。
    deptMember: {
      findMany: () => Promise.resolve([]),
    },
    roleAssignment: {
      // effectiveRoleRows 用 include:{role:true} 取角色行，缺 role 会被整条跳过。
      findMany: () => Promise.resolve([{
        roleId: "role_owner", subjectType: "user", subjectId: "u1",
        role: { id: "role_owner", systemKey: "super_admin", name: "超级管理员", isSystem: 1, permissions: "[]", deletedAt: null },
      }]),
    },
    field: {
      findMany: () => Promise.resolve(fieldRows),
    },
    view: {
      findUnique: () => Promise.resolve(null), // 不带 viewId 时路由本不调用；桩 null
    },
    record: {
      findMany: (args: { where?: { tableId?: string; deletedAt?: unknown } }) => {
        const where = args.where ?? {};
        const filterDeleted = "deletedAt" in where;
        const out = recRows
          .filter(
            (r) =>
              (!where.tableId || r.tableId === where.tableId) &&
              (!filterDeleted || where.deletedAt === null ? r.deletedAt === null : true),
          )
          .map((r) => ({ ...r }));
        out.sort((a, b) => {
          const ca = a.createdAt.getTime();
          const cb = b.createdAt.getTime();
          return ca !== cb ? ca - cb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return Promise.resolve(out);
      },
    },
  },
}));

const { records: recordsRoute } = await import("../../../routes/records.js");
const { errorResponse } = await import("../../../guards.js");

// 真实路由 + 统一错误出口（与 index.ts 一致），使 HttpError 产出真实状态码/信封
function buildApp() {
  const app = new Hono();
  app.route("/records", recordsRoute);
  app.onError((err, c) => errorResponse(c, err));
  return app;
}

function rawField(p: { id: string; name: string; type: string; order: number }) {
  return {
    tableId: "T1",
    description: "",
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    recordFilter: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...p,
  };
}

beforeEach(() => {
  fieldRows = [
    rawField({ id: "f_name", name: "名称", type: "singleLineText", order: 0 }),
    rawField({ id: "f_age", name: "年龄", type: "number", order: 1 }),
  ];
  recRows = [
    {
      id: "r1", tableId: "T1", fields: JSON.stringify({ f_name: "甲", f_age: 10 }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdBy: null, updatedBy: null, deletedAt: null,
    },
    {
      id: "r2", tableId: "T1", fields: JSON.stringify({ f_name: "乙", f_age: 20 }),
      createdAt: new Date("2026-02-01T00:00:00.000Z"), updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      createdBy: null, updatedBy: null, deletedAt: null,
    },
    {
      id: "r3", tableId: "T1", fields: JSON.stringify({ f_name: "丙", f_age: 30 }),
      createdAt: new Date("2026-03-01T00:00:00.000Z"), updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      createdBy: null, updatedBy: null, deletedAt: null,
    },
  ];
});

describe("GET /records 列表形状", () => {
  it("无 tableId → 400 且错误信封为 {error}", async () => {
    const res = await buildApp().request("/records");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "缺少 tableId" });
  });

  it("不存在的 tableId → 404 统一信封（error + code）", async () => {
    const res = await buildApp().request("/records?tableId=NOPE");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: "数据表不存在", code: "NOT_FOUND" });
  });

  it("200：顶层七键、记录逐行形状、默认 (createdAt,id) 顺序", async () => {
    const res = await buildApp().request("/records?tableId=T1");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      ["aggregations", "allFields", "fields", "filteredTotal", "groups", "records", "total"],
    );
    expect(body.total).toBe(3);
    expect(body.filteredTotal).toBe(3);
    expect(body.groups).toBeNull();
    expect(body.aggregations).toBeNull();

    expect(body.records.map((r: { id: string }) => r.id)).toEqual(["r1", "r2", "r3"]);
    const r1 = body.records[0];
    expect(Object.keys(r1).sort()).toEqual(
      ["createdAt", "createdBy", "fields", "id", "tableId", "updatedAt", "updatedBy"],
    );
    expect(r1).toMatchObject({
      id: "r1",
      tableId: "T1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: null,
      updatedBy: null,
      fields: { f_name: "甲", f_age: 10 },
    });
  });

  it("fields=可见字段、allFields=全字段；无视图配置时两者等长且为 FieldMeta", async () => {
    const body = await (await buildApp().request("/records?tableId=T1")).json();
    expect(body.allFields).toHaveLength(2);
    expect(body.fields).toHaveLength(2);
    expect(body.fields.map((f: { id: string }) => f.id)).toEqual(["f_name", "f_age"]);
    expect(body.fields[0]).toMatchObject({ id: "f_name", name: "名称", type: "singleLineText" });
  });

  it("内存假分页：limit/offset 切 records，但 total/filteredTotal 仍是全量", async () => {
    const body = await (await buildApp().request("/records?tableId=T1&limit=1&offset=1")).json();
    expect(body.records.map((r: { id: string }) => r.id)).toEqual(["r2"]);
    expect(body.total).toBe(3);
    expect(body.filteredTotal).toBe(3);
  });

  it("【现状】非法 limit/offset 回退默认（limit=200,offset=0），不报错", async () => {
    const body = await (await buildApp().request("/records?tableId=T1&limit=abc&offset=xyz")).json();
    expect(body.records).toHaveLength(3);
  });

  it("【现状】软删行不进列表（findMany deletedAt:null）", async () => {
    recRows.push({
      id: "r9", tableId: "T1", fields: JSON.stringify({ f_name: "删" }),
      createdAt: new Date("2026-04-01T00:00:00.000Z"), updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      createdBy: null, updatedBy: null, deletedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const body = await (await buildApp().request("/records?tableId=T1")).json();
    expect(body.total).toBe(3);
    expect(body.records.map((r: { id: string }) => r.id)).toEqual(["r1", "r2", "r3"]);
  });
});

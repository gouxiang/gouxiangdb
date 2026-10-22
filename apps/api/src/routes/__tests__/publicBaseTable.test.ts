// apps/api/src/routes/__tests__/publicBaseTable.test.ts
// 库（base）分享链接作用域内的单表只读通道（HTTP 层，fake prisma，无真实 SQLite）：
//   - 外壳 GET /s/:baseToken 只列「shareEnabled=1 且自身有有效 table 分享链接」的表并带 token；
//   - GET /s/:baseToken/t/:tableId 与 /records 匿名只读，字段按【表分享创建者】权限裁剪；
//   - 越权/枚举（不属于该库、属于该库但未单独分享、失效 baseToken）一律 404；
//   - base 作用域读到的字段集与直接持 table token 调 /s/:tableToken 完全一致。
//
// 权限判定链（libraryPolicy -> shareCaps -> shareVisibleFields）跑【真实代码】，
// db / libraryVisibility 用 fake/mock；recordService 的取数部分用桩，聚焦路由作用域与字段裁剪。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";

// ---- 内存夹具 ----
interface FakeLink {
  id: string;
  token: string;
  objectType: "base" | "table";
  objectId: string | null;
  baseId: string;
  viewId: string | null;
  mode: string;
  role: string;
  createdBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}
interface FakeTable {
  id: string;
  baseId: string;
  name: string;
  shareEnabled: number;
  deletedAtMark?: boolean;
}

/** 远早于任何系统时钟的过期时刻，保证 expired() 判定不依赖本机当前日期。 */
const ANCIENT = new Date("2000-01-01T00:00:00.000Z");

const state: {
  links: FakeLink[];
  tables: FakeTable[];
  baseShareEnabled: number;
  /** 表分享创建者对各字段的权限（editable / visible / hidden）。 */
  fieldPerms: Record<string, string>;
  /** queryRecords 实际接收到的（已裁剪）字段 id，供断言隐藏字段未下推取数。 */
  lastQueriedFieldIds: string[] | null;
} = {
  links: [],
  tables: [],
  baseShareEnabled: 1,
  fieldPerms: { "f-ok": "editable", "f-hidden": "hidden" },
  lastQueriedFieldIds: null,
};

function link(p: Partial<FakeLink> & Pick<FakeLink, "id" | "token" | "objectType" | "baseId">): FakeLink {
  return {
    objectId: null,
    viewId: null,
    mode: "view",
    role: "viewer",
    createdBy: "uSharer",
    expiresAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...p,
  };
}

function reset() {
  state.links = [];
  state.tables = [];
  state.baseShareEnabled = 1;
  state.fieldPerms = { "f-ok": "editable", "f-hidden": "hidden" };
  state.lastQueriedFieldIds = null;
}

// ---- fake prisma ----
vi.mock("../../db.js", () => ({
  prisma: {
    shareLink: {
      findUnique: ({ where }: { where: { token: string } }) =>
        Promise.resolve(state.links.find((l) => l.token === where.token) ?? null),
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          state.links.filter((l) => {
            if (where.objectType && l.objectType !== where.objectType) return false;
            const objId = where.objectId as { in?: string[] } | undefined;
            if (objId && objId.in && (!l.objectId || !objId.in.includes(l.objectId))) return false;
            return true;
          }),
        ),
    },
    base: {
      findFirst: ({ where }: { where: { id: string } }) => {
        const b = state.links.some((l) => l.objectType === "base" && l.baseId === where.id);
        return Promise.resolve(b ? { id: where.id, name: "客户库", icon: null, iconColor: null } : null);
      },
    },
    // 令牌在 share_links 查不到时 resolveShareTarget 会回落查 kb_docs.share_token：
    // 本夹具没有文档令牌，一律返回 null（由解析侧统一 404）。
    kbDoc: { findFirst: () => Promise.resolve(null) },
    table: {
      // shareableTables 列表
      findMany: ({ where }: { where: { baseId: string; shareEnabled: number } }) =>
        Promise.resolve(
          state.tables
            .filter((t) => t.baseId === where.baseId && t.shareEnabled === where.shareEnabled && !t.deletedAtMark)
            .map((t) => ({ id: t.id, name: t.name, icon: null, createdAt: new Date("2026-09-01T00:00:00.000Z") })),
        ),
      // loadTable（table token 解析）
      findFirst: ({ where }: { where: { id: string } }) => {
        const t = state.tables.find((x) => x.id === where.id && !x.deletedAtMark);
        return Promise.resolve(
          t
            ? {
                id: t.id,
                name: t.name,
                icon: null,
                iconColor: null,
                primaryFieldId: "f-ok",
                baseId: t.baseId,
                base: { name: "客户库" },
              }
            : null,
        );
      },
    },
    view: { findFirst: () => Promise.resolve(null) },
  },
  withWriteTx: (_label: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
}));

// 取数层桩：字段全集（含隐藏列）由这里给出；shareVisibleFields（真实代码）负责裁剪，
// queryRecords 只应收到裁剪后的字段——借此证明隐藏字段既不在 fields 元数据、也不下推取数。
vi.mock("../../domain/recordService.js", () => ({
  loadTableFields: (tableId: string) =>
    Promise.resolve([
      { id: "f-ok", tableId, name: "公开列", type: "singleLineText" },
      { id: "f-hidden", tableId, name: "机密列", type: "singleLineText" },
    ]),
  parseViewConfig: () => ({}),
  visibleFields: (fields: unknown[]) => fields,
  queryRecords: (opts: { fields: Array<{ id: string }>; tableId: string }) => {
    state.lastQueriedFieldIds = opts.fields.map((f) => f.id);
    // 仅回填裁剪后字段的值；隐藏列的值根本不进入记录。
    const record = { id: "r1", tableId: opts.tableId, fields: {} as Record<string, unknown> };
    for (const f of opts.fields) record.fields[f.id] = `v-${f.id}`;
    return Promise.resolve({ records: [record], total: 1, filteredTotal: 1, groups: [], aggregations: {} });
  },
}));

vi.mock("../../domain/authz/libraryPolicy.js", () => ({
  // 表分享创建者 uSharer 的裁决：可见该表，但 f-hidden 对他隐藏。
  resolveBaseAccessByTable: (_userId: string, tableId: string) =>
    Promise.resolve({
      visible: true,
      canManage: false,
      canDeleteLibrary: false,
      canToggleShare: false,
      canShare: false,
      source: "role_scope",
      tables: { [tableId]: { read: true, create: false, update: false, delete: false } },
      fields: { [tableId]: state.fieldPerms },
    } as unknown as LibraryAccessDTO),
  tableAccessOf: (access: LibraryAccessDTO, tableId: string) =>
    (access.tables as Record<string, unknown>)[tableId] ?? { read: false, create: false, update: false, delete: false },
  fieldAccessOf: (access: LibraryAccessDTO, tableId: string, fieldId: string) =>
    ((access.fields as Record<string, Record<string, string>>)[tableId]?.[fieldId]) ?? "editable",
}));

vi.mock("../../domain/authz/libraryVisibility.js", () => ({
  // base 链接解析要求库级总闸开；表两级开关在本夹具里由 shareEnabled + baseShareEnabled 体现。
  tableShareAllowed: () => Promise.resolve(true),
  readShareEnabled: (kind: string, id: string) =>
    Promise.resolve(kind === "base" && id === "b1" ? state.baseShareEnabled === 1 : true),
}));

const { pub } = await import("../public.js");

beforeEach(reset);

// 标准夹具：库 b1 有三张表——tShared（有效表链接）、tExpired（表链接过期）、tUnshared（无链接）；
// 另有别的库 b2 的 tForeign（有自己的有效表链接），用于枚举/越权对拍。
function seedStandard() {
  state.links = [
    link({ id: "lb", token: "baseTok", objectType: "base", baseId: "b1", createdBy: "uOwner" }),
    link({ id: "lt1", token: "tblShared", objectType: "table", objectId: "tShared", baseId: "b1", createdBy: "uSharer" }),
    link({
      id: "lt2",
      token: "tblExpired",
      objectType: "table",
      objectId: "tExpired",
      baseId: "b1",
      createdBy: "uSharer",
      expiresAt: ANCIENT, // 已过期
    }),
    link({ id: "ltf", token: "tblForeign", objectType: "table", objectId: "tForeign", baseId: "b2", createdBy: "uSharer" }),
  ];
  state.tables = [
    { id: "tShared", baseId: "b1", name: "已分享表", shareEnabled: 1 },
    { id: "tExpired", baseId: "b1", name: "过期链接表", shareEnabled: 1 },
    { id: "tUnshared", baseId: "b1", name: "未分享表", shareEnabled: 1 },
    { id: "tForeign", baseId: "b2", name: "别的库的表", shareEnabled: 1 },
  ];
}

type Json = Record<string, unknown>;

async function get(url: string) {
  const res = await pub.request(url, { method: "GET" });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

const tableListOf = (b: Json): Array<{ id: string; token?: string }> =>
  (b.tables as Array<{ id: string; token?: string }>) ?? [];

// ============ 1a. 库外壳可分享表清单 ============

describe("GET /s/:baseToken 库外壳 tables 清单", () => {
  it("只列出 shareEnabled=1 且自身有有效 table 链接的表，并带 token", async () => {
    seedStandard();
    const r = await get("/s/baseTok");
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("base");
    const tables = tableListOf(r.body);
    expect(tables.map((t) => t.id)).toEqual(["tShared"]);
    expect(tables[0]!.token).toBe("tblShared");
  });

  it("过期链接的表不出现在清单", async () => {
    seedStandard();
    const r = await get("/s/baseTok");
    expect(tableListOf(r.body).map((t) => t.id)).not.toContain("tExpired");
  });

  it("无独立 table 链接（即使 shareEnabled=1）的表不出现，避免死胡同/枚举", async () => {
    seedStandard();
    const r = await get("/s/baseTok");
    expect(tableListOf(r.body).map((t) => t.id)).not.toContain("tUnshared");
  });

  it("表被关闭分享（shareEnabled=0）即便链接行还在也不出现", async () => {
    seedStandard();
    state.tables.find((t) => t.id === "tShared")!.shareEnabled = 0;
    const r = await get("/s/baseTok");
    expect(r.body.tables).toEqual([]);
  });

  it("撤销链接（删除 share_link 行）后该表立即从清单消失", async () => {
    seedStandard();
    state.links = state.links.filter((l) => l.token !== "tblShared");
    const r = await get("/s/baseTok");
    expect(r.body.tables).toEqual([]);
  });

  it("别的库的表链接不出现在本库外壳", async () => {
    seedStandard();
    const r = await get("/s/baseTok");
    expect(tableListOf(r.body).map((t) => t.id)).not.toContain("tForeign");
  });
});

// ============ 1b. base 作用域只读端点 ============

describe("GET /s/:baseToken/t/:tableId 表结构只读", () => {
  it("happy path：匿名 200，字段经表分享创建者权限裁剪（隐藏列不出现、不下推取数）", async () => {
    seedStandard();
    const r = await get("/s/baseTok/t/tShared");
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("table");
    expect(r.body.canEdit).toBe(false);
    const fieldIds = (r.body.fields as Array<{ id: string }>).map((f) => f.id);
    expect(fieldIds).toContain("f-ok");
    expect(fieldIds).not.toContain("f-hidden");
    // 隐藏列的值不出现在任何记录里，且取数层收到的字段集已被裁剪。
    expect(JSON.stringify(r.body.records)).not.toContain("f-hidden");
    expect(state.lastQueriedFieldIds).toEqual(["f-ok"]);
    expect(r.body.total).toBe(1);
  });

  it("records 翻页端点同样 200 且裁剪隐藏字段", async () => {
    seedStandard();
    const r = await get("/s/baseTok/t/tShared/records?limit=50&offset=0");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.records)).not.toContain("f-hidden");
    expect(state.lastQueriedFieldIds).toEqual(["f-ok"]);
  });

  it("与直接持 table token 调 /s/:tableToken 的字段集一致", async () => {
    seedStandard();
    const viaBase = await get("/s/baseTok/t/tShared");
    const direct = await get("/s/tblShared");
    expect(direct.status).toBe(200);
    const idsOf = (b: Record<string, any>) => (b.fields as Array<{ id: string }>).map((f) => f.id).sort();
    expect(idsOf(viaBase.body)).toEqual(idsOf(direct.body));
    expect(viaBase.body.records).toEqual(direct.body.records);
    expect(viaBase.body.canEdit).toBe(direct.body.canEdit);
  });

  it("访问不属于该库的 tableId（别库的表）-> 404", async () => {
    seedStandard();
    const r = await get("/s/baseTok/t/tForeign");
    expect(r.status).toBe(404);
  });

  it("访问属于该库但未单独分享的表 -> 404", async () => {
    seedStandard();
    const a = await get("/s/baseTok/t/tUnshared");
    expect(a.status).toBe(404);
    const b = await get("/s/baseTok/t/tExpired"); // 链接过期
    expect(b.status).toBe(404);
  });

  it("根本不存在的 tableId -> 404（与未分享同口径，不泄漏存在性）", async () => {
    seedStandard();
    const r = await get("/s/baseTok/t/ghost");
    expect(r.status).toBe(404);
  });

  it("records 端点对未分享表同样 404", async () => {
    seedStandard();
    const r = await get("/s/baseTok/t/tUnshared/records");
    expect(r.status).toBe(404);
  });
});

describe("base token 失效/越权", () => {
  it("失效 baseToken -> 404", async () => {
    seedStandard();
    const r = await get("/s/wrongToken/t/tShared");
    expect(r.status).toBe(404);
  });

  it("过期 baseToken -> 404", async () => {
    seedStandard();
    state.links.find((l) => l.token === "baseTok")!.expiresAt = ANCIENT;
    const r = await get("/s/baseTok/t/tShared");
    expect(r.status).toBe(404);
  });

  it("拿 table token 冒充 baseToken -> 404（不是 base 族）", async () => {
    seedStandard();
    const r = await get("/s/tblShared/t/tShared");
    expect(r.status).toBe(404);
  });

  it("库级总闸关闭 -> base 链接失效 404", async () => {
    seedStandard();
    state.baseShareEnabled = 0;
    const r = await get("/s/baseTok/t/tShared");
    expect(r.status).toBe(404);
  });
});

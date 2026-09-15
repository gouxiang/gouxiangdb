// M4/S6 AC-M4-3 六通道（前 4 通道 + 写键）：on 态字段掩码五出口端到端。
// 真库真 HTTP 真 JWT；GX_AUTHZ_ENGINE=on 读【原始】模式，节点守卫全局门仍降级 shadow
//（AUTHZ_ENFORCE_READY=false），故 u_mask 凭旧 members editor 照常进入出口，字段门独立生效。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { json } from "../../nav/__tests__/characterization/charHarness.js";
import { setupS6MaskFixture, OWNER, MASK, type S6Fixture } from "./s6MaskHarness.js";

let fx: S6Fixture;

beforeAll(async () => {
  fx = await setupS6MaskFixture();
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  await fx.h.cleanup();
});

beforeEach(() => {
  process.env.GX_AUTHZ_ENGINE = "on";
});

interface ListBody {
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  total: number;
  filteredTotal: number;
  fields: Array<{ id: string; name: string }>;
  allFields: Array<{ id: string; name: string }>;
  groups: unknown;
  aggregations: Record<string, number | null> | null;
}

async function getList(user: string, urlTail = ""): Promise<{ status: number; body: ListBody }> {
  const res = await fx.call("GET", `/api/records?tableId=${fx.A}${urlTail}`, user);
  return { status: res.status, body: await json<ListBody>(res) };
}

describe("通道1 列表：隐藏列与原值一致缺席", () => {
  it("records/fieds/allFields 无薪资与机密列；owner 对照可见全部", async () => {
    const res = await fx.call("GET", `/api/records?tableId=${fx.A}`, MASK);
    const raw = await res.json();
    expect(res.status).toBe(200);
    // on 态新基线：列表仍恰好七键（默认 keyset off，additive 游标三键不出现）。
    expect(Object.keys(raw).sort()).toEqual(
      ["aggregations", "allFields", "fields", "filteredTotal", "groups", "records", "total"].sort(),
    );
    const { status, body } = await getList(MASK);
    expect(status).toBe(200);
    for (const f of [...body.fields, ...body.allFields]) {
      expect([fx.f.salary, fx.f.secret]).not.toContain(f.id);
    }
    for (const r of body.records) {
      expect(r.fields).not.toHaveProperty(fx.f.salary);
      expect(r.fields).not.toHaveProperty(fx.f.secret);
    }
    const owner = await getList(OWNER);
    expect(owner.body.allFields.some((f) => f.id === fx.f.salary)).toBe(true);
    expect(owner.body.records.find((r) => r.id === fx.rec.A2)!.fields[fx.f.salary]).toBe(888);
  });

  it("直调 API 借隐藏列搜索搜不到（搜索域随可见字段收窄），owner 能搜到", async () => {
    const masked = await getList(MASK, "&search=%E6%9C%BA%E5%AF%86-1"); // 机密-1
    expect(masked.body.records).toHaveLength(0);
    const owner = await getList(OWNER, "&search=%E6%9C%BA%E5%AF%86-1");
    expect(owner.body.records.map((r) => r.id)).toEqual([fx.rec.A1]);
  });
});

describe("通道2 详情：投影同列表口径", () => {
  it("fields 清单与 record.fields 均无隐藏列；响应恰好两键", async () => {
    const res = await fx.call("GET", `/api/records/${fx.rec.A2}`, MASK);
    expect(res.status).toBe(200);
    const body = await json<{ record: { id: string; fields: Record<string, unknown> }; fields: Array<{ id: string }> }>(res);
    expect(Object.keys(body).sort()).toEqual(["fields", "record"]);
    expect(body.fields.some((f) => f.id === fx.f.salary || f.id === fx.f.secret)).toBe(false);
    expect(body.record.fields).not.toHaveProperty(fx.f.salary);
    expect(body.record.fields).not.toHaveProperty(fx.f.secret);
    expect(body.record.id).toBe(fx.rec.A2);
  });
});

describe("通道3 CSV 导出：列与值随掩码收窄，隐藏视图条件失效", () => {
  it("表头无隐藏列，行无原值，视图隐藏 filter/sort 不作用（3 行 created 序）", async () => {
    const res = await fx.call("GET", `/api/tables/${fx.A}/export.csv?viewId=${fx.viewA}`, MASK);
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode((await res.arrayBuffer()).slice(3)); // 去 BOM
    const lines = text.split("\r\n").filter((s) => s !== "");
    expect(lines[0]).not.toContain("薪资");
    expect(lines[0]).not.toContain("机密");
    expect(lines).toHaveLength(4); // 表头 + 3 行（隐藏 filter 被脱敏 -> 不过滤）
    expect(text).not.toContain("机密-1");
    expect(text).not.toContain("888");
    // 行序 = createdAt asc（隐藏 sort 被脱敏），即 A1/A2/A3
    expect(lines[1]).toContain("研发张三");
    expect(lines[2]).toContain("研发李四");
  });
});

describe("写键守卫：隐藏/只读键 403 FORBIDDEN_FIELD 且整行未改", () => {
  it("POST create 带隐藏键 -> 403，记录未创建；带只读键 -> 403；合法键 201 且回吐体无隐藏列", async () => {
    const hidden = await fx.call("POST", `/api/records?tableId=${fx.A}`, MASK, {
      fields: { [fx.f.name]: "越权建", [fx.f.secret]: "偷写" },
    });
    expect(hidden.status).toBe(403);
    expect((await json<{ code: string }>(hidden)).code).toBe("FORBIDDEN_FIELD");

    const ro = await fx.call("POST", `/api/records?tableId=${fx.A}`, MASK, {
      fields: { [fx.f.name]: "只读建", [fx.f.ro]: "X" },
    });
    expect(ro.status).toBe(403);
    expect((await json<{ code: string }>(ro)).code).toBe("FORBIDDEN_FIELD");

    const draftHidden = await fx.call("POST", `/api/records?tableId=${fx.A}`, MASK, {
      draft: true, fields: { [fx.f.salary]: 1 },
    });
    expect(draftHidden.status).toBe(403); // draft 同口径

    const ok = await fx.call("POST", `/api/records?tableId=${fx.A}`, MASK, {
      fields: { [fx.f.name]: "合法建" },
    });
    expect(ok.status).toBe(201);
    const body = await json<{ record: { id: string; fields: Record<string, unknown> } }>(ok);
    expect(body.record.fields[fx.f.name]).toBe("合法建");
    expect(body.record.fields).not.toHaveProperty(fx.f.secret);

    // 403 两次均未落库（搜索被拒绝的值无结果；总数仅 +1 合法行）
    const list = await getList(OWNER);
    expect(list.body.total).toBe(4);
    expect(list.body.records.some((r) => (r.fields[fx.f.secret] ?? "") === "偷写")).toBe(false);
  });

  it("PATCH 带隐藏键/只读键 -> 403 且整行未改；合法键正常", async () => {
    const before = await fx.call("GET", `/api/records/${fx.rec.A3}`, OWNER);
    const beforeBody = await json<{ record: { fields: Record<string, unknown> } }>(before);

    const hidden = await fx.call("PATCH", `/api/records/${fx.rec.A3}`, MASK, {
      fields: { [fx.f.name]: "改名", [fx.f.secret]: "patch偷写" },
    });
    expect(hidden.status).toBe(403);
    const ro = await fx.call("PATCH", `/api/records/${fx.rec.A3}`, MASK, {
      fields: { [fx.f.ro]: "RO-999" },
    });
    expect(ro.status).toBe(403);
    const ok = await fx.call("PATCH", `/api/records/${fx.rec.A3}`, MASK, {
      fields: { [fx.f.name]: "研发王五改" },
    });
    expect(ok.status).toBe(200);

    const after = await fx.call("GET", `/api/records/${fx.rec.A3}`, OWNER);
    const afterBody = await json<{ record: { fields: Record<string, unknown> } }>(after);
    expect(afterBody.record.fields[fx.f.name]).toBe("研发王五改");
    // 被 403 拒绝的键维持原值（secret 原本 null、ro 原本 RO-3）
    expect(afterBody.record.fields[fx.f.secret]).toBe(beforeBody.record.fields[fx.f.secret]);
    expect(afterBody.record.fields[fx.f.ro]).toBe("RO-3");
  });

  it("bulk-update 同门：隐藏键 403 整批不写", async () => {
    const res = await fx.call("POST", `/api/records/bulk-update`, MASK, {
      ids: [fx.rec.A1, fx.rec.A2], fields: { [fx.f.salary]: 999 },
    });
    expect(res.status).toBe(403);
    const owner = await getList(OWNER);
    const a2 = owner.body.records.find((r) => r.id === fx.rec.A2)!;
    expect(a2.fields[fx.f.salary]).toBe(888); // 未被改成 999
  });
});

describe("off/shadow 掩码门短路（字节一致证据）", () => {
  it("shadow 与 off 下列表/详情/导出响应逐字节一致（shadow 仅对拍不改响应）", async () => {
    delete process.env.GX_AUTHZ_ENGINE;
    const offList = await (await fx.call("GET", `/api/records?tableId=${fx.A}&viewId=${fx.viewA}`, MASK)).text();
    const offDetail = await (await fx.call("GET", `/api/records/${fx.rec.A1}`, MASK)).text();
    const offCsv = await (await fx.call("GET", `/api/tables/${fx.A}/export.csv?viewId=${fx.viewA}`, MASK)).text();
    process.env.GX_AUTHZ_ENGINE = "shadow";
    const shList = await (await fx.call("GET", `/api/records?tableId=${fx.A}&viewId=${fx.viewA}`, MASK)).text();
    const shDetail = await (await fx.call("GET", `/api/records/${fx.rec.A1}`, MASK)).text();
    const shCsv = await (await fx.call("GET", `/api/tables/${fx.A}/export.csv?viewId=${fx.viewA}`, MASK)).text();
    expect(shList).toBe(offList);
    expect(shDetail).toBe(offDetail);
    expect(shCsv).toBe(offCsv);
    // off 态 u_mask 凭 editor 旧权限可见隐藏列（字段门短路、未实例化掩码会话）。
    // 视图 filter=salary isNotEmpty：A1(null) 被滤除，A2(888) 在，故其机密值应出现在响应中。
    expect(offList).toContain(fx.f.salary);
    expect(offList).toContain("机密-2");
    expect(offList).toContain("888");
  });
});

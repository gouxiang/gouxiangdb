// M5/S0 旧 GET /api/search 字节级 golden（真库真迁移 + 真 HTTP，不 mock 检索逻辑）。
//
// 目的（M5 计划 §3 第 1 条 / §17 S0）：整个 M5 不重写 routes/search.ts（M5 全程
// 零 diff），先用真库快照把旧检索的 URL 响应形状、有界预览语义、计算字段排除、
// 标题/snippet 派生规则字节锁住；search.ts 被意外改动时本文件变红，为 S7 起新 v1
// 链路的 shadow 对拍立基线。字节快照落同目录 __snapshots__（派工允许；保持本
// 测试文件在 300 行内）。
//
// 确定性：命中 id/字段 id/base/kb/table/doc id 全部显式指定；record.createdAt 与
// kbDoc.updatedAt 显式赋值（搜索按这两列排序），响应不含时间戳字段，故快照无抖动。
// 搜索主体为普通 viewer 成员 U（非 owner/creator），旧搜索只认 members/kb_members。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../domain/nav/__tests__/navRouteHarness.js";
import { SEARCH_PREVIEW_LIMIT } from "../searchBounds.js";

let h: CharHarness;
const U = "m5s_user";
const B1 = "m5s_base";
const T1 = "m5s_table";
const FP = "m5s_f_primary"; // 主标题字段 singleLineText
const FB = "m5s_f_body"; // longText，验 body 命中 + 60 字截断
const FJ = "m5s_f_json"; // json 物理字段，LinkRef 形态数组触发对象 title 拼接
const FC = "m5s_f_formula"; // formula 计算字段：即使存命中串也不入选
const B2 = "m5s_base_cap";
const T2 = "m5s_table_cap";
const FP2 = "m5s_f_cap_primary";
const KB = "m5s_kb";

async function search(qRaw: string | undefined): Promise<unknown> {
  const url = qRaw === undefined ? "/api/search" : `/api/search?q=${encodeURIComponent(qRaw)}`;
  const res = await h.app.request(url, { headers: await h.auth(U) });
  expect(res.status, url).toBe(200);
  return json(res);
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m5-s0-golden-");
  await h.createUser("owner", { email: "owner@m5s.x", displayName: "所有者" });
  await h.createUser(U, { email: "u@m5s.x", displayName: "搜索成员" });

  await h.prisma.$transaction([
    h.prisma.base.create({ data: { id: B1, name: "古籍客户库", createdBy: "owner" } }),
    h.prisma.member.create({ data: { id: "m5s_m_b1", baseId: B1, userId: U, role: "viewer" } }),
    h.prisma.table.create({ data: { id: T1, baseId: B1, name: "客户表", primaryFieldId: FP, createdBy: "owner" } }),
    h.prisma.field.create({ data: { id: FP, tableId: T1, name: "客户名", type: "singleLineText", order: 0 } }),
    h.prisma.field.create({ data: { id: FB, tableId: T1, name: "备注", type: "longText", order: 1 } }),
    h.prisma.field.create({ data: { id: FJ, tableId: T1, name: "关联快照", type: "json", order: 2 } }),
    h.prisma.field.create({ data: { id: FC, tableId: T1, name: "计算列", type: "formula", order: 3, formula: "1" } }),
  ]);

  const base = (ms: number) => new Date(Date.parse("2026-03-01T00:00:00.000Z") + ms);
  // 60 个不含命中词的字符 + 命中词：text.length=64>60，snippet 切前 60 + 省略号。
  const longBody = `${"甲".repeat(60)}长文体词`;
  await h.prisma.record.createMany({
    data: [
      { id: "m5s_r_primary", tableId: T1, createdBy: "owner", updatedBy: "owner", createdAt: base(0),
        fields: JSON.stringify({ [FP]: "敦煌阿尔法客户", [FB]: "普通备注" }) },
      { id: "m5s_r_body", tableId: T1, createdBy: "owner", updatedBy: "owner", createdAt: base(1),
        fields: JSON.stringify({ [FP]: "某客户", [FB]: longBody }) },
      { id: "m5s_r_link", tableId: T1, createdBy: "owner", updatedBy: "owner", createdAt: base(2),
        fields: JSON.stringify({
          [FP]: "链接所在客户",
          [FJ]: [{ tableId: "m5s_other_t", recordId: "m5s_other_r", title: "关联对象贝塔标题" }],
        }) },
      { id: "m5s_r_computed", tableId: T1, createdBy: "owner", updatedBy: "owner", createdAt: base(3),
        fields: JSON.stringify({ [FP]: "计算列客户", [FC]: "仅计算列含伽马命中词" }) },
      { id: "m5s_r_fallback", tableId: T1, createdBy: "owner", updatedBy: "owner", createdAt: base(4),
        fields: JSON.stringify({ [FP]: "", [FB]: "回退专用词出现在正文备注字段里" }) },
    ],
  });

  await h.prisma.$transaction([
    h.prisma.base.create({ data: { id: B2, name: "上限客户库", createdBy: "owner" } }),
    h.prisma.member.create({ data: { id: "m5s_m_b2", baseId: B2, userId: U, role: "viewer" } }),
    h.prisma.table.create({ data: { id: T2, baseId: B2, name: "上限表", primaryFieldId: FP2, createdBy: "owner" } }),
    h.prisma.field.create({ data: { id: FP2, tableId: T2, name: "客户名", type: "singleLineText", order: 0 } }),
  ]);
  // orderBy createdAt asc + take 2000：最旧 2000 条入窗。最旧(i=0)带旧命中词、
  // 最新(i=2000)带新命中词，以代码实测口径锁谁在窗内/谁被截断（见该用例注释）。
  const capRows = Array.from({ length: SEARCH_PREVIEW_LIMIT + 1 }, (_, i) => {
    const title = i === 0 ? "旧窗内命中词zzz" : i === SEARCH_PREVIEW_LIMIT ? "新窗外命中词zzz" : `占位客户${i}`;
    return {
      id: `m5s_cap_${i}`, tableId: T2, createdBy: "owner", updatedBy: "owner",
      createdAt: base(1000 + i), fields: JSON.stringify({ [FP2]: title }),
    };
  });
  await h.prisma.record.createMany({ data: capRows });

  await h.prisma.$transaction([
    h.prisma.knowledgeBase.create({ data: { id: KB, name: "产品知识库", createdBy: "owner" } }),
    h.prisma.kbMember.create({ data: { id: "m5s_km", kbId: KB, userId: U, role: "viewer" } }),
    h.prisma.kbDoc.create({ data: {
      id: "m5s_d_title", kbId: KB, kind: "doc", title: "德尔塔标题文档", content: "", searchText: "",
      createdBy: "owner", updatedBy: "owner", updatedAt: new Date("2026-04-03T00:00:00.000Z") } }),
    h.prisma.kbDoc.create({ data: {
      id: "m5s_d_body", kbId: KB, kind: "doc", title: "普通正文文档", content: "",
      searchText: "这是一段正文，伊普西龙关键字出现在中部位置用于截取片段窗口内容结尾。",
      createdBy: "owner", updatedBy: "owner", updatedAt: new Date("2026-04-02T00:00:00.000Z") } }),
    h.prisma.kbDoc.create({ data: {
      id: "m5s_cv", kbId: KB, kind: "canvas", title: "画布德尔塔导图", content: "[]", searchText: "",
      createdBy: "owner", updatedBy: "owner", updatedAt: new Date("2026-04-01T00:00:00.000Z") } }),
  ]);
}, 180000);

afterAll(async () => {
  await h.cleanup();
});

const RECORD_KEYS = ["type", "baseId", "baseName", "tableId", "tableName", "recordId", "title", "snippet", "matchedField"];
const DOC_KEYS = ["type", "kbId", "kbName", "docId", "title", "snippet"];

describe("M5/S0 旧 /api/search golden", () => {
  it("空 q（缺失或纯空白）：{records:[],docs:[]}，且不带 boundedPreview marker", async () => {
    expect(await search(undefined)).toMatchSnapshot("空 q 缺失");
    expect(await search("   ")).toEqual({ records: [], docs: [] });
  });

  it("records 命中：全键齐全、主标题/正文截断/空标题回退/LinkRef 标题派生字节锁定", async () => {
    const body = (await search("长文体词")) as { records: Array<Record<string, unknown>> };
    const hit = body.records.find((r) => r.recordId === "m5s_r_body")!;
    expect(body.records).toHaveLength(1);
    expect(Object.keys(hit)).toEqual(RECORD_KEYS);
    expect(hit.snippet).toHaveLength(61); // 60 字 + 省略号
    expect(hit.matchedField).toBe("备注");
    expect(hit.title).toBe("某客户"); // primary 有值，title 独立于 snippet（不回退）

    const fb = ((await search("回退专用词")) as { records: Array<Record<string, unknown>> }).records[0]!;
    expect(fb.recordId).toBe("m5s_r_fallback");
    expect(fb.matchedField).toBe("备注");
    expect(fb.title).toBe(fb.snippet); // primary 为空，title 回退 snippet（search.ts:103）

    expect(await search("长文体词")).toMatchSnapshot("正文命中 60 字截断");
    expect(await search("回退专用词")).toMatchSnapshot("空主标题回退 snippet");
    expect(await search("敦煌阿尔法")).toMatchSnapshot("主标题命中");
    expect(await search("贝塔")).toMatchSnapshot("LinkRef 对象 title 命中");
  });

  it("docs 命中：doc/canvas 全键、title 与 searchText snippet、updatedAt desc 序字节锁定", async () => {
    const out = (await search("德尔塔")) as { docs: Array<Record<string, unknown>> };
    expect(out.docs).toHaveLength(2);
    for (const d of out.docs) expect(Object.keys(d)).toEqual(DOC_KEYS);
    expect(out.docs.map((d) => d.docId)).toEqual(["m5s_d_title", "m5s_cv"]); // 04-03 doc 先于 04-01 canvas
    expect(await search("伊普西龙")).toMatchSnapshot("doc 正文 searchText snippet");
    expect(await search("德尔塔")).toMatchSnapshot("doc 与 canvas 双命中 updatedAt desc");
  });

  it("计算字段不入选：命中词只在 formula 列时无任何记录召回", async () => {
    await expect(search("伽马")).resolves.toMatchSnapshot("计算字段命中无召回");
  });

  it("boundedPreview 截断：每表仅最旧 2000 条入窗，第 2001 条（最新）不召回；marker 恒定", async () => {
    // 代码口径（search.ts:79-83）：orderBy createdAt asc + take SEARCH_PREVIEW_LIMIT。
    // 实测入窗的是 createdAt 最小的最旧 2000 条，最新一条落在窗外（与 :77 注释
    // "更老的记录不会出现" 的字面表述相反；S0 只锁代码真实行为，不改生产码，已上报）。
    const oldHit = (await search("旧窗内命中词")) as { records: Array<{ recordId: string }>; previewLimit: number; boundedPreview: boolean };
    const newHit = (await search("新窗外命中词")) as { records: unknown[] };
    expect(oldHit.records.map((r) => r.recordId)).toEqual(["m5s_cap_0"]);
    expect(newHit.records).toEqual([]);
    expect(oldHit.boundedPreview).toBe(true);
    expect(oldHit.previewLimit).toBe(SEARCH_PREVIEW_LIMIT);
    expect(oldHit).toMatchSnapshot("有界预览截断与 marker");
  });
});

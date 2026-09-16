// M5/S7 出口 hydrate 的 primaryField mask 回归（§4.7 规则 6 / M4 A-4 / AC-M5-2）。
//
// P0 背景：scope.maskedTableFields 以【nav 节点 id】为键（nav_table_<tableId>），而 hydrate
// 曾误用裸 Prisma 资源 id t.id 去索引，allow 恒 undefined -> 被 mask 的 primaryField 从标题泄漏。
// 修复后 hydrate 统一用命中记录的 ref.nodeId（=chunk c.nodeId=tableNodeId=`nav_table_<t.id>`）。
//
// 覆盖：
//  1) 主字段被 mask：identity 词仍命中实体（不消失），但 title 回退 record id、title/snippet
//     不含主字段密文、matchedField=null；并锁定 item.nodeId === nav_table_<t.id>（键域真源）；
//  2) 白名单内的非主字段值经 field 词命中：snippet/matchedField 正常（验证 field 分支同一 allow
//     键修复真正生效，而非靠召回侧假防）；被 mask 主字段密文经 field 词零命中；
//  3) 对照：主字段在白名单内时 title 正常显示主字段值（防止修成一律回退 id 的过度矫正）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { executeUnifiedSearch } from "../query.js";
import type { SearchStore } from "../searchStore.js";
import type { QueryRuntimeDeps } from "../queryTypes.js";

let h: QueryHarness;
let store: SearchStore;
let buildDeps: () => Promise<QueryRuntimeDeps>;

const U = "u_hpm";
// T_mask：primary=f_pri 被 mask（白名单仅 f_pub）；T_ok：primary=f_okpri 在白名单（对照）。
const T_MASK = "hpm_table_mask";
const T_OK = "hpm_table_ok";
const N_MASK = `nav_table_${T_MASK}`;
const N_OK = `nav_table_${T_OK}`;
const RID_MASK = "hpm_rec_mask";
const RID_OK = "hpm_rec_ok";

const SECRET = "机密客户名TOP_SECRET_TITLE";
const PUBLIC_BODY = "公开备注内容PM_PUBLISHED_BODY";
const OK_TITLE = "正常主字段OK_TITLE_VISIBLE";

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s7-hydrate-pm-");
  store = h.openStore("hydratepm", false);
  await querySeed.createUsers(h.prisma, [{ id: U }, { id: "owner", email: "hpm_owner@x.com" }]);

  // T_mask：主字段 f_pri 在 mask 中，仅 f_pub 白名单。
  await h.prisma.base.create({ data: { id: `${T_MASK}_b`, name: "主字段掩码库", createdBy: "owner" } });
  await h.prisma.table.create({
    data: { id: T_MASK, baseId: `${T_MASK}_b`, name: "主字段掩码表PM_TMASK", primaryFieldId: "f_pri", createdBy: "owner" },
  });
  await h.prisma.field.createMany({
    data: [
      { id: "f_pri", tableId: T_MASK, name: "客户名", type: "singleLineText", order: 0 },
      { id: "f_pub", tableId: T_MASK, name: "公开备注", type: "longText", order: 1 },
    ],
  });
  await h.prisma.record.create({
    data: { id: RID_MASK, tableId: T_MASK, createdBy: "owner", updatedBy: "owner",
      fields: JSON.stringify({ f_pri: SECRET, f_pub: PUBLIC_BODY }) },
  });

  // T_ok：主字段 f_okpri 列在白名单（fieldMask 含它），title 应正常显示。
  await h.prisma.base.create({ data: { id: `${T_OK}_b`, name: "主字段可见库", createdBy: "owner" } });
  await h.prisma.table.create({
    data: { id: T_OK, baseId: `${T_OK}_b`, name: "主字段可见表PM_TOK", primaryFieldId: "f_okpri", createdBy: "owner" },
  });
  await h.prisma.field.create({
    data: { id: "f_okpri", tableId: T_OK, name: "客户名", type: "singleLineText", order: 0 },
  });
  await h.prisma.record.create({
    data: { id: RID_OK, tableId: T_OK, createdBy: "owner", updatedBy: "owner",
      fields: JSON.stringify({ f_okpri: OK_TITLE }) },
  });

  for (const rid of [RID_MASK, RID_OK]) {
    const entity = await extractEntity(h.prisma, { entityType: "record", entityId: rid, version: 1n }, 50);
    await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "off", provider: null });
  }

  await querySeed.createNavNodes(h.prisma, [
    { id: `nav_base_${T_MASK}_b`, kind: "base", resourceType: "base", resourceId: `${T_MASK}_b`, parentId: null },
    { id: N_MASK, kind: "table", resourceType: "table", resourceId: T_MASK, parentId: `nav_base_${T_MASK}_b` },
    { id: `nav_base_${T_OK}_b`, kind: "base", resourceType: "base", resourceId: `${T_OK}_b`, parentId: null },
    { id: N_OK, kind: "table", resourceType: "table", resourceId: T_OK, parentId: `nav_base_${T_OK}_b` },
  ]);
  await querySeed.createPolicies(h.prisma, [
    { id: "hpm_p_mask", nodeId: N_MASK, subjectType: "user", subjectId: U, actions: "r", fieldMask: '{"allowFields":["f_pub"]}' },
    { id: "hpm_p_ok", nodeId: N_OK, subjectType: "user", subjectId: U, actions: "r", fieldMask: '{"allowFields":["f_okpri"]}' },
  ]);

  buildDeps = async () => {
    const { buildQueryRuntime } = await import("../queryRuntime.js");
    const { deps } = await buildQueryRuntime(U, "all", {
      prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
      jwtSecret: "x", store, provider: null,
    });
    return deps;
  };
}, 120000);

afterAll(async () => {
  store?.close();
  await h.cleanup();
});

async function search(q: string, mode: "auto" | "fts" | "vector" = "fts") {
  const res = await executeUnifiedSearch(await buildDeps(), { q, mode, type: "all", limit: 20 });
  return res;
}

describe("primaryField 被 mask：出口 title 回退 record id（不泄漏密文）", () => {
  it("identity 词（表名）命中实体但 title=recordId、matchedField=null、nodeId 为 nav 键", async () => {
    const res = await search("PM_TMASK");
    const hit = res.items.find((i) => i.entityId === RID_MASK);
    expect(hit).toBeTruthy(); // 实体不因主字段 mask 而消失（identity 恒可见）
    expect(hit!.nodeId).toBe(N_MASK); // 键域锁定：hydrate 必须以此索引 maskedTableFields
    expect(hit!.title).toBe(RID_MASK); // 回退 record id，而非主字段密文
    expect(hit!.snippet).toBe("");
    expect(hit!.matchedField).toBeNull();
  });

  it("title 与 snippet 均不含被 mask 主字段密文；密文经 field 词也零命中", async () => {
    const byIdentity = await search("PM_TMASK");
    const hit = byIdentity.items.find((i) => i.entityId === RID_MASK)!;
    expect(hit.title).not.toContain("TOP_SECRET_TITLE");
    expect(hit.snippet).not.toContain("TOP_SECRET_TITLE");

    const bySecret = await search("TOP_SECRET_TITLE");
    expect(bySecret.items.map((i) => i.entityId)).not.toContain(RID_MASK);
    expect(bySecret.items.some((i) => JSON.stringify(i).includes("TOP_SECRET_TITLE"))).toBe(false);
  });

  it("白名单字段值经 field 词命中：snippet/matchedField 正常（field 分支同键修复真生效）", async () => {
    const res = await search("PM_PUBLISHED_BODY");
    const hit = res.items.find((i) => i.entityId === RID_MASK);
    expect(hit).toBeTruthy();
    expect(hit!.matchedField).toBe("公开备注"); // f_pub 在白名单
    expect(hit!.snippet).toContain("PM_PUBLISHED_BODY");
    expect(hit!.title).toBe(RID_MASK); // 即便 field 命中，主字段仍被 mask -> title 依旧回退 id
  });
});

describe("对照：primaryField 在白名单内时 title 正常显示（防过度矫正）", () => {
  it("主字段可见的表：identity 命中后 title 为主字段业务值，不回退 id", async () => {
    const res = await search("PM_TOK");
    const hit = res.items.find((i) => i.entityId === RID_OK);
    expect(hit).toBeTruthy();
    expect(hit!.nodeId).toBe(N_OK);
    expect(hit!.title).toBe(OK_TITLE);
  });
});

// M5/S7 /api/v1/search HTTP 级 on/shadow/strict 行为集成（真库真 search.db + 真新链 + 真 legacy）。
//
// 覆盖派工 shadow 纪律（纯比较逻辑在 queryShadow.test；本文件锁 HTTP 壳）：
//  - on：响应是新链 §9 形（items/mode），非旧 {records,docs}；
//  - shadow：新链照跑，但响应永远是旧 /api/search 形（legacy）；drift=0 正常 200；
//  - shadow 出现 drift（新链有旧无）：默认只记日志，响应仍是旧形且 200（不污染响应）；
//  - GX_M5_SHADOW_STRICT=on：可比集 drift 非 0 -> 500 M5_SHADOW_DRIFT；
//  - 空 q：shadow 回 {records:[],docs:[]}，短路在打开 search.db 之前。
//
// 装配：vi.mock 替换 config（可切 m5Search/strict/dataDir）；globalThis.__gx_prisma 注入真 harness
// （db.js 单例与 authz 链共用）；GX_SEARCH_DB_PATH 把路由的 getSearchStore 指向 harness 派生库。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";

// config 在路由内被静态 import；用可变 mock 对象在测试间切换 m5Search/strict（hoisted）。
const configState: {
  m5Search: "off" | "shadow" | "on";
  m5ShadowStrict: boolean;
  dataDir: string; appDir: string; jwtSecret: string;
} = {
  m5Search: "on", m5ShadowStrict: false,
  dataDir: "", appDir: process.cwd(), jwtSecret: "route-secret-at-least-16-chars",
};
vi.mock("../../../config.js", () => ({ config: configState }));

import { makeQueryHarness, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { searchShadowRegistry } from "../queryShadow.js";
import type { SearchStore } from "../searchStore.js";

let h: QueryHarness;
let store: SearchStore;
let searchRoutes: typeof import("../../../routes/v1/search.js").searchRoutes;
let closeSearchStore: () => void;

const U = "u_v1";
const B1 = "v1_base_member";
const T1 = "v1_table_member";
const N1 = `nav_table_${T1}`;
const NB1 = `nav_base_${B1}`;
const B2 = "v1_base_nomember";
const T2 = "v1_table_nomember";
const N2 = `nav_table_${T2}`;
const NB2 = `nav_base_${B2}`;

async function seedRecord(tableId: string, recordId: string, fieldId: string, word: string) {
  await h.prisma.record.create({
    data: { id: recordId, tableId, createdBy: "owner", updatedBy: "owner", fields: JSON.stringify({ [fieldId]: word }) },
  });
  const entity = await extractEntity(h.prisma, { entityType: "record", entityId: recordId, version: 1n }, 50);
  await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "off", provider: null });
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s7-v1route-");
  store = h.openStore("v1route", true);
  configState.dataDir = h.tmpDir;
  // 路由 getSearchStore 按 env+dataDir 解析路径；指向 harness 已派生的同一 search.db 文件。
  process.env.GX_SEARCH_DB_PATH = store.filePath;

  await h.prisma.user.createMany({
    data: [
      { id: U, email: "v1@x.com", displayName: "v1", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
      { id: "owner", email: "v1owner@x.com", displayName: "owner", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
    ],
  });

  // B1：U 既是 member（legacy 命中）又有 nav policy r（新链命中）-> 两链一致。
  await h.prisma.base.create({ data: { id: B1, name: "成员库", createdBy: "owner" } });
  await h.prisma.member.create({ data: { id: "v1_m_b1", baseId: B1, userId: U, role: "viewer" } });
  await h.prisma.table.create({ data: { id: T1, baseId: B1, name: "成员表", primaryFieldId: "v1_f0", createdBy: "owner" } });
  await h.prisma.field.create({ data: { id: "v1_f0", tableId: T1, name: "客户名", type: "singleLineText", order: 0 } });

  // B2：U 只有 nav policy r（新链命中），但不是 member（legacy 不命中）-> 制造 shadow drift。
  await h.prisma.base.create({ data: { id: B2, name: "非成员库", createdBy: "owner" } });
  await h.prisma.table.create({ data: { id: T2, baseId: B2, name: "非成员表", primaryFieldId: "v1_g0", createdBy: "owner" } });
  await h.prisma.field.create({ data: { id: "v1_g0", tableId: T2, name: "客户名", type: "singleLineText", order: 0 } });

  await querySeed.createNavNodes(h.prisma, [
    { id: NB1, kind: "base", resourceType: "base", resourceId: B1, parentId: null },
    { id: N1, kind: "table", resourceType: "table", resourceId: T1, parentId: NB1 },
    { id: NB2, kind: "base", resourceType: "base", resourceId: B2, parentId: null },
    { id: N2, kind: "table", resourceType: "table", resourceId: T2, parentId: NB2 },
  ]);
  await querySeed.createPolicies(h.prisma, [
    { id: "v1_p_t1", nodeId: N1, subjectType: "user", subjectId: U, actions: "r" },
    { id: "v1_p_t2", nodeId: N2, subjectType: "user", subjectId: U, actions: "r" },
  ]);

  await seedRecord(T1, "v1_r_shared", "v1_f0", "暗影共享词SH_0");
  await seedRecord(T2, "v1_r_newonly", "v1_g0", "暗影独有词NW_0");

  // db.js 顶层读 globalThis.__gx_prisma：在动态 import 路由前注入真 harness 客户端。
  globalThis.__gx_prisma = h.prisma as unknown as PrismaClient;
  const routeMod = await import("../../../routes/v1/search.js");
  searchRoutes = routeMod.searchRoutes;
  const storeMod = await import("../searchStore.js");
  closeSearchStore = storeMod.closeSearchStore;
}, 120000);

afterAll(async () => {
  closeSearchStore?.();
  store?.close();
  await h.cleanup();
});

beforeEach(() => {
  searchShadowRegistry.reset();
  configState.m5Search = "on";
  configState.m5ShadowStrict = false;
});

function app(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", { userId: U, status: "ACTIVE", tokenVersion: 0, workspaceId: "ws_default" });
    await next();
  });
  app.onError((err, c) => {
    const anyErr = err as unknown as { status?: number; code?: string };
    const status = typeof anyErr.status === "number" ? anyErr.status : 500;
    const code = anyErr.code ?? "INTERNAL";
    return c.json({ error: (err as Error).message, code }, status as never);
  });
  app.route("/api/v1/search", searchRoutes);
  return app;
}

async function get(q: string): Promise<Response> {
  return app().request(`/api/v1/search?q=${encodeURIComponent(q)}`);
}

describe("GX_M5_SEARCH=on：响应走新统一检索链路", () => {
  it("命中返回 §9 形（items/mode），非旧 {records,docs}", async () => {
    const res = await get("暗影共享词SH_0");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ entityId: string }>; mode: string; records?: unknown };
    expect(Array.isArray(body.items)).toBe(true);
    expect("records" in body).toBe(false);
    expect(body.items.map((i) => i.entityId)).toContain("v1_r_shared");
    expect(["fts", "hybrid", "like", "vector"]).toContain(body.mode);
  });
});

describe("GX_M5_SEARCH=shadow：响应永远走旧链，对拍只观测", () => {
  it("drift=0（两链都命中同一实体）：200 + 旧形 {records,docs}", async () => {
    configState.m5Search = "shadow";
    const res = await get("暗影共享词SH_0");
    expect(res.status).toBe(200);
    const body = await res.json() as { records: Array<{ recordId: string }>; docs: unknown[] };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.map((r) => r.recordId)).toContain("v1_r_shared");
    expect(searchShadowRegistry.snapshot().compared).toBe(1);
    expect(searchShadowRegistry.snapshot().drift).toBe(0);
  });

  it("drift（新链有旧无）：默认只记脱敏日志，响应仍是旧形且 200（不被污染）", async () => {
    configState.m5Search = "shadow";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await get("暗影独有词NW_0");
    expect(res.status).toBe(200); // 不因 drift 失败
    const body = await res.json() as { records: unknown[]; docs: unknown[] };
    // 旧链只认 member：U 非 B2 成员 -> records 空；但新链命中 -> overAllow drift 已记录。
    expect(body.records).toEqual([]);
    const snap = searchShadowRegistry.snapshot();
    expect(snap.drift).toBe(1);
    expect(snap.overAllow).toBe(1);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("[m5-search-shadow]");
  });

  it("GX_M5_SHADOW_STRICT=on：可比集 drift 非 0 -> 500 M5_SHADOW_DRIFT", async () => {
    configState.m5Search = "shadow";
    configState.m5ShadowStrict = true;
    const res = await get("暗影独有词NW_0");
    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("M5_SHADOW_DRIFT");
  });

  it("空 q：回 {records:[],docs:[]} 旧空壳，短路不进新链/不开新库", async () => {
    configState.m5Search = "shadow";
    const res = await get("   ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [], docs: [] });
  });
});

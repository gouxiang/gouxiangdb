// M3/S0 特征测试（二）：旧列表接口的 membership 过滤与排序【现状】锁。
//
// M3 新外壳的二级列表会改读 nav tree，但旧 /api 列表契约必须保持（旧壳 flag 回退仍消费；
// M3 计划 §3-3）。本文件钉死四个侧栏数据源端点在 43bac9b 基线上的行为：
//  - GET /api/bases：仅自己有 member 行的库；软删库过滤；输出按 joinedAt asc；
//  - GET /api/tables?baseId=：非成员 403；按 createdAt asc；软删表不返回；
//  - GET /api/kb：仅自己有 kb_member 行的库；软删过滤；按 joinedAt desc；
//  - GET /api/kb/:id/docs：非 kb 成员 403；按 updatedAt desc；软删文档不返回；kind 过滤。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "./charHarness.js";

let h: CharHarness;

beforeAll(async () => {
  h = await setupCharHarness("gx-m3-list-");
  await h.createUser("u_a", { email: "a@example.com" });
  await h.createUser("u_b", { email: "b@example.com" });
  await h.createUser("u_out", { email: "out@example.com" });
});
afterAll(() => h.cleanup());

async function mkBase(owner: string, name: string, createdAt: Date) {
  const b = await h.prisma.base.create({ data: { name, createdBy: owner, createdAt } });
  await h.prisma.member.create({ data: { baseId: b.id, userId: owner, role: "owner", joinedAt: createdAt } });
  return b.id;
}

describe("GET /api/bases membership 过滤", () => {
  it("只返回自己是成员的库，且按 joinedAt asc；软删库不返回", async () => {
    const old = await mkBase("u_a", "旧库", new Date("2026-01-01T00:00:00Z"));
    await mkBase("u_a", "新库", new Date("2026-03-01T00:00:00Z"));
    await mkBase("u_b", "B 的库", new Date("2026-02-01T00:00:00Z"));
    // 加入后又软删：仍有 member 行，但 base.deletedAt 非空，须被过滤。
    await h.prisma.base.update({ where: { id: old }, data: { deletedAt: new Date() } });

    const res = await h.app.request("/api/bases", { headers: await h.auth("u_a") });
    expect(res.status).toBe(200);
    const { bases } = await json<{ bases: Array<{ id: string; name: string }> }>(res);
    expect(bases.map((x) => x.name)).toEqual(["新库"]);

    const bRes = await h.app.request("/api/bases", { headers: await h.auth("u_b") });
    const { bases: bBases } = await json<{ bases: Array<{ name: string }> }>(bRes);
    expect(bBases.map((x) => x.name)).toEqual(["B 的库"]);
  });

  it("无 token 401", async () => {
    const res = await h.app.request("/api/bases");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tables?baseId 排序与守卫", () => {
  it("非成员 403；成员按 createdAt asc；软删表不返回", async () => {
    const baseId = await mkBase("u_a", "表序库", new Date("2026-01-01T00:00:00Z"));
    await h.prisma.table.create({
      data: { baseId, name: "晚建表", primaryFieldId: "", createdBy: "u_a", createdAt: new Date("2026-02-02T00:00:00Z") },
    });
    await h.prisma.table.create({
      data: { baseId, name: "早建表", primaryFieldId: "", createdBy: "u_a", createdAt: new Date("2026-01-02T00:00:00Z") },
    });
    const gone = await h.prisma.table.create({
      data: { baseId, name: "已删表", primaryFieldId: "", createdBy: "u_a", createdAt: new Date("2026-01-03T00:00:00Z") },
    });
    await h.prisma.table.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const forbidden = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("u_out") });
    expect(forbidden.status).toBe(403);

    const res = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("u_a") });
    const { tables } = await json<{ tables: Array<{ name: string }> }>(res);
    expect(tables.map((x) => x.name)).toEqual(["早建表", "晚建表"]);
  });

  it("缺 baseId 400", async () => {
    const res = await h.app.request("/api/tables", { headers: await h.auth("u_a") });
    expect(res.status).toBe(400);
  });
});

async function mkKb(owner: string, name: string, joinedAt: Date) {
  const k = await h.prisma.knowledgeBase.create({ data: { name, createdBy: owner, createdAt: joinedAt } });
  await h.prisma.kbMember.create({ data: { kbId: k.id, userId: owner, role: "owner", joinedAt } });
  return k.id;
}

describe("GET /api/kb membership 过滤", () => {
  it("只返回成员库；软删过滤；按 joinedAt desc", async () => {
    await mkKb("u_a", "一月库", new Date("2026-01-01T00:00:00Z"));
    const later = await mkKb("u_a", "三月库", new Date("2026-03-01T00:00:00Z"));
    await mkKb("u_b", "B 库", new Date("2026-02-01T00:00:00Z"));
    await h.prisma.knowledgeBase.update({ where: { id: later }, data: { deletedAt: new Date() } });

    const res = await h.app.request("/api/kb", { headers: await h.auth("u_a") });
    const { knowledgeBases } = await json<{ knowledgeBases: Array<{ name: string }> }>(res);
    // 现状：kb 列表 joinedAt desc（与 bases 的 asc 相反），这是刻意锁定的现状。
    expect(knowledgeBases.map((x) => x.name)).toEqual(["一月库"]);

    const out = await h.app.request("/api/kb", { headers: await h.auth("u_out") });
    const body = await json<{ knowledgeBases: unknown[] }>(out);
    expect(body.knowledgeBases).toEqual([]);
  });
});

describe("GET /api/kb/:id/docs 排序与守卫", () => {
  it("非成员 403；按 updatedAt desc；软删不返回；kind 过滤生效", async () => {
    const kbId = await mkKb("u_a", "文档库", new Date("2026-01-01T00:00Z"));
    await h.prisma.kbDoc.create({
      data: { kbId, kind: "doc", title: "旧档", content: "", searchText: "", createdBy: "u_a", updatedBy: "u_a",
        createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z") },
    });
    await h.prisma.kbDoc.create({
      data: { kbId, kind: "doc", title: "新档", content: "", searchText: "", createdBy: "u_a", updatedBy: "u_a",
        createdAt: new Date("2026-02-01T00:00:00Z"), updatedAt: new Date("2026-02-01T00:00:00Z") },
    });
    const canvas = await h.prisma.kbDoc.create({
      data: { kbId, kind: "canvas", title: "画布", content: "[]", searchText: "", createdBy: "u_a", updatedBy: "u_a",
        createdAt: new Date("2026-03-01T00:00:00Z"), updatedAt: new Date("2026-03-01T00:00:00Z") },
    });
    await h.prisma.kbDoc.update({ where: { id: canvas.id }, data: { deletedAt: new Date(), deletedBy: "u_a" } });

    const forbidden = await h.app.request(`/api/kb/${kbId}/docs`, { headers: await h.auth("u_out") });
    expect(forbidden.status).toBe(403);

    const res = await h.app.request(`/api/kb/${kbId}/docs`, { headers: await h.auth("u_a") });
    const { docs } = await json<{ docs: Array<{ title: string; kind: string }> }>(res);
    expect(docs.map((x) => x.title)).toEqual(["新档", "旧档"]);
    expect(docs.every((x) => x.kind === "doc")).toBe(true);

    const canvasRes = await h.app.request(`/api/kb/${kbId}/docs?kind=canvas`, { headers: await h.auth("u_a") });
    const { docs: canvases } = await json<{ docs: unknown[] }>(canvasRes);
    expect(canvases).toEqual([]);
  });
});

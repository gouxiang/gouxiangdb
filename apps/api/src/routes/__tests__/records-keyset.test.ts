// M1/S7 路由层端到端（真迁移临时库 + 真 Hono records 路由，仅 mock JWT）：
//   - keyset 生效（read=on+keyset=on）：GET 列表响应十键（S0 七键 + nextCursor/hasMore/degraded），
//     首页带游标、cursor 翻页不重不漏、末页 hasMore=false；
//   - keyset 关（read=on/keyset=off）：响应仍是 S0 七键，旧客户端字节级键集合不变；
//   - 坏游标 → 400 统一信封；offset 超窗 → 400；
//   - 老客户端 offset 窗口内仍 200 且与游标页同一窗口。
// 同 S6/S7 纪律：牵 db.js 的路由/守卫在 globalThis.__gx_prisma 设置后动态 import。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve("u1") }));

const N = 53;
const PAGE = 20; // 53 → 3 页（20/20/13）
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let tableId: string;
let fieldId: string;
let mod: {
  records: typeof import("../records.js")["records"];
  errorResponse: typeof import("../../guards.js")["errorResponse"];
};

function buildApp() {
  const app = new Hono();
  app.route("/records", mod.records);
  app.onError((err, c) => mod.errorResponse(c, err));
  return app;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-keyset-route-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [routes, guards] = await Promise.all([
    import("../records.js"),
    import("../../guards.js"),
  ]);
  mod = { records: routes.records, errorResponse: guards.errorResponse };
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.GX_M1_SIDECAR = "on";
  process.env.GX_M1_SIDECAR_READ = "on";
  process.env.GX_M1_KEYSET = "on";
  delete process.env.GX_M1_OFFSET_WINDOW;
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.member.deleteMany({});
  await prisma.roleAssignment.deleteMany({}); // subjectId 不是外键，删 users 不会级联掉
  await prisma.user.deleteMany({});
  await prisma.base.deleteMany({});

  await prisma.user.create({
    data: { id: "u1", email: "u1@example.com", displayName: "U1", passwordHash: "x" },
  });
  // 权限核心模型（二）：members.role 不再放行，u1 挂超级管理员才读得到这张表。
  await prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "u1", scopeType: "workspace", createdBy: "seed" },
  });
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u1" } });
  await prisma.member.create({ data: { baseId: base.id, userId: "u1", role: "editor" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u1" },
  });
  tableId = table.id;
  fieldId = (await prisma.field.create({
    data: { tableId, name: "名称", type: "singleLineText", order: 0 },
  })).id;
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: fieldId } });

  const baseMs = Date.parse("2026-03-01T00:00:00.000Z");
  const data = [];
  for (let i = 0; i < N; i++) {
    data.push({
      tableId,
      fields: JSON.stringify({ [fieldId]: `行${String(i).padStart(3, "0")}` }),
      createdBy: "u1", updatedBy: "u1",
      createdAt: new Date(baseMs + i), updatedAt: new Date(baseMs + i),
    });
  }
  await prisma.record.createMany({ data });

  // 引擎永久单一化后，base/table 裸建无 nav 节点 -> GET 守卫反查 fail-closed。补 nav 同步。
  // u1 是超管（isWorkspaceOwner 硬短路），放行不依赖节点策略投影。
  const { syncNavFromEntitiesTx } = await import("../../domain/nav/sync.js");
  await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /records keyset 生效（read=on,keyset=on）", () => {
  it("响应十键：S0 七键 + nextCursor/hasMore/degraded；首页带游标", async () => {
    const res = await buildApp().request(`/records?tableId=${tableId}&limit=${PAGE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["aggregations", "allFields", "degraded", "fields", "filteredTotal",
        "groups", "hasMore", "nextCursor", "records", "total"],
    );
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
    expect(body.degraded).toEqual([]);
    expect(body.records).toHaveLength(PAGE);
    expect(body.total).toBe(N);
    expect(body.filteredTotal).toBe(N);
  });

  it("逐页用 nextCursor 翻完：3 页拼接为全部 53 行、无重复，末页 hasMore=false", async () => {
    const app = buildApp();
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    for (;;) {
      const q = `/records?tableId=${tableId}&limit=${PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const body = await (await app.request(q)).json();
      seen.push(...body.records.map((r: { id: string }) => r.id));
      pages++;
      if (!body.hasMore) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      cursor = body.nextCursor;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
  });

  it("坏游标 → 400 {error,code} 统一信封", async () => {
    const bad = encodeURIComponent("a.b/c");
    const res = await buildApp().request(`/records?tableId=${tableId}&cursor=${bad}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("offset 超窗（>=limit×5）→ 400；窗口内 → 200", async () => {
    const over = await buildApp().request(`/records?tableId=${tableId}&limit=${PAGE}&offset=100`);
    expect(over.status).toBe(400);
    const ob = await over.json();
    expect(ob.error).toContain("cursor");

    const inside = await buildApp().request(`/records?tableId=${tableId}&limit=${PAGE}&offset=40`);
    expect(inside.status).toBe(200);
    const ib = await inside.json();
    expect(ib.records).toHaveLength(13); // 53-40
  });
});

describe("GET /records keyset 未生效（键集合向后兼容）", () => {
  it("keyset=off（read 仍 on）：响应仍是 S0 七键，不传游标三键", async () => {
    process.env.GX_M1_KEYSET = "off";
    const res = await buildApp().request(`/records?tableId=${tableId}&limit=${PAGE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["aggregations", "allFields", "fields", "filteredTotal", "groups", "records", "total"],
    );
    expect("nextCursor" in body).toBe(false);
    // 旧 offset slice 行为不变
    expect(body.records).toHaveLength(PAGE);
  });

  it("read=off：即便带 cursor 参数也忽略，响应七键且不校验游标", async () => {
    process.env.GX_M1_SIDECAR_READ = "off";
    const res = await buildApp().request(`/records?tableId=${tableId}&cursor=garbage!!!`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["aggregations", "allFields", "fields", "filteredTotal", "groups", "records", "total"],
    );
  });

  it("keyset=on 但 offset 超窗：keyset 未生效时不施加窗口（read=off 老行为）", async () => {
    process.env.GX_M1_SIDECAR_READ = "off";
    const res = await buildApp().request(`/records?tableId=${tableId}&limit=${PAGE}&offset=9999`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(0); // 旧内存 slice 越界空页，不报错
  });
});

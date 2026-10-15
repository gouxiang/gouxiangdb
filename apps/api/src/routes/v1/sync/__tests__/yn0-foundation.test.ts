// YN0 服务端同步地基契约测试（真迁移临时库 + 真 createApp + 真 JWT，不 mock）。
// 设计权威：DESIGN-OFFLINE-SYNC §4.1 / §11 / §13 / §15.2。
//
// 覆盖：
//  A. 只增迁移真的在干净库落地：四张 sync_* 表存在且为空（列名 camelCase 由 Prisma client 验证）。
//  B. 总门 GX_SYNC_SERVER 默认 off：GET /api/v1/sync 在【任何鉴权/DB 之前】404 SYNC_DISABLED；
//     即使带登录态也 404（门在鉴权之前）。
//  C. off 不写任何 sync_* 表（默认零行为）。
//  D. on + 未登录 -> 401（门放行后鉴权拦截，证明门与鉴权是两道独立闸）。
//  E. on + 登录 -> 200，契约 {sync:true, phase, serverVersion}。
//  F. 同步面独立于企业双 flag：强制 GX_ENTERPRISE_ORG=off 时（同步仍 on）同步探针可达，
//     而 /api/v1/meta（企业面）404——证明同步组不寄生在企业门内。
//  G. /api/v1/meta 增 additive 字段 sync（企业面 on 时），随开关 true/false。

import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const PATH = "/api/v1/sync";

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("yn0_user");
}, 120_000);

afterAll(async () => {
  await h.cleanup();
});

const SYNC_TABLES = [
  "sync_op_log",
  "sync_entity_versions",
  "sync_incoming",
  "sync_subscriptions",
] as const;

async function tableExists(name: string): Promise<boolean> {
  const rows = await h.prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
  );
  return rows.length === 1;
}

async function tableEmpty(name: string): Promise<boolean> {
  const rows = await h.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*) AS n FROM "${name}"`,
  );
  return Number(rows[0].n) === 0;
}

function withEnv<K>(key: string, value: string | undefined, fn: () => Promise<K>): Promise<K> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

describe("A. 只增迁移在干净库落地", () => {
  it("四张 sync_* 表存在且为空（不回填存量）", async () => {
    for (const t of SYNC_TABLES) {
      expect(await tableExists(t)).toBe(true);
      expect(await tableEmpty(t)).toBe(true);
    }
  });

  it("Prisma client 认得 camelCase 列（create/findMany round-trip，不依赖列名 snake_case）", async () => {
    const created = await h.prisma.syncSubscription.create({
      data: { clientId: "yn0_c1", scopeType: "base", scopeId: "yn0_b1", actorId: "yn0_user" },
    });
    expect(created.cursorSeq).toBe(BigInt(0));
    expect(created.snapshotDone).toBe(false);
    const got = await h.prisma.syncSubscription.findUnique({ where: { id: created.id } });
    expect(got?.scopeId).toBe("yn0_b1");
    await h.prisma.syncSubscription.delete({ where: { id: created.id } });
  });
});

describe("B/C. 默认 off：门在鉴权/DB 之前 404，且零写入", () => {
  beforeEach(() => {
    delete process.env.GX_SYNC_SERVER;
  });

  it("未登录 + off -> 404 SYNC_DISABLED（不是 401，证明门在鉴权前）", async () => {
    const res = await h.app.request(PATH, { method: "GET" });
    expect(res.status).toBe(404);
    const body = await json<{ code: string }>(res);
    expect(body.code).toBe("SYNC_DISABLED");
  });

  it("登录态 + off -> 仍是 404 SYNC_DISABLED", async () => {
    const res = await h.app.request(PATH, { method: "GET", headers: await h.auth("yn0_user") });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });

  it("off 下探测后四张表仍为空（零额外写）", async () => {
    await h.app.request(PATH, { method: "GET" });
    for (const t of SYNC_TABLES) expect(await tableEmpty(t)).toBe(true);
  });
});

describe("D/E. 开关 on：门放行，鉴权独立，探针 200", () => {
  it("on + 未登录 -> 401", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request(PATH, { method: "GET" });
      expect(res.status).toBe(401);
    }));

  it("on + 登录 -> 200，契约字段齐全", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth("yn0_user") });
      expect(res.status).toBe(200);
      const body = await json<{
        apiVersion: string;
        sync: boolean;
        phase: string;
        serverVersion: string;
        auth: { userId: string; workspaceId: string | null };
      }>(res);
      expect(body.apiVersion).toBe("v1");
      expect(body.sync).toBe(true);
      // 阶段标识随 YN 推进刷新（当前 YN6：+冲突双版本/resolve/resolved 审计）。
      expect(body.phase).toBe("YN7");
      expect(typeof body.serverVersion).toBe("string");
      expect(body.auth.userId).toBe("yn0_user");
    }));

  it("笔误值（opn）按 fail-closed 仍 404", () =>
    withEnv("GX_SYNC_SERVER", "opn", async () => {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth("yn0_user") });
      expect(res.status).toBe(404);
    }));
});

describe("F. 同步面挂载独立于企业门（结构性 + 可达性）", () => {
  // 同步组在 app.ts 中挂在 `if (config.enterpriseOrg || config.enterpriseNav)` 块【之外】，
  // 故不寄生企业面。企业双 flag 是启动期冻结快照、运行时改 env 不摘挂，无法在同一 app
  // 实例内切 org=off 来对拍；这里用"同步路由模块零 import 企业开关/组织模块"来守住结构边界，
  // 并确认探针在 sync=on 下可达（可达性本身即证明它没被企业门挡住）。
  it("sync 路由源文件不依赖企业 flag/组织模块（注册表式独立能力）", async () => {
    const src = await fs.promises.readFile(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("enterpriseOrg");
    expect(src).not.toContain("enterpriseNav");
    expect(src).toContain("syncServerEnabled");
  });

  it("sync=on 下探针可达（不被企业门拦截）", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth("yn0_user") });
      expect(res.status).toBe(200);
    }));
});

describe("G. /api/v1/meta additive 字段 sync", () => {
  it("企业面默认 on 时 meta 带 sync，随开关变化", async () => {
    const headers = await h.auth("yn0_user");
    await withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request("/api/v1/meta", { method: "GET", headers });
      expect(res.status).toBe(200);
      expect((await json<{ sync: boolean }>(res)).sync).toBe(true);
    });
    await withEnv("GX_SYNC_SERVER", undefined, async () => {
      const res = await h.app.request("/api/v1/meta", { method: "GET", headers });
      expect((await json<{ sync: boolean }>(res)).sync).toBe(false);
    });
  });
});

// M5/S6 GX_M5_SEARCH 路由门测试。
//
// 覆盖：
//  1) parseM5SearchFlag 纯函数表驱动（仅精确小写 shadow/on，其余含大写一律 off）；
//  2) off：/api/v1/search 不挂载，带合法 token 请回落 v1 自身 404（NOT_FOUND），
//     且临时数据目录不产生 search.db（不建库/零连接的文件系统证据）；
//  3) on/shadow：子路由挂载，带合法 token GET /api/v1/search 走 S7 真实处理器（不再 501）：
//     on 非空 q 返回新统一检索 §9 信封（items/mode）；空 q 在打开 search.db 前短路回空壳；
//     shadow 空 q 回旧链空形 {records:[],docs:[]}（对拍 S7 细节另见 query-v1-route.test）；
//  4) 旧 GET /api/search 不随 flag 摘除（空 q 200，旧链路字节不变姿态）；
//  5) 企业双 flag 全 off 时 /api/v1 整体不挂载，m5Search=on 亦不可达（与所有 v1 子面同姿态，
//     app.ts 挂载条件不含 m5Search，固定该边界防 S7 误判）。
//
// config 在模块求值时按当时 process.env 冻结、app 在 import 时按 flag 装配，
// 故每态 vi.resetModules() 后动态 import（同 __tests__/deploy-config.test.ts 先例）；
// 共享一份已迁移临时库与同一个注入 globalThis.__gx_prisma 的 PrismaClient，避免重复迁移。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

import { parseM5SearchFlag } from "../../../configM5Search.js";

const JWT_SECRET = "m5-s6-gate-secret-at-least-16-chars";
const TOKEN_TTL = 7 * 24 * 60 * 60;

const PREV: Record<string, string | undefined> = {};
function setGateEnv(flag: string | undefined, orgFlag?: string): void {
  if (flag === undefined) delete process.env.GX_M5_SEARCH;
  else process.env.GX_M5_SEARCH = flag;
  if (orgFlag === undefined) {
    delete process.env.GX_ENTERPRISE_ORG;
    delete process.env.GX_ENTERPRISE_NAV;
  } else {
    process.env.GX_ENTERPRISE_ORG = orgFlag;
    process.env.GX_ENTERPRISE_NAV = orgFlag;
  }
}

let tmpDir: string;
let prisma: PrismaClient;
let token: string;

interface BuiltApp {
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  flag: string;
}

beforeAll(async () => {
  for (const k of [
    "GX_M5_SEARCH", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV",
    "DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV", "GX_RATE_LIMIT",
  ]) {
    PREV[k] = process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m5s6-gate-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "gate.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const passwordHash = await bcrypt.hash("password123", 10);
  await prisma.user.create({
    data: {
      id: "gate-user", email: "gate@x.com", displayName: "gate",
      passwordHash, status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  const now = Math.floor(Date.now() / 1000);
  token = await sign({ userId: "gate-user", tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function buildApp(flag: string | undefined, orgFlag?: string): Promise<BuiltApp> {
  setGateEnv(flag, orgFlag);
  vi.resetModules();
  const configMod = await import("../../../config.js");
  const appMod = await import("../../../app.js");
  const app = appMod.createApp().app as unknown as BuiltApp["app"];
  return { app, flag: configMod.config.m5Search };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function listSearchDbFiles(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f === "search.db" || f.startsWith("search.db"));
}

/**
 * 写总门覆盖键（app_settings 的 search.enabled）。
 * 必须在 buildApp 之后调用：buildApp 会 vi.resetModules()，之后 import 的才是同一份模块视图。
 */
async function setSearchEnabled(v: "on" | "off" | "inherit"): Promise<void> {
  const { EmbeddingConfigStore } = await import("../../../domain/search/embeddingConfig.js");
  await new EmbeddingConfigStore(prisma, JWT_SECRET).setSearchEnabled(v);
}

describe("parseM5SearchFlag 纯函数（表驱动）", () => {
  const cases: Array<[string | undefined, ReturnType<typeof parseM5SearchFlag>]> = [
    [undefined, "off"],
    ["", "off"],
    ["off", "off"],
    ["ON", "off"],
    ["On", "off"],
    ["SHADOW", "off"],
    ["shadow", "shadow"],
    ["on", "on"],
    ["garbage", "off"],
    [" on ", "on"],
    ["  shadow  ", "shadow"],
    ["off ", "off"],
  ];
  for (const [raw, expected] of cases) {
    it(`raw=${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(parseM5SearchFlag(raw)).toBe(expected);
    });
  }
});

describe("GX_M5_SEARCH=off（默认，含未设置）", () => {
  for (const flag of [undefined, "off"] as const) {
    it(`flag=${flag === undefined ? "未设置" : "off"}：/api/v1/search 未挂载 -> 404 NOT_FOUND`, async () => {
      const { app } = await buildApp(flag);
      const res = await app.request("/api/v1/search?q=x", { headers: authHeaders() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("NOT_FOUND");
    });

    it(`flag=${flag === undefined ? "未设置" : "off"}：零建库证据，数据目录无 search.db*`, async () => {
      const { app } = await buildApp(flag);
      await app.request("/api/v1/search", { headers: authHeaders() });
      expect(listSearchDbFiles()).toEqual([]);
    });

    // 语义适配（P3 权威顺序变更）：总门 off 时**只有运营/出网端点**落 404；配置面端点继续可达，
    // 否则 search.enabled 永远无法在界面上被打开（先有鸡还是先有蛋）。配置面仍受 role_owner 门，
    // 本夹具的 gate-user 非 owner，故表现为 403（证明端点已挂载，不是 404 未挂载）。
    it(`flag=${flag === undefined ? "未设置" : "off"}：运营/出网端点 404 且零建库；配置面按 owner 门 403`, async () => {
      const { app } = await buildApp(flag);
      const gated: Array<[string, RequestInit?]> = [
        ["/api/v1/admin/search/status", { headers: authHeaders() }],
        ["/api/v1/admin/reindex", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: "{}" }],
        ["/api/v1/admin/embedding/test-connection", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: "{}" }],
      ];
      for (const [url, init] of gated) {
        const res = await app.request(url, init);
        expect(res.status, url).toBe(404);
      }
      const configFace: Array<[string, RequestInit?]> = [
        ["/api/v1/admin/embedding/config", { headers: authHeaders() }],
        ["/api/v1/admin/embedding/config", { method: "PATCH", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: "{}" }],
        ["/api/v1/admin/embedding/api-key/rotate", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "x" }) }],
        ["/api/v1/admin/embedding/api-key", { method: "DELETE", headers: authHeaders() }],
      ];
      for (const [url, init] of configFace) {
        const res = await app.request(url, init);
        expect(res.status, url).toBe(403); // 非 owner：端点在，只是无权
      }
      expect(listSearchDbFiles()).toEqual([]);
    });
  }

  it("旧 GET /api/search 不被摘除：空 q 返回 200（旧链路形状）", async () => {
    const { app } = await buildApp("off");
    const res = await app.request("/api/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [], docs: [] });
  });
});

describe("GX_M5_SEARCH=on", () => {
  it("config.m5Search=on 且 /api/v1/search 挂载，空 q 返回 S7 新链 §9 空壳（不再是 501 占位）", async () => {
    const built = await buildApp("on");
    expect(built.flag).toBe("on");
    const res = await built.app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; mode: string };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.mode).toBe("like");
  });

  it("非空 q 走真实新链（gate-user 无授权 -> scope 空 -> 200 §9 空壳，非 501/非旧形）", async () => {
    const { app } = await buildApp("on");
    const res = await app.request("/api/v1/search?q=hello", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; mode: string; records?: unknown };
    expect(Array.isArray(body.items)).toBe(true);
    expect("records" in body).toBe(false);
    expect(typeof body.mode).toBe("string");
  });

  it("未登录 -> 401（v1 requireActiveUser 先于处理器）", async () => {
    const { app } = await buildApp("on");
    const res = await app.request("/api/v1/search?q=hello");
    expect(res.status).toBe(401);
  });

  it("旧 GET /api/search 照常存在（空 q 200）", async () => {
    const { app } = await buildApp("on");
    const res = await app.request("/api/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("GX_M5_SEARCH=shadow", () => {
  it("config.m5Search=shadow 且 /api/v1/search 挂载，空 q 回旧链空形（不再是 501；响应真源始终是旧链）", async () => {
    const built = await buildApp("shadow");
    expect(built.flag).toBe("shadow");
    const res = await built.app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [], docs: [] });
  });

  it("旧 GET /api/search 照常存在（空 q 200）", async () => {
    const { app } = await buildApp("shadow");
    const res = await app.request("/api/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("边界：企业双 flag 全 off 时整个 /api/v1 不挂载", () => {
  it("即使 GX_M5_SEARCH=on，/api/v1/search 仍 404（与所有 v1 子面同姿态；S7 前置依赖企业面）", async () => {
    const { app } = await buildApp("on", "off");
    const res = await app.request("/api/v1/search?q=x", { headers: authHeaders() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });
});

// 权威顺序：app_settings.search.enabled 显式 on/off > env > 默认 off。
// 旧实现里 env=off 会让 /search 与 /admin 根本不挂载，后台开关形同虚设；这里钉死"后台置 on 即开"。
// 每组都先 buildApp（内部 vi.resetModules，顺带清掉总门的进程内 TTL 缓存），再写覆盖键。
describe("总门权威顺序：db 覆盖 > env（env=off 也能被后台打开）", () => {
  it("env=off + db=on：/api/v1/search 可用（空 q 回 §9 空壳，非 404）", async () => {
    const { app } = await buildApp("off");
    await setSearchEnabled("on");
    const res = await app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("env=off + db=on：运营面（search/status）随之打开（非 owner 落 403 而非 404）", async () => {
    const { app } = await buildApp("off");
    await setSearchEnabled("on");
    const res = await app.request("/api/v1/admin/search/status", { headers: authHeaders() });
    expect(res.status).toBe(403); // 端点已可达，只是本夹具用户非 owner
    // 同一端点在 db=inherit 时仍是 404：证明 403 来自 owner 门而不是总门失效。
    const off = await buildApp("off");
    await setSearchEnabled("inherit");
    expect((await off.app.request("/api/v1/admin/search/status", { headers: authHeaders() })).status).toBe(404);
  });

  it("env=off + db=off：显式停用压过一切，仍 404", async () => {
    const { app } = await buildApp("off");
    await setSearchEnabled("off");
    const res = await app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
  });

  it("env=off + db=inherit（默认）：零变化，仍 404", async () => {
    const { app } = await buildApp("off");
    await setSearchEnabled("inherit");
    const res = await app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(404);
    // 说明：不在这里断言「无 search.db」——同文件的 GX_M5_SEARCH=on 用例会先建库（共用 tmpDir），
    // 零建库证据由上一组 env=off 用例专门覆盖。
  });

  it("env=on + db=off：后台显式停用也能关掉（覆盖值双向生效）", async () => {
    const { app } = await buildApp("on");
    await setSearchEnabled("off");
    const res = await app.request("/api/v1/search?q=", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

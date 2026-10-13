// GET /api/v1/admin/update/status 端到端（真迁移临时库 + 真 createApp + 真 JWT + 可控 fetch）。
//
// 三个模块图实例（同一临时库，各自 vi.resetModules + env 快照后动态 import app）：
//   unknownApp：不设通道 -> 本机 channel=unknown，断言 latest 且【零出网】；
//   fnosApp   ：GX_UPDATE_CHANNEL=fnos-fpk（本机 platform=darwin -> 有候选也 no_artifact），
//               用可热切换 fetch 桩覆盖正常/401/5xx/无清单资产/UNCONFIGURED/force 缓存/审计；
//   offApp    ：GX_UPDATE_ENABLED=off -> 路由不注册 -> 404 且 fetch 计数为 0。
// 完整 upgrade DTO 内层字节形状在 domain/update/__tests__/service.test.ts 覆盖（需 linux 身份）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "admin-update-secret-at-least-16-chars";
const TOKEN_TTL = 7 * 24 * 60 * 60;
const SHA = "b".repeat(64);

const ENV_KEYS = [
  "GX_UPDATE_ENABLED", "GX_UPDATE_CHANNEL", "GX_UPDATE_TOKEN", "GX_UPDATE_SOURCE",
  "GX_UPDATE_MANIFEST_URL", "GX_UPDATE_ALLOW_PRERELEASE", "GX_ENTERPRISE_ORG",
  "GX_ENTERPRISE_NAV", "DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET",
  "NODE_ENV", "GX_RATE_LIMIT", "GX_VERSION",
] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let auditFile: string;
let prisma: PrismaClient;
let ownerToken: string;
let userToken: string;
type App = { request: (url: string, init?: RequestInit) => Promise<Response> };
let unknownApp: App;
let fnosApp: App;
let offApp: App;

// ---- 可控出网桩（绝不触真网）---------------------------------------------
type Mode = "manifest-ok" | "auth401" | "unreachable500" | "no-manifest-asset" | "deny";
let mode: Mode = "manifest-ok";
let fetchCalls = 0;
const fetchedUrls: string[] = [];

function manifestJson(): unknown {
  return {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "2026-10-20T08:00:00.000Z",
    channels: {
      "fnos-fpk": {
        releases: [{
          version: "0.2.3",
          publishedAt: "2026-10-20T08:00:00.000Z",
          prerelease: false,
          minVersion: null,
          releaseNotes: { format: "text", zh: "本次更新修复若干问题", en: null },
          artifacts: [{
            arch: "x64", platform: "linux",
            filename: "gouxiangdb-0.2.3-x86.fpk", sizeBytes: 63074943, sha256: SHA,
            download: { kind: "release-asset", asset: "gouxiangdb-0.2.3-x86.fpk" },
            signature: null,
          }],
        }],
      },
    },
  };
}

async function controlledFetch(input: string | URL | Request): Promise<Response> {
  fetchCalls += 1;
  const url = String(input);
  fetchedUrls.push(url);
  if (mode === "deny") throw new Error("fail-closed: 测试期间禁止真实出网");
  if (url.includes("/releases?")) {
    if (mode === "auth401") return new Response("{}", { status: 401 });
    if (mode === "unreachable500") return new Response("err", { status: 500 });
    if (mode === "no-manifest-asset") {
      return new Response(JSON.stringify([{ tag_name: "v0.2.3", assets: [{ name: "other.txt" }] }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify([{ tag_name: "v0.2.3", assets: [{ name: "update-manifest.json" }] }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // manifest 资产 URL。
  if (mode === "auth401") return new Response("{}", { status: 403 });
  return new Response(JSON.stringify(manifestJson()), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

async function tokenFor(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ userId, tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
}

function setEnv(extra: Record<string, string | undefined>): void {
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "u.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  // 版本固定为低于 0.2.3 的可解析值（真实根 package.json 亦为 0.2.2，双保险）。
  process.env.GX_VERSION = "0.2.2";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  // 更新键必须逐次显式重置：三个 app 模块图独立但共享同一 process.env，
  // 否则后一个 loadApp 的通道/开关会污染先加载 app 的 config / service 探测。
  delete process.env.GX_UPDATE_TOKEN;
  delete process.env.GX_UPDATE_MANIFEST_URL;
  delete process.env.GX_UPDATE_SOURCE;
  delete process.env.GX_UPDATE_ALLOW_PRERELEASE;
  delete process.env.GX_UPDATE_CHANNEL;
  delete process.env.GX_UPDATE_ENABLED;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function loadApp(
  extra: Record<string, string | undefined>,
  runtime?: { nodeArch?: string; nodePlatform?: string },
): Promise<App> {
  vi.resetModules();
  setEnv(extra);
  // 显式注入部署身份，使这些集成用例与【宿主机平台】解耦：在 darwin/linux CI 上结论一致。
  // 必须在 import app.js 之前、同一全新模块图内取 runtime 句柄，二者共享同一 service 单例。
  if (runtime) {
    const rt = await import("../updateRuntime.js");
    rt.__setUpdateRuntimeForTest(runtime);
  }
  const mod = await import("../../../app.js");
  return mod.createApp().app as unknown as App;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-admin-update-"));
  auditFile = path.join(tmpDir, ".audit", "audit.logl");

  // 先在首个 env 形态下建库迁移。
  setEnv({});
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({
    data: {
      id: "upd-owner", email: "upd-owner@x.com", displayName: "owner",
      passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  await prisma.user.create({
    data: {
      id: "upd-user", email: "upd-user@x.com", displayName: "user",
      passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  await prisma.roleAssignment.create({
    data: {
      roleId: "role_owner", subjectType: "user", subjectId: "upd-owner",
      scopeType: "workspace", createdBy: "seed",
    },
  });
  ownerToken = await tokenFor("upd-owner");
  userToken = await tokenFor("upd-user");

  vi.stubGlobal("fetch", controlledFetch);

  unknownApp = await loadApp({});
  // fnos 通道这些用例断言「清单仅含 linux fpk，而部署身份=darwin -> no_artifact」。
  // 显式钉死 darwin/x64，避免在 linux 宿主上 process.platform=linux 反而命中而误红。
  fnosApp = await loadApp(
    { GX_UPDATE_CHANNEL: "fnos-fpk", GX_UPDATE_TOKEN: "reader-token" },
    { nodeArch: "x64", nodePlatform: "darwin" },
  );
  offApp = await loadApp({ GX_UPDATE_CHANNEL: "fnos-fpk", GX_UPDATE_ENABLED: "off" });
}, 120000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const owner = () => ({ Authorization: `Bearer ${ownerToken}` });
const userH = () => ({ Authorization: `Bearer ${userToken}` });

function auditLines(): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditFile)) return [];
  return fs
    .readFileSync(auditFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("admin/update/status：鉴权与参数", () => {
  it("未登录 -> 401", async () => {
    const res = await fnosApp.request("/api/v1/admin/update/status");
    expect(res.status).toBe(401);
  });
  it("非 owner -> 403 FORBIDDEN", async () => {
    const res = await fnosApp.request("/api/v1/admin/update/status", { headers: userH() });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FORBIDDEN");
  });
  it("channel 传本地/未知通道（非声明式）-> 400", async () => {
    for (const ch of ["fnos-fpk", "desktop-client", "nope"]) {
      const res = await fnosApp.request(
        `/api/v1/admin/update/status?channel=${ch}`,
        { headers: owner() },
      );
      expect(res.status, ch).toBe(400);
      expect((await res.json()).code).toBe("BAD_REQUEST");
    }
  });
  it("arch/platform/force 非法值 -> 400", async () => {
    const qs = ["arch=mips", "platform=freebsd", "force=yes", "arch=x64&platform=bad"];
    for (const q of qs) {
      const res = await fnosApp.request(`/api/v1/admin/update/status?${q}`, { headers: owner() });
      expect(res.status, q).toBe(400);
      expect((await res.json()).code).toBe("BAD_REQUEST");
    }
  });
});

describe("admin/update/status：unknown 通道零出网", () => {
  it("update=null / channel=unknown，且不发起任何 fetch", async () => {
    const before = fetchCalls;
    const res = await unknownApp.request("/api/v1/admin/update/status", { headers: owner() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(fetchCalls).toBe(before); // 零出网
    expect(Object.keys(body).sort()).toEqual(
      ["checkedAt", "current", "enabled", "newerSchema", "prefetch", "update"].sort(),
    );
    expect(body.enabled).toBe(true);
    expect(body.newerSchema).toBe(false);
    expect(body.update).toBeNull();
    // 方案 A：默认 on 时恒附预缓存快照；从未触发过 → idle 且不含任何 url/token。
    expect(body.prefetch.state).toBe("idle");
    expect(body.prefetch.sha256).toBeNull();
    expect(body.prefetch.receivedBytes).toBe(0);
    expect(JSON.stringify(body.prefetch)).not.toMatch(/token|https?:\/\//);
    expect(body.current.channel).toBe("unknown");
    expect(body.current).toHaveProperty("versionUnparseable");
    expect(typeof body.checkedAt).toBe("string");
  });
});

describe("admin/update/status：fnos 通道（本机 darwin）+ 源错误映射 + 缓存 + 审计", () => {
  it("有更高版本但本机 platform 无匹配 artifact -> 200 update=null（no_artifact）", async () => {
    mode = "manifest-ok";
    const res = await fnosApp.request("/api/v1/admin/update/status", { headers: owner() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current.channel).toBe("fnos-fpk");
    expect(body.current.version).toBe("0.2.2");
    expect(body.update).toBeNull(); // darwin 不匹配 linux fpk
  });

  it("上游 401/403 -> 502 UPDATE_SOURCE_AUTH（错误体不透传）", async () => {
    mode = "auth401";
    const res = await fnosApp.request("/api/v1/admin/update/status?force=1", { headers: owner() });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("UPDATE_SOURCE_AUTH");
    expect(body.error).toBe("更新源凭证无效，请联系部署人员");
    expect(JSON.stringify(body)).not.toMatch(/192\.168|internal|swagger/i);
  });

  it("上游 5xx -> 502 UPDATE_SOURCE_UNREACHABLE", async () => {
    mode = "unreachable500";
    const res = await fnosApp.request("/api/v1/admin/update/status?force=1", { headers: owner() });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("UPDATE_SOURCE_UNREACHABLE");
  });

  it("release 列表无清单资产 -> 502 UPDATE_MANIFEST_INVALID", async () => {
    mode = "no-manifest-asset";
    const res = await fnosApp.request("/api/v1/admin/update/status?force=1", { headers: owner() });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("UPDATE_MANIFEST_INVALID");
  });

  it("TTL 内重复检查不重复打源；force=1 旁路", async () => {
    mode = "manifest-ok";
    await fnosApp.request("/api/v1/admin/update/status?force=1", { headers: owner() });
    const afterForce = fetchCalls;
    // releases + manifest 至少 2 次。
    expect(afterForce).toBeGreaterThanOrEqual(2);
    await fnosApp.request("/api/v1/admin/update/status", { headers: owner() });
    expect(fetchCalls).toBe(afterForce); // 命中缓存
    await fnosApp.request("/api/v1/admin/update/status?force=1", { headers: owner() });
    expect(fetchCalls).toBeGreaterThan(afterForce); // force 旁路
  });

  it("审计 JSONL 落 update_checked 行，且全 detail 无 url/token/authorization", () => {
    const rows = auditLines().filter((r) => r.event === "update_checked");
    expect(rows.length).toBeGreaterThan(0);
    const verdicts = rows.map((r) => (r.detail as Record<string, unknown>).verdict);
    expect(verdicts).toContain("no_artifact");
    expect(verdicts).toContain("source_error");
    for (const r of rows) {
      const d = r.detail as Record<string, unknown>;
      expect(d).toHaveProperty("channel");
      expect(d).toHaveProperty("currentVersion");
      expect(d).toHaveProperty("sourceKind");
      expect(d).toHaveProperty("durationMs");
      const flat = JSON.stringify(d).toLowerCase();
      expect(flat).not.toContain("url");
      expect(flat).not.toContain("token");
      expect(flat).not.toContain("authorization");
      expect(flat).not.toContain("http");
      // 禁止 §5.5 之外的字段（白名单）。
      const allowed = new Set([
        "channel", "currentVersion", "candidateVersion", "verdict",
        "sourceKind", "durationMs", "errorCode",
      ]);
      for (const k of Object.keys(d)) expect(allowed.has(k), `非法审计字段 ${k}`).toBe(true);
    }
    // 源错误行带 errorCode，成功行不带。
    const errRow = rows.find((r) =>
      (r.detail as Record<string, unknown>).verdict === "source_error");
    expect((errRow!.detail as Record<string, unknown>).errorCode).toBeTruthy();
    expect(errRow!.status).toBe(502);
  });
});

describe("admin/update/status：未配置 token（默认部署）", () => {
  it("gitea 源空 token -> 502 UPDATE_SOURCE_UNCONFIGURED（出网前拦截）", async () => {
    // 新模块图：不设 GX_UPDATE_TOKEN。
    const app = await loadApp({ GX_UPDATE_CHANNEL: "fnos-fpk" });
    const before = fetchCalls;
    const res = await app.request("/api/v1/admin/update/status", { headers: owner() });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("UPDATE_SOURCE_UNCONFIGURED");
    expect(fetchCalls).toBe(before); // 空 token 不出网
  });
});

describe("admin/update/status：GX_UPDATE_ENABLED=off", () => {
  it("路由不注册 -> 404，且零出网", async () => {
    const before = fetchCalls;
    const res = await offApp.request("/api/v1/admin/update/status", { headers: owner() });
    expect(res.status).toBe(404);
    expect(fetchCalls).toBe(before);
  });
});

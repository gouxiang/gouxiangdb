// GET /api/v1/admin/update/download + POST /download-ticket 端到端（S4）。
//
// 独立文件（独立 vitest worker，RSS 基线干净）：真迁移临时库 + 真 createApp + 真 JWT +
// 可控 fetch（清单 + 可编排的资产流）。本机 darwin，但换票请求体显式带 arch=x64/platform=linux
// （身份参数语义同 status），故仍能命中清单里的 linux/x64 fpk 资产走完整下载链路。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { issueDownloadTicket } from "../../../domain/update/download.js";
import type { UpdatePrefetchDTO } from "@gx/shared-types";

const JWT_SECRET = "update-dl-secret-at-least-16-chars!";
const TOKEN_TTL = 7 * 24 * 60 * 60;
const SHA = "c".repeat(64);
const FILENAME = "gouxiangdb-0.2.3-x86.fpk";
const TOTAL = 63_074_943;

const ENV_KEYS = [
  "GX_UPDATE_ENABLED", "GX_UPDATE_CHANNEL", "GX_UPDATE_TOKEN", "GX_UPDATE_SOURCE",
  "GX_UPDATE_MANIFEST_URL", "GX_UPDATE_ALLOW_PRERELEASE", "GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS",
  "GX_UPDATE_TICKET_TTL_MS", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "DATABASE_URL",
  "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV", "GX_RATE_LIMIT", "GX_VERSION",
] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let auditFile: string;
let prisma: PrismaClient;
let ownerToken: string;
let userToken: string;
type App = { request: (url: string, init?: RequestInit) => Promise<Response> };
let app: App;

// 资产流行为：可编排（正常全量 / Range 切片 / 首块后停滞 / 上游错误码）。
type StreamMode = "full" | "stall" | "upstream401";
let streamMode: StreamMode = "full";
let rangeSeen: string | null = null;
let authSeen: string | null = null;
const downloadedUrls: string[] = [];

function manifestJson(): unknown {
  return {
    schemaVersion: 1, product: "gouxiangdb", generatedAt: "2026-10-20T08:00:00.000Z",
    channels: {
      "fnos-fpk": {
        releases: [{
          version: "0.2.3", publishedAt: "2026-10-20T08:00:00.000Z", prerelease: false,
          minVersion: null, releaseNotes: { format: "text", zh: "修复若干问题", en: null },
          artifacts: [{
            arch: "x64", platform: "linux", filename: FILENAME, sizeBytes: TOTAL, sha256: SHA,
            download: { kind: "release-asset", asset: FILENAME }, signature: null,
          }],
        }],
      },
    },
  };
}

// 生成一块可丢弃内容（不长期持有），用于大文件流。
function chunk(size: number, fill: number): Uint8Array {
  const b = new Uint8Array(size);
  b.fill(fill & 0xff);
  return b;
}

async function controlledFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input);
  if (url.includes("/releases?")) {
    return new Response(
      JSON.stringify([{ tag_name: "v0.2.3", assets: [{ name: "update-manifest.json" }] }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.endsWith("/update-manifest.json")) {
    return new Response(JSON.stringify(manifestJson()), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  // 资产下载 URL（自拼 releases/download/...，无 query）。
  if (url.includes("/releases/download/")) {
    downloadedUrls.push(url);
    const h = new Headers(init?.headers as HeadersInit | undefined);
    rangeSeen = h.get("Range");
    authSeen = h.get("Authorization");

    if (streamMode === "upstream401") return new Response("denied", { status: 401 });

    if (streamMode === "stall") {
      // 发一个 64KiB 头块后永久停滞（不 close、不再 enqueue），逼服务端空闲超时；
      // 服务端 abort 后随之 error，让 reader.read reject、pump 收敛。
      const signal: AbortSignal | undefined = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk(64 * 1024, 7));
          signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Length": String(TOTAL), "Accept-Ranges": "bytes", "ETag": '"v1"' },
      });
    }

    // full：支持 Range。按需逐块生成，不整包驻留。
    const block = 256 * 1024; // 256KiB
    let start = 0;
    let end = TOTAL - 1;
    let status = 200;
    const respHeaders = new Headers();
    respHeaders.set("Accept-Ranges", "bytes");
    respHeaders.set("ETag", '"v1"');
    if (rangeSeen) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeSeen.trim());
      if (m) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), TOTAL - 1);
        status = 206;
      }
    }
    const len = end - start + 1;
    if (status === 206) {
      respHeaders.set("Content-Range", `bytes ${start}-${end}/${TOTAL}`);
    }
    respHeaders.set("Content-Length", String(len));
    // pull 驱动：背压自然受控，消费端 cancel 后不再 pull，不会向已关闭控制器 enqueue。
    let pos = start;
    const body = new ReadableStream({
      pull(controller) {
        const remaining = end - pos + 1;
        const n = Math.min(block, remaining);
        controller.enqueue(chunk(n, (Math.floor(pos / block)) & 0xff));
        pos += n;
        if (pos > end) controller.close();
      },
    });
    return new Response(body, { status, headers: respHeaders });
  }
  throw new Error(`unexpected fetch: ${url}`);
}

async function tokenFor(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ userId, tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
}

function setEnv(extra: Record<string, string | undefined>): void {
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "d.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_VERSION = "0.2.2";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  for (const k of [
    "GX_UPDATE_TOKEN", "GX_UPDATE_MANIFEST_URL", "GX_UPDATE_SOURCE",
    "GX_UPDATE_ALLOW_PRERELEASE", "GX_UPDATE_CHANNEL", "GX_UPDATE_ENABLED",
    "GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS", "GX_UPDATE_TICKET_TTL_MS",
    "GX_UPDATE_PREFETCH_ENABLED", "GX_UPDATE_PREFETCH_DIR",
    "GX_UPDATE_PREFETCH_IDLE_TIMEOUT_MS",
  ]) delete process.env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-update-dl-"));
  auditFile = path.join(tmpDir, ".audit", "audit.logl");

  setEnv({});
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({
    data: {
      id: "dl-owner", email: "dl-owner@x.com", displayName: "owner",
      passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  await prisma.user.create({
    data: {
      id: "dl-user", email: "dl-user@x.com", displayName: "user",
      passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  await prisma.roleAssignment.create({
    data: {
      roleId: "role_owner", subjectType: "user", subjectId: "dl-owner",
      scopeType: "workspace", createdBy: "seed",
    },
  });
  ownerToken = await tokenFor("dl-owner");
  userToken = await tokenFor("dl-user");

  vi.stubGlobal("fetch", controlledFetch);

  vi.resetModules();
  setEnv({
    GX_UPDATE_CHANNEL: "fnos-fpk",
    GX_UPDATE_TOKEN: "reader-token",
    // 空闲超时压到 300ms：stall 用例快速验证；正常/Range 用例以 setInterval(0) 连续供块，
    // 块间隔远小于 300ms，不会误触发。
    GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS: "300",
  });
  const mod = await import("../../../app.js");
  app = mod.createApp().app as unknown as App;
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

const owner = () => ({ Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" });
const userH = () => ({ Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" });

// 直造票：download 端点只验票（不关心票从哪来），且 resolveDownload 用【票载】arch/platform
// 定位资产（不经部署探测），故在 darwin 机也能验证 linux/x64 资产的完整流式链路。
// 换票端点本身的 200 happy-path（linux upgrade + 发票）由域级 service/download 单测覆盖；
// 集成层在本机 darwin 只能验证换票的 409 现场闸门。
function directTicket(over: Partial<{ version: string; filename: string; ttlMs: number; now: number }> = {}): string {
  return issueDownloadTicket({
    secret: JWT_SECRET, uid: "dl-owner", channel: "fnos-fpk", arch: "x64",
    platform: "linux", version: over.version ?? "0.2.3", filename: over.filename ?? FILENAME,
    ttlMs: over.ttlMs ?? 120_000, now: over.now,
  }).ticket;
}

function auditRows(): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditFile)) return [];
  return fs
    .readFileSync(auditFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.byteLength;
  }
}

describe("download-ticket 换票", () => {
  it("未登录 -> 401；非 owner -> 403", async () => {
    expect((await app.request("/api/v1/admin/update/download-ticket", { method: "POST" })).status).toBe(401);
    const r = await app.request("/api/v1/admin/update/download-ticket", {
      method: "POST", headers: userH(), body: "{}",
    });
    expect(r.status).toBe(403);
  });

  it("owner 现场重算闸门：本机 darwin 无 linux fpk 资产 -> 409 UPDATE_NOT_AVAILABLE", async () => {
    const res = await app.request("/api/v1/admin/update/download-ticket", {
      method: "POST", headers: owner(), body: JSON.stringify({ arch: "x64", platform: "linux" }),
    });
    // body 的 arch/platform 对本地通道无效（身份来自部署探测=darwin）；即便显式传 linux，
    // 现场重算仍按部署身份，匹配不到资产 -> 409。这防住了"拿别的身份换票下载"。
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("UPDATE_NOT_AVAILABLE");
  });

  it("非法 arch/platform -> 400", async () => {
    const res = await app.request("/api/v1/admin/update/download-ticket", {
      method: "POST", headers: owner(), body: JSON.stringify({ arch: "mips" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_REQUEST");
  });
});

describe("download 仅验票", () => {
  it("无票 / 伪造票 / 过期票 -> 401 UPDATE_TICKET_INVALID", async () => {
    const noTicket = await app.request("/api/v1/admin/update/download");
    expect(noTicket.status).toBe(401);
    expect((await noTicket.json()).code).toBe("UPDATE_TICKET_INVALID");

    const forged = await app.request("/api/v1/admin/update/download?ticket=aaa.bbb");
    expect(forged.status).toBe(401);

    const expired = issueDownloadTicket({
      secret: JWT_SECRET, uid: "dl-owner", channel: "fnos-fpk", arch: "x64",
      platform: "linux", version: "0.2.3", filename: FILENAME, ttlMs: 1,
      now: Date.now() - 5000,
    }).ticket;
    const r = await app.request(`/api/v1/admin/update/download?ticket=${encodeURIComponent(expired)}`);
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("UPDATE_TICKET_INVALID");
  });

  it("不接受 Authorization 替代票（即使带有效 JWT 也 401）", async () => {
    const r = await app.request("/api/v1/admin/update/download", { headers: owner() });
    expect(r.status).toBe(401);
  });
});

describe("download 完整流式", () => {
  it("200 全量字节透传 + 安全/下载响应头，上游带 token 但响应不含内网地址", async () => {
    streamMode = "full";
    rangeSeen = null;
    authSeen = null;
    const ticket = directTicket();
    const res = await app.request(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${FILENAME}"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(rangeSeen).toBeNull(); // 无 Range 不透传
    expect(authSeen).toBe("token reader-token"); // 上游鉴权在服务端注入
    const n = await readAll(res.body!);
    expect(n).toBe(TOTAL);
    // 响应头/任何可见处不含上游 host 或 token。
    expect(res.headers.get("content-location")).toBeNull();
    for (const [k] of res.headers) expect(k).not.toMatch(/authorization|set-cookie/);
  }, 60000);

  it("大文件流式转发不整包进内存（heapUsed 增量有界）", async () => {
    streamMode = "full";
    const gc = (globalThis as { gc?: () => void }).gc;
    expect(gc, "需 --expose-gc（vitest forks execArgv 已配）").toBeTypeOf("function");
    const ticket = directTicket();
    gc!(); gc!();
    const before = process.memoryUsage().heapUsed;
    const res = await app.request(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`);
    await readAll(res.body!);
    gc!(); gc!();
    const after = process.memoryUsage().heapUsed;
    // 转发 63MiB 若误走 arrayBuffer，heap 增量会接近/超过 63MiB；流式应远小于该量。
    expect(after - before).toBeLessThan(40 * 1024 * 1024);
  }, 60000);

  it("Range 透传：206 + Content-Range/Content-Length 往返正确", async () => {
    streamMode = "full";
    const ticket = directTicket();
    const res = await app.request(
      `/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`,
      { headers: { Range: "bytes=1000-2023" } },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 1000-2023/${TOTAL}`);
    expect(res.headers.get("Content-Length")).toBe("1024");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(rangeSeen).toBe("bytes=1000-2023");
    expect(await readAll(res.body!)).toBe(1024);
  });

  it("上游 401 -> 502 UPDATE_SOURCE_AUTH，错误体不透传/不含内网地址", async () => {
    streamMode = "upstream401";
    const ticket = directTicket();
    const res = await app.request(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("UPDATE_SOURCE_AUTH");
    expect(JSON.stringify(body)).not.toMatch(/192\.168|releases\/download|reader-token/i);
    streamMode = "full";
  });
});

describe("download 中断/空闲审计", () => {
  it("客户端提前中断 -> update_downloaded 499（best-effort）", async () => {
    streamMode = "full";
    const ticket = directTicket();
    const controller = new AbortController();
    const resPromise = app.request(
      `/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`,
      { signal: controller.signal },
    );
    const res = await resPromise;
    const reader = res.body!.getReader();
    await reader.read(); // 读到首块
    await reader.cancel(); // 客户端断开
    controller.abort();

    // 等服务端 pump 收敛并落审计。
    const ok = await waitForAudit((rows) =>
      rows.some((r) => r.event === "update_downloaded" && r.status === 499));
    expect(ok, "应出现 499 下载中断审计").toBe(true);
  }, 30000);

  it("上游首块后停滞 -> 空闲超时中止，记 502", async () => {
    streamMode = "stall";
    const ticket = directTicket();
    const res = await app.request(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`);
    // 响应已开始（200 + 头），随后流因空闲超时被中止；读到流错误或提前结束。
    const reader = res.body!.getReader();
    await reader.read().catch(() => {});
    await reader.closed.catch(() => {});

    const ok = await waitForAudit((rows) =>
      rows.some((r) =>
        r.event === "update_downloaded" && r.status === 502
        && (r.detail as Record<string, unknown>)?.errorCode === "UPDATE_SOURCE_UNREACHABLE"));
    expect(ok, "应出现 502 空闲超时审计").toBe(true);
    streamMode = "full";
  }, 30000);

  it("成功下载记 200；detail 白名单且全量无 url/token/authorization/http", async () => {
    const rows = auditRows().filter((r) => r.event === "update_downloaded");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const d = r.detail as Record<string, unknown>;
      const allowed = new Set(["channel", "version", "arch", "platform", "filename", "bytes", "errorCode", "source"]);
      for (const k of Object.keys(d)) expect(allowed.has(k), `非法审计字段 ${k}`).toBe(true);
      const flat = JSON.stringify(d).toLowerCase();
      expect(flat).not.toContain("url");
      expect(flat).not.toContain("token");
      expect(flat).not.toContain("authorization");
      expect(flat).not.toContain("http");
    }
    const done = rows.find((r) => r.status === 200);
    expect(done, "应有 200 完成行").toBeTruthy();
    expect((done!.detail as Record<string, unknown>).bytes).toBe(TOTAL);
  });
});

// ===========================================================================
// 方案 A 后台预缓存 + 本地命中秒取（独立模块图：注入 linux/x64 身份 + 小文件真实 sha）
// ===========================================================================
describe("方案A：POST /prefetch 后台预取 → download 本地命中", () => {
  const PF_FILENAME = "gouxiangdb-0.2.3-x86.fpk";
  const PF_BODY = Buffer.alloc(5000, 0x61);
  const PF_SHA = createHash("sha256").update(PF_BODY).digest("hex");
  let pfRuntime: typeof import("../updateRuntime.js");
  let pfDataDir: string;
  let pfCalls = 0;
  const pfUrls: string[] = [];

  function pfManifest(): unknown {
    return {
      schemaVersion: 1, product: "gouxiangdb", generatedAt: "2026-10-20T08:00:00.000Z",
      channels: {
        "fnos-fpk": { releases: [{
          version: "0.2.3", publishedAt: "2026-10-20T08:00:00.000Z", prerelease: false,
          minVersion: null, releaseNotes: { format: "text", zh: "x", en: null },
          artifacts: [{
            arch: "x64", platform: "linux", filename: PF_FILENAME,
            sizeBytes: PF_BODY.length, sha256: PF_SHA,
            download: { kind: "release-asset", asset: PF_FILENAME }, signature: null,
          }],
        }] },
      },
    };
  }

  async function pfFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    pfCalls += 1;
    const url = String(input);
    pfUrls.push(url);
    if (url.includes("/releases?")) {
      return new Response(JSON.stringify([{ tag_name: "v0.2.3", assets: [{ name: "update-manifest.json" }] }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/update-manifest.json")) {
      return new Response(JSON.stringify(pfManifest()), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/releases/download/")) {
      // prefetcher 首次不带 Range（无 .part）→ 200 全量；校验 Authorization 带 token。
      const h = new Headers(init?.headers as HeadersInit | undefined);
      expect(h.get("Authorization")).toBe("token reader-token");
      return new Response(new Uint8Array(PF_BODY), {
        status: 200, headers: { "Content-Length": String(PF_BODY.length), "Accept-Ranges": "bytes" },
      });
    }
    throw new Error(`unexpected pf fetch: ${url}`);
  }

  beforeAll(async () => {
    pfDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-pf-cache-"));
    vi.resetModules();
    // dataDir 独立隔离 update-cache（成品落这里）；审计仍写主 .audit（auditRows 可读）。
    // 库仍用主 beforeAll 已迁移 + dl-owner 的同一个临时库。
    setEnv({
      GX_UPDATE_CHANNEL: "fnos-fpk",
      GX_UPDATE_TOKEN: "reader-token",
      GX_DATA_DIR: pfDataDir,
    });
    // setEnv 默认把库指到不存在的 u.db；独立模块图必须连回主 beforeAll 迁移+建 owner 的 d.db。
    process.env.DATABASE_URL = `file:${path.join(tmpDir, "d.db")}`;
    pfRuntime = await import("../updateRuntime.js");
    // darwin 机注入 linux/x64 身份，走「linux fpk 升级」全链路；fetch 用本 describe 的可控桩。
    pfRuntime.__setUpdateRuntimeForTest({ nodeArch: "x64", nodePlatform: "linux", fetch: pfFetch });
  }, 120000);

  // 同一模块图（未再 resetModules）：req 每次新建 app，但 updateRuntime 单例已被测试缝替换。
  async function req(url: string, init?: RequestInit): Promise<Response> {
    const mod = await import("../../../app.js");
    const a = mod.createApp().app as unknown as App;
    return a.request(url, init);
  }

  afterAll(() => {
    fs.rmSync(pfDataDir, { recursive: true, force: true });
  });

  it("非 owner 触发预缓存 -> 403", async () => {
    const res = await req("/api/v1/admin/update/prefetch", {
      method: "POST", headers: userH(), body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("owner 触发 -> 202 started，轮询 status 到 ready（真实拉取+sha校验落地）", async () => {
    const res = await req("/api/v1/admin/update/prefetch", {
      method: "POST", headers: owner(), body: "{}",
    });
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.decision).toBe("started");
    expect(j.prefetch.state).toBe("running");

    // 轮询 status（非 force）直到 ready。
    let snap: UpdatePrefetchDTO | null = null;
    for (let i = 0; i < 200; i += 1) {
      const s = await req("/api/v1/admin/update/status", { headers: owner() });
      const b = await s.json() as { prefetch: UpdatePrefetchDTO };
      snap = b.prefetch;
      if (snap?.state === "ready") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(snap?.state).toBe("ready");
    expect(snap?.sha256).toBe(PF_SHA);
    expect(snap?.receivedBytes).toBe(PF_BODY.length);
    // 成品落在独立缓存目录。
    expect(fs.existsSync(path.join(pfDataDir, "update-cache", `${PF_SHA}.fpk`))).toBe(true);
  }, 30000);

  it("重复触发已就绪 -> 200 ready 幂等，不重复出网", async () => {
    const before = pfCalls;
    const res = await req("/api/v1/admin/update/prefetch", {
      method: "POST", headers: owner(), body: "{}",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).decision).toBe("ready");
    expect(pfCalls).toBe(before);
  });

  it("download 本地命中：凭票 200 秒取，字节一致，审计 source=cache", async () => {
    const ticket = directTicket();
    const res = await req(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(PF_FILENAME);
    expect(res.headers.get("Content-Length")).toBe(String(PF_BODY.length));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PF_BODY)).toBe(true);
    // 本地命中不应再打资产 URL（本用例全程无新 releases/download）。
    expect(pfUrls.some((u) => u.includes("/releases/download/"))).toBe(true); // ready 阶段拉过一次

    const rows = auditRows().filter((r) => r.event === "update_downloaded" && r.status === 200);
    const cacheRow = rows.find((r) => (r.detail as Record<string, unknown>).source === "cache");
    expect(cacheRow, "应有 source=cache 的 200 审计").toBeTruthy();
    expect((cacheRow!.detail as Record<string, unknown>).bytes).toBe(PF_BODY.length);
    const flat = JSON.stringify(cacheRow!.detail).toLowerCase();
    expect(flat).not.toContain("token");
    expect(flat).not.toContain("http");
  });

  it("download 本地命中支持 Range：bytes=10-19 -> 206/10 字节", async () => {
    const ticket = directTicket();
    const res = await req(`/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 10-19/${PF_BODY.length}`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(10);
    expect(buf.equals(PF_BODY.subarray(10, 20))).toBe(true);
  });

  it("审计：prefetch started/completed detail 白名单且无 url/token/http", async () => {
    const started = auditRows().filter((r) => r.event === "update_prefetch_started");
    const completed = auditRows().filter((r) => r.event === "update_prefetch_completed");
    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);
    const allowed = new Set(["channel", "arch", "platform", "version", "filename", "sha256", "state", "totalBytes", "bytes", "errorCode"]);
    for (const r of [...started, ...completed]) {
      const d = r.detail as Record<string, unknown>;
      for (const k of Object.keys(d)) expect(allowed.has(k), `非法审计字段 ${k}`).toBe(true);
      const flat = JSON.stringify(d).toLowerCase();
      expect(flat).not.toContain("token");
      expect(flat).not.toContain("http");
    }
    expect((completed[0].detail as Record<string, unknown>).state).toBe("ready");
  });
});

describe("方案A：GX_UPDATE_PREFETCH_ENABLED=off -> 路由 404", () => {
  it("POST /prefetch 返回 404（owner 已通过，门控在 handler）", async () => {
    vi.resetModules();
    setEnv({
      GX_UPDATE_CHANNEL: "fnos-fpk",
      GX_UPDATE_TOKEN: "reader-token",
      GX_UPDATE_PREFETCH_ENABLED: "off",
    });
    // 连回主库，使 owner JWT 有效（先过鉴权，再由 handler 的 prefetch 门返回 404）。
    process.env.DATABASE_URL = `file:${path.join(tmpDir, "d.db")}`;
    const mod = await import("../../../app.js");
    const offApp = mod.createApp().app as unknown as App;
    const res = await offApp.request("/api/v1/admin/update/prefetch", {
      method: "POST", headers: owner(), body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

async function waitForAudit(pred: (rows: Array<Record<string, unknown>>) => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred(auditRows())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred(auditRows());
}

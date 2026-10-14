// 品牌外观端到端夹具（branding.test.ts 专用）：真迁移临时库 + 真 createApp 双模块图
// （企业双 flag 默认 on / 显式 off 各一图，共享同一临时库）+ 六身份播种 + multipart 造件。
//
// 拆出原因：主测试文件超 350 行纪律。夹具职责仅限建库/播种/取句柄，不含任何断言。

import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { BRANDING_KEYS } from "../../domain/branding/defaults.js";

export const JWT_SECRET = "branding-test-secret-at-least-16";
const TOKEN_TTL = 7 * 24 * 60 * 60;

type App = { request: (url: string, init?: RequestInit) => Promise<Response> };

// 最小合法 PNG（1x1）与最小 JPEG 字节；路由只按声明 MIME + 大小校验，不验魔数。
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

export interface BrandingHarness {
  tmpDir: string;
  heroDir: string;
  auditFile: string;
  prisma: PrismaClient;
  app: App;
  offApp: App;
  tokens: Map<string, string>;
  tokenFor: (userId: string) => Promise<string>;
  auth: (userId: string) => Promise<Record<string, string>>;
  pngFile: () => File;
  cleanup: () => Promise<void>;
  resetBranding: () => Promise<void>;
}

function blobPart(b: Buffer): Uint8Array<ArrayBuffer> {
  // Node Buffer 的 ArrayBufferLike 与 DOM BlobPart 的 ArrayBuffer 标称不兼容，复制一份全新
  // ArrayBuffer 支撑的 Uint8Array。
  const copy = new Uint8Array(new ArrayBuffer(b.length));
  copy.set(b);
  return copy;
}

function textPart(s: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(s);
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

export function zeroPart(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size));
}

/** 造图片 File（默认最小 PNG；可覆盖字节/MIME/文件名）。 */
export function imageFile(
  bytes: Buffer,
  filename: string,
  type: string,
): File {
  return new File([blobPart(bytes)], filename, { type });
}

export function gifFile(): File {
  return new File([textPart("GIF89a")], "x.gif", { type: "image/gif" });
}

export async function setupBrandingHarness(): Promise<BrandingHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-branding-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "brand.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  // 零迁移改动证据：全量 deploy 必须成功（迁移数维持 41）。
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const heroDir = path.join(tmpDir, "uploads", "branding");
  const auditFile = path.join(tmpDir, ".audit", "audit.logl");

  const tokens = new Map<string, string>();
  const tokenFor = async (userId: string): Promise<string> => {
    const cached = tokens.get(userId);
    if (cached) return cached;
    const now = Math.floor(Date.now() / 1000);
    const t = await sign(
      { userId, tv: 0, iat: now, exp: now + TOKEN_TTL },
      JWT_SECRET,
      "HS256",
    );
    tokens.set(userId, t);
    return t;
  };
  const auth = async (userId: string) => ({ Authorization: `Bearer ${await tokenFor(userId)}` });

  // ---- 六身份播种：每身份独立用户 + 直授角色 ----
  const seedUser = async (id: string): Promise<void> => {
    await prisma.user.create({
      data: {
        id, email: `${id}@x.com`, displayName: id,
        passwordHash: await bcrypt.hash("password123", 10),
        status: "ACTIVE", workspaceId: "ws_default",
      },
    });
  };
  const grant = async (userId: string, roleId: string): Promise<void> => {
    await prisma.roleAssignment.create({
      data: { roleId, subjectType: "user", subjectId: userId, scopeType: "workspace", createdBy: "test" },
    });
  };
  const seedRole = async (id: string, systemKey: string | null, permissions: string): Promise<void> => {
    await prisma.role.create({
      data: { id, workspaceId: "ws_default", systemKey, name: id, description: "", isSystem: 0, permissions },
    });
  };

  const users = ["owner", "admin", "legacy", "viewer", "restricted", "custom"];
  for (const u of users) {
    await seedUser(u);
    await tokenFor(u); // 预签 JWT，同步测试助手可直接从 tokens 表取
  }
  await grant("owner", "role_owner");       // systemKey=super_admin
  await grant("admin", "role_admin");       // systemKey=admin
  await grant("viewer", "role_viewer");
  await grant("restricted", "role_restricted");
  // 旧库残留：自建 roles 行 systemKey="owner"（迁移后 role_owner 已是 super_admin）。
  await seedRole("role_legacy_owner", "owner", "[]");
  await grant("legacy", "role_legacy_owner");
  // 自定义角色 systemKey=null 但持 manage_share：品牌口必须拒绝（只认系统角色三值）。
  await seedRole("role_custom_ms", null, '["manage_share"]');
  await grant("custom", "role_custom_ms");

  const mod = await import("../../app.js");
  const app = mod.createApp().app as unknown as App;
  const invalidators: Array<() => void> = [];
  invalidators.push((await import("../../domain/branding/store.js")).invalidateBrandingCache);

  // 双 flag off 独立模块图（共享同一临时库）：证明品牌端点无条件挂载、不进 /api/v1。
  vi.resetModules();
  process.env.GX_ENTERPRISE_ORG = "off";
  process.env.GX_ENTERPRISE_NAV = "off";
  const offMod = await import("../../app.js");
  const offApp = offMod.createApp().app as unknown as App;
  invalidators.push((await import("../../domain/branding/store.js")).invalidateBrandingCache);
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;

  const resetBranding = async (): Promise<void> => {
    await prisma.appSetting.deleteMany({ where: { k: { in: Object.values(BRANDING_KEYS) } } });
    // 两个模块图的进程缓存都失效（KV 已删，下一次 GET 必须回库读到默认态）。
    for (const invalidate of invalidators) invalidate();
    fs.rmSync(heroDir, { recursive: true, force: true });
  };

  const cleanup = async (): Promise<void> => {
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return {
    tmpDir, heroDir, auditFile, prisma, app, offApp, tokens,
    tokenFor, auth, pngFile: () => imageFile(PNG, "login-hero.png", "image/png"),
    cleanup, resetBranding,
  };
}

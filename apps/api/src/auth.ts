// apps/api/src/auth.ts
// JWT 鉴权 + 路由级 RBAC（owner/creator/editor/commenter/viewer 5 角色）

import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 上传根目录：apps/api/uploads（头像存 uploads/avatars/<userId>.<ext>）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, "../uploads");
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const AVATAR_ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// 生产环境必须显式提供足够强度的 JWT_SECRET；开发环境回落到本地固定密钥（仅 dev）。
const IS_PROD = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET ?? (IS_PROD ? "" : "dev-secret-change-me-in-production");
if (IS_PROD && (!JWT_SECRET || JWT_SECRET.length < 16)) {
  // fail-closed：生产缺密钥直接拒绝启动，避免用公开默认密钥签发可伪造 token。
  throw new Error("FATAL: 生产环境必须设置环境变量 JWT_SECRET（至少 16 位随机字符串）");
}

// token 有效期 7 天（秒）
const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

export type Role = "owner" | "creator" | "editor" | "commenter" | "viewer";

function issueToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ userId, iat: now, exp: now + TOKEN_TTL_SEC }, JWT_SECRET, "HS256");
}

export const auth = new Hono();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
});

auth.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }
  const { email, password, displayName } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, displayName, passwordHash },
  });
  const token = await issueToken(user.id);
  return c.json({ token, user: publicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input" }, 400);
  }
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  const token = await issueToken(user.id);
  return c.json({ token, user: publicUser(user) });
});

auth.get("/me", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return c.json({ error: "No token" }, 401);
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    const user = await prisma.user.findUnique({ where: { id: payload.userId as string } });
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user: publicUser(user) });
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
});

/**
 * 公共用户字段投影：剥离 passwordHash，前端能直接使用。
 * 所有返回 /me /signup /login 字段均走此函数，避免个别字段遗漏导致前端解析异常。
 */
function publicUser(u: {
  id: string; email: string; displayName: string; passwordHash: string;
  username: string | null; phone: string | null; avatarUrl: string | null;
  bio: string | null; createdAt: Date; updatedAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    username: u.username,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt?.toISOString() ?? null,
  };
}

// PATCH /me：更新昵称 / 用户名 / 手机 / 简介
const updateMeSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名仅支持字母/数字/下下划线/连字符")
    .nullable()
    .optional(),
  phone: z.string().max(30).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
});

auth.patch("/me", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const parsed = updateMeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }
  // username 唯一性校验（如果用户要改成某个 username，要先排除自己）
  if (parsed.data.username) {
    const dup = await prisma.user.findFirst({
      where: { username: parsed.data.username, NOT: { id: userId } },
    });
    if (dup) return c.json({ error: "用户名已被占用" }, 409);
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: parsed.data,
  });
  return c.json({ user: publicUser(updated) });
});

// POST /me/change-password：原密码 + 新密码 + 确认
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "新密码至少 8 位").max(72, "新密码不超过 72 位"),
});

auth.post("/me/change-password", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return c.json({ error: "User not found" }, 404);
  const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!ok) return c.json({ error: "当前密码错误" }, 401);
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  return c.json({ ok: true });
});

// DELETE /me：注销账号（需要 confirm=true 二次确认 + 原密码校验）
const deleteAccountSchema = z.object({
  confirm: z.literal(true),
  password: z.string().min(1),
});

auth.delete("/me", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const parsed = deleteAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "需要 confirm=true + 当前密码才能注销" }, 400);
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return c.json({ error: "User not found" }, 404);
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return c.json({ error: "密码错误" }, 401);
  // 检查是否还是某 base 的唯一 owner：是 → 拒绝注销（避免数据归属孤悬）
  const ownerOf = await prisma.member.findMany({
    where: { userId, role: "owner" },
    select: { baseId: true },
  });
  for (const m of ownerOf) {
    const ownerCount = await prisma.member.count({
      where: { baseId: m.baseId, role: "owner" },
    });
    if (ownerCount <= 1) {
      return c.json(
        { error: `你仍是某个 Base 的唯一 owner，请先转让 owner 或删除该 Base` },
        409,
      );
    }
  }
  // 删除 user：cascade 会带走 memberships / kbMemberships / docAcls / comments（已配置）
  await prisma.user.delete({ where: { id: userId } });
  return c.json({ ok: true });
});

// POST /me/avatar：上传头像（multipart form-data，字段名 "file"）
auth.post("/me/avatar", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.parseBody().catch(() => null);
  const file = (body as { file?: unknown } | null)?.file;
  if (!(file instanceof File)) {
    return c.json({ error: "需要 file 字段（multipart form-data）" }, 400);
  }
  const ext = AVATAR_ALLOWED[file.type];
  if (!ext) {
    return c.json({ error: "仅支持 JPG / PNG / WebP / GIF 格式" }, 400);
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return c.json({ error: "头像不能超过 5MB" }, 400);
  }
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    // 覆盖同名旧文件（同一 userId 只会有一个头像）
    fs.writeFileSync(path.join(AVATAR_DIR, `${userId}.${ext}`), buf);
    const avatarUrl = `/uploads/avatars/${userId}.${ext}?v=${Date.now()}`;
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return c.json({ user: publicUser(updated) });
  } catch {
    return c.json({ error: "头像保存失败" }, 500);
  }
});

// DELETE /me/avatar：移除头像（恢复默认首字母头像）
auth.delete("/me/avatar", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  // 删除磁盘上所有该 userId 的头像（jpg/png/webp/gif）
  for (const ext of Object.values(AVATAR_ALLOWED)) {
    try {
      fs.rmSync(path.join(AVATAR_DIR, `${userId}.${ext}`), { force: true });
    } catch {
      /* 文件不存在则忽略 */
    }
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: null },
  });
  return c.json({ user: publicUser(updated) });
});

export type AuthPayload = {
  userId: string;
  iat: number;
};

// 鉴权工具：从 Authorization 头解析 userId
export async function getUserId(c: { req: { header: (k: string) => string | undefined } }): Promise<string | null> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    return payload.userId as string;
  } catch {
    return null;
  }
}

// 帮助函数：检查 user 对 base 的角色
export async function userRoleInBase(
  userId: string,
  baseId: string,
): Promise<Role | undefined> {
  const member = await prisma.member.findUnique({
    where: { baseId_userId: { baseId, userId } },
  });
  return member?.role as Role | undefined;
}

// 权限位（v1 同构）
export const Permission = {
  canManageBase(role: Role | undefined): boolean {
    return role === "owner";
  },
  canManageSchema(role: Role | undefined): boolean {
    return role === "owner" || role === "creator";
  },
  canEditData(role: Role | undefined): boolean {
    return role === "owner" || role === "creator" || role === "editor";
  },
  canComment(role: Role | undefined): boolean {
    return role !== "viewer" && role !== undefined;
  },
};

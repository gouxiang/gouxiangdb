// apps/api/src/auth.ts
// JWT 鉴权 + 路由级 RBAC（owner/creator/editor/commenter/viewer 5 角色）

import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "./db.js";
import { audit as recordAudit } from "./audit/emit.js";
import { issueToken, resolveActiveAuth, USER_STATUS } from "./domain/org/authState.js";
import { publicUser } from "./domain/userProjection.js";

// token 有效期常量与 JWT/状态解析核心已下沉到 domain/org/authState.ts（旧 /api 与 v1 共享）。
export type Role = "owner" | "creator" | "editor" | "commenter" | "viewer";

// 对外保持从 auth.ts 可导入（v1 中间件/后续 S6 复用），实现单一真源在 domain/org/authState.ts。
export { USER_STATUS, issueToken, resolveActiveAuth };
export type { UserStatus, ResolvedAuth } from "./domain/org/authState.js";

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
  // 注册直接 ACTIVE（status 默认），tokenVersion=0。
  const token = await issueToken(user.id, user.tokenVersion);
  recordAudit(c, { event: "signup", status: 200, actorId: user.id });
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
    recordAudit(c, { event: "login_failure", status: 401, detail: { reason: "unknown_email" } });
    return c.json({ error: "Invalid credentials" }, 401);
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    recordAudit(c, { event: "login_failure", status: 401, actorId: user.id, detail: { reason: "bad_password" } });
    return c.json({ error: "Invalid credentials" }, 401);
  }
  // M2 账号生命周期：INVITED 尚未激活 -> 403（与密码错误 401 区分）；DISABLED -> 401。
  if (user.status === USER_STATUS.INVITED) {
    recordAudit(c, { event: "login_failure", status: 403, actorId: user.id, detail: { reason: "invited" } });
    return c.json({ error: "账号尚未激活" }, 403);
  }
  if (user.status === USER_STATUS.DISABLED) {
    recordAudit(c, { event: "login_failure", status: 401, actorId: user.id, detail: { reason: "disabled" } });
    return c.json({ error: "账号已停用" }, 401);
  }
  const token = await issueToken(user.id, user.tokenVersion);
  recordAudit(c, { event: "login_success", status: 200, actorId: user.id });
  return c.json({ token, user: publicUser(user) });
});

auth.get("/me", async (c) => {
  // 复用共享解析核心：验签 + status/tv 校验。DISABLED/tv 不符/用户不存在/坏 token 一律 401
  // （旧"用户不存在 404"在账号物理删除后不再可达为合法身份，统一按未认证处理，更安全）。
  const resolved = await resolveActiveAuth(c);
  if (!resolved) return c.json({ error: "Invalid token" }, 401);
  const user = await prisma.user.findUnique({ where: { id: resolved.userId } });
  if (!user) return c.json({ error: "Invalid token" }, 401);
  return c.json({ user: publicUser(user) });
});

// 公共用户字段投影 publicUser 已抽到 domain/userProjection.ts（与 meAvatar 路由共用）。

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
  recordAudit(c, { event: "change_password", status: 200, actorId: userId });
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
  recordAudit(c, { event: "account_delete", status: 200, actorId: userId });
  return c.json({ ok: true });
});

export type AuthPayload = {
  userId: string;
  iat: number;
};

// 鉴权工具：从 Authorization 头解析 userId。
// 签名保持 (c) => Promise<string|null> 不变（records-keyset.test.ts 的 vi.mock 依赖此形态）；
// 内部改为走 resolveActiveAuth：ACTIVE 且 tv 匹配时与旧版"仅验签"结果等价（存量无 tv token
// 视 tv=0、users.tokenVersion 默认 0 平滑通过）；DISABLED/tv 不符/用户不存在则 null。
export async function getUserId(c: { req: { header: (k: string) => string | undefined } }): Promise<string | null> {
  const resolved = await resolveActiveAuth(c);
  return resolved?.userId ?? null;
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

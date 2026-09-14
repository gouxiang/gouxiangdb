// 头像上传/删除路由（从 auth.ts 抽出以保持单文件职责与行数纪律）。
// 挂在 /api/auth/me/avatar（app.ts 把本路由挂到 auth 同前缀子实例）。
// 鉴权仍走 getUserId（M2 后内部为 resolveActiveAuth，ACTIVE/tv 校验）。

import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { audit as recordAudit } from "../audit/emit.js";
import { getUserId } from "../auth.js";
import { publicUser } from "../domain/userProjection.js";

export const meAvatar = new Hono();

const AVATAR_DIR = path.join(config.uploadRoot, "avatars");
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const AVATAR_ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// POST /me/avatar：上传头像（multipart form-data，字段名 "file"）
meAvatar.post("/", async (c) => {
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
    const updated = await prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return c.json({ user: publicUser(updated) });
  } catch {
    return c.json({ error: "头像保存失败" }, 500);
  }
});

// DELETE /me/avatar：移除头像（恢复默认首字母头像）
meAvatar.delete("/", async (c) => {
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
  const updated = await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
  recordAudit(c, { event: "avatar_delete", status: 200, actorId: userId });
  return c.json({ user: publicUser(updated) });
});

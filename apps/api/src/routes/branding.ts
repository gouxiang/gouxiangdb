// 品牌外观路由（0.2.4-rc）：产品名 / 版权串 / 登录广告图后台可自定义。
//
// 两个独立 Hono 实例（均无条件挂在主 api 实例，绝不进 /api/v1 企业门）：
//   publicBranding —— GET /api/auth/branding，匿名公开，任何异常 fail-closed 返回默认 DTO；
//   adminBranding  —— /api/admin/branding，仅超级管理员(super_admin)/管理员(admin)/旧库残留
//                     systemKey="owner" 可写。不认 actions.manage_*，不认任何资源角色。
// 写操作一律走 withWriteTx（进程串行写铁律），事务提交后失效品牌缓存并写审计。

import { Hono, type Context } from "hono";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BRANDING_LIMITS, type BrandingConfigDTO } from "@gx/shared-types";
import { withWriteTx, type DbTx } from "../db.js";
import { config } from "../config.js";
import { HttpError } from "../guards.js";
import { audit as recordAudit } from "../audit/emit.js";
import { resolveActiveAuth } from "../domain/org/authState.js";
import { effectiveRoleRows } from "../domain/org/authorization.js";
import {
  BRANDING_KEYS,
  defaultBranding,
  getBranding,
  invalidateBrandingCache,
  normalizeProductName,
  upsertBrandingKeyTx,
} from "../domain/branding/store.js";

// ---- 公开只读实例 ----------------------------------------------------------

export const publicBranding = new Hono();

// GET /：登录页/顶栏匿名读取。品牌读取失败绝不让登录页 500——fail-closed 返回默认 DTO。
publicBranding.get("/", async (c) => {
  let dto: BrandingConfigDTO;
  try {
    dto = await getBranding();
  } catch (e) {
    console.error("[branding] 读取品牌配置失败，回退默认值:", (e as Error).message);
    dto = defaultBranding();
  }
  return c.json(dto);
});

// ---- 管理员读写实例 --------------------------------------------------------

export const adminBranding = new Hono();

/** 可修改品牌外观的系统角色：超管/管理员，外加旧库可能残留的 "owner"。 */
const BRANDING_ADMIN_KEYS = new Set(["super_admin", "admin", "owner"]);

const HERO_DIR = path.join(config.uploadRoot, "branding");
const HERO_MAX_BYTES = 5 * 1024 * 1024; // 5MB
// 广告图固定三选一文件名（切换格式时靠它精确删除旧文件，绝不触碰目录内其它文件）。
const HERO_FILES = ["hero.jpg", "hero.png", "hero.webp"] as const;
const HERO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const patchSchema = z
  .object({
    productName: z
      .string()
      .trim()
      .min(1, "产品名不能为空")
      .max(BRANDING_LIMITS.productNameMax, `产品名不能超过 ${BRANDING_LIMITS.productNameMax} 字符`)
      .optional(),
    copyright: z
      .string()
      .max(BRANDING_LIMITS.copyrightMax, `版权信息不能超过 ${BRANDING_LIMITS.copyrightMax} 字符`)
      .optional(),
  })
  .strict();

/** 解析登录身份；无身份（无令牌/坏令牌/停用/tv 不符）-> 401。 */
async function requireBrandingAuth(c: Context): Promise<string> {
  const resolved = await resolveActiveAuth(c);
  if (!resolved) {
    throw new HttpError(401, "Unauthorized", "UNAUTHORIZED");
  }
  return resolved.userId;
}

/** 仅认系统角色三值；manage_* 动作位与资源角色一律不放行（戴总裁决：超管和管理员可改）。 */
async function assertBrandingAdmin(userId: string): Promise<void> {
  const roles = await effectiveRoleRows(userId);
  const ok = roles.some((r) => r.systemKey !== null && BRANDING_ADMIN_KEYS.has(r.systemKey));
  if (!ok) {
    throw new HttpError(403, "仅超级管理员/管理员可修改品牌外观", "FORBIDDEN");
  }
}

/** 删除三种固定名中除 keep 外的旧广告图（仅这三个名字，force 忽略不存在）。 */
function removeOtherHeroFiles(keep: string): void {
  for (const name of HERO_FILES) {
    if (name !== keep) fs.rmSync(path.join(HERO_DIR, name), { force: true });
  }
}

/** 删除三种固定名的全部广告图（复位时使用）。 */
function removeHeroFiles(): void {
  for (const name of HERO_FILES) {
    fs.rmSync(path.join(HERO_DIR, name), { force: true });
  }
}

// GET /：管理员读完整配置（与匿名 DTO 同形状；品牌内容本身无敏感性）。
adminBranding.get("/", async (c) => {
  const userId = await requireBrandingAuth(c);
  await assertBrandingAdmin(userId);
  return c.json(await getBranding());
});

// PATCH /：更新产品名/版权串（仅 upsert 实际提供的键；空对象 400）。
adminBranding.patch("/", async (c) => {
  const userId = await requireBrandingAuth(c);
  await assertBrandingAdmin(userId);

  const raw = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "请求参数有误", "BAD_REQUEST");
  }
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) {
    throw new HttpError(400, "没有需要更新的字段", "BAD_REQUEST");
  }

  await withWriteTx("branding.patch", async (tx: DbTx) => {
    if (parsed.data.productName !== undefined) {
      // 已 trim + 非空 + 长度校验，normalizeProductName 在此恒返回 trim 值（再保险）。
      await upsertBrandingKeyTx(tx, BRANDING_KEYS.productName, normalizeProductName(parsed.data.productName));
    }
    if (parsed.data.copyright !== undefined) {
      await upsertBrandingKeyTx(tx, BRANDING_KEYS.copyright, parsed.data.copyright);
    }
  });
  invalidateBrandingCache();
  recordAudit(c, { event: "branding_update", status: 200, actorId: userId, detail: { fields } });
  return c.json(await getBranding());
});

// POST /hero：上传登录广告图（multipart 字段名 file；jpg/png/webp；≤5MB；固定文件名覆盖）。
adminBranding.post("/hero", async (c) => {
  const userId = await requireBrandingAuth(c);
  await assertBrandingAdmin(userId);

  const body = await c.req.parseBody().catch(() => null);
  const file = (body as { file?: unknown } | null)?.file;
  if (!(file instanceof File)) {
    throw new HttpError(400, "需要 file 字段（multipart form-data）", "BAD_REQUEST");
  }
  const ext = HERO_TYPES[file.type];
  if (!ext) {
    // 明确不收 gif（登录广告图要求静态位图）。
    throw new HttpError(400, "仅支持 JPG / PNG / WebP 格式", "BAD_REQUEST");
  }
  if (file.size > HERO_MAX_BYTES) {
    throw new HttpError(400, "广告图不能超过 5MB", "BAD_REQUEST");
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const filename = `hero.${ext}`;
  // 先落盘新文件，再删另两种扩展名旧文件：写盘失败时旧图与 KV 仍自洽（不出现指向缺失文件）。
  fs.mkdirSync(HERO_DIR, { recursive: true });
  fs.writeFileSync(path.join(HERO_DIR, filename), buf);
  removeOtherHeroFiles(filename);

  await withWriteTx("branding.hero.upsert", async (tx: DbTx) => {
    await upsertBrandingKeyTx(tx, BRANDING_KEYS.loginHero, filename);
  });
  invalidateBrandingCache();
  recordAudit(c, {
    event: "branding_hero_update",
    status: 200,
    actorId: userId,
    detail: { ext, bytes: buf.length },
  });
  return c.json(await getBranding());
});

// DELETE /hero：恢复前端内置默认图（删三个固定名文件 + KV 置空串）。
adminBranding.delete("/hero", async (c) => {
  const userId = await requireBrandingAuth(c);
  await assertBrandingAdmin(userId);

  removeHeroFiles();
  await withWriteTx("branding.hero.reset", async (tx: DbTx) => {
    await upsertBrandingKeyTx(tx, BRANDING_KEYS.loginHero, "");
  });
  invalidateBrandingCache();
  recordAudit(c, {
    event: "branding_hero_update",
    status: 200,
    actorId: userId,
    detail: { action: "reset" },
  });
  return c.json(await getBranding());
});

// apps/api/src/routes/viewAdmin.ts
// 视图「管理员配置层」端点（#560）：PATCH /api/views/:viewId/admin。
//
// 从 views.ts 拆出：同 /api/views 前缀叠加挂载（路径 /:viewId/admin 深度与 views.ts 的
// /:viewId 不同，Hono 支持多 router 叠加，与 layoutVersions 先例一致）。
//
// 授权：必须是表结构管理者（manage_schema）。普通成员不可改管理员强制隐藏/筛选/列序。
// 合并口径：以当前 admin（无则默认空配置）为基线，整体叠加传入字段，version 恒为 1，
// 不提供置 null（避免半配置态）。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../db.js";
import { HttpError } from "../guards.js";
import { requireSchemaDesign } from "../domain/authz/tableManageGuards.js";
import { parseViewAdminConfig } from "../domain/viewAdminConfig.js";
import { loadUserPrefs } from "../domain/viewUserPrefsStore.js";
import {
  defaultViewAdminConfig,
  type ViewAdminConfig,
} from "@gx/shared-types";
import { serializeView } from "./views.js";

export const viewAdmin = new Hono();

/**
 * 浅校验 FilterNode：kind 限定为 condition/and/or/not，组节点带合法子树。
 * #561：导出供 viewUserPrefs.ts 复用，同一 /api/views 子树不重复一份。
 */
export function isFilterNode(value: unknown): value is NonNullable<ViewAdminConfig["filters"]> {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  switch (node.kind) {
    case "condition":
      return typeof node.fieldId === "string" && typeof node.op === "string";
    case "and":
    case "or":
      return Array.isArray(node.children) && node.children.every(isFilterNode);
    case "not":
      return isFilterNode(node.child);
    default:
      return false;
  }
}

const adminFieldSchema = z.object({
  fieldOrder: z.array(z.string()).optional(),
  hiddenFieldIds: z.array(z.string()).optional(),
  filters: z.unknown().optional(), // 结构由 isFilterNode 校验
  coverFieldId: z.string().nullable().optional(),
  cardFieldIds: z.array(z.string()).optional(),
  detailFieldIds: z.array(z.string()).optional(),
});

const updateAdminSchema = z.object({ adminConfig: adminFieldSchema });

viewAdmin.patch("/:viewId/admin", async (c) => {
  const viewId = c.req.param("viewId");
  const viewRow0 = await prisma.view.findUnique({
    where: { id: viewId },
    select: { tableId: true },
  });
  if (!viewRow0) throw new HttpError(404, "视图不存在");
  const tableId = viewRow0.tableId;

  // 表结构管理者守卫；普通成员不可改管理员配置。
  const { userId } = await requireSchemaDesign(c, tableId);

  const parsed = updateAdminSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);
  }
  const patch = parsed.data.adminConfig;
  if (patch.filters !== undefined && patch.filters !== null && !isFilterNode(patch.filters)) {
    return c.json({ error: "filters 必须是合法的筛选条件" }, 400);
  }

  // 读当前 admin 为基线（无则默认空配置），叠加传入字段；version 恒为 1。
  const currentRow = await prisma.view.findUnique({
    where: { id: viewId },
    select: { adminConfig: true },
  });
  const current = parseViewAdminConfig(currentRow?.adminConfig ?? null);
  // filters 在 zod 下是 unknown：按已校验结论收敛成 FilterNode|null，其余字段直接叠加。
  const { filters, ...rest } = patch;
  const next: ViewAdminConfig = defaultViewAdminConfig({
    ...(current ?? {}),
    ...rest,
    ...(filters !== undefined
      ? { filters: filters === null ? null : isFilterNode(filters) ? filters : null }
      : {}),
    version: 1,
  });

  const updated = await withWriteTx("view.adminConfig.update", async (tx) =>
    tx.view.update({
      where: { id: viewId },
      data: { adminConfig: JSON.stringify(next) },
    }),
  );
  // #561：补当前管理员自己的个性化（管理员强制层变更不影响其个人使用态）。
  const userPrefs = await loadUserPrefs(prisma, viewId, userId);
  return c.json({ view: serializeView(updated, userPrefs) });
});

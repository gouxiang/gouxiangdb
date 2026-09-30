// apps/api/src/routes/viewUserPrefs.ts
// 视图「用户个性化」端点（#561）：PUT/PATCH /api/views/:viewId/prefs、DELETE 同路径。
//
// 同 /api/views 前缀叠加挂载（路径 /:viewId/prefs 与 views.ts 的 /:viewId、viewAdmin.ts 的
// /:viewId/admin 深度不同，Hono 支持多 router 叠加）。
//
// 授权：任意可见者（requireCanView）即可写【自己的】偏好；守卫只负责确认调用者身份，
// 行级隔离由 where 中的 userId 保证，用户之间互不可见互不可改。
//
// 存储口径（与 shared-types/viewUserPrefs.ts 一致）：
//   · prefs 为全量使用态快照。PUT/PATCH 均为合并语义：以当前 prefs 行为基线；
//     用户尚未自定义时，以视图默认配置的使用态为基线（首次保存即固化）。
//   · version 恒为 1。
//   · DELETE 删除该用户的 prefs 行，重新跟随视图默认；行不存在也返回 200。
//   · 个性化只覆盖使用态，字段范围/顺序/封面/卡片/详情由视图默认与管理员层决定。

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  defaultViewUserPrefs,
  type ViewUserPrefs,
} from "@gx/shared-types";
import { prisma, withWriteTx } from "../db.js";
import { requireCanView, HttpError } from "../guards.js";
import { parseViewConfig } from "../domain/recordService.js";
import { loadUserPrefs } from "../domain/viewUserPrefsStore.js";
import { isFilterNode } from "./viewAdmin.js";

export const viewUserPrefs = new Hono();

const sortSpecSchema = z.object({
  fieldId: z.string(),
  direction: z.enum(["asc", "desc"]),
});

const aggFuncSchema = z.enum([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "countEmpty",
  "countFilled",
  "percentEmpty",
  "percentFilled",
]);

const prefsPatchSchema = z.object({
  // 结构由 isFilterNode 校验（允许 null 表示显式清空）。
  filters: z.unknown().optional(),
  sorts: z.array(sortSpecSchema).optional(),
  search: z.string().optional(),
  rowHeight: z.enum(["short", "medium", "tall"]).optional(),
  collapsedGroupKeys: z.array(z.string()).optional(),
  groupByFieldId: z.string().nullable().optional(),
  aggregations: z.record(aggFuncSchema.nullable()).optional(),
});

const updatePrefsSchema = z.object({ prefs: prefsPatchSchema });

/** 取视图并确认存在；同时带出鉴权所需 baseId。 */
async function loadViewForPrefs(viewId: string) {
  const v = await prisma.view.findUnique({
    where: { id: viewId },
    include: { table: { select: { baseId: true } } },
  });
  if (!v) throw new HttpError(404, "视图不存在");
  return v;
}

/**
 * 未自定义用户的基线：视图【默认配置】的使用态。
 * 不读管理员层 —— 用户层夹在视图默认与管理员强制之间，强制筛选/隐藏在
 * resolveViewConfig 阶段才叠加（见 records.ts）。
 */
function baselineFromViewDefault(config: string): ViewUserPrefs {
  const cfg = parseViewConfig(config);
  return defaultViewUserPrefs({
    filters: cfg.filters,
    sorts: cfg.sorts,
    search: cfg.search,
    rowHeight: cfg.rowHeight,
    collapsedGroupKeys: cfg.collapsedGroupKeys,
    groupByFieldId: cfg.groupByFieldId,
    aggregations: cfg.aggregations,
  });
}

async function upsertPrefs(c: Context) {
  const viewId = c.req.param("viewId");
  if (!viewId) throw new HttpError(404, "视图不存在");
  const v = await loadViewForPrefs(viewId);

  // 任意可见者可写，但只能写自己的偏好。
  const { userId } = await requireCanView(c, v.table.baseId);

  const parsed = updatePrefsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);
  }
  const patch = parsed.data.prefs;
  if (
    patch.filters !== undefined &&
    patch.filters !== null &&
    !isFilterNode(patch.filters)
  ) {
    return c.json({ error: "filters 必须是合法的筛选条件" }, 400);
  }

  // 基线：已有 prefs 行用当前行；否则用视图默认使用态（首次自定义即固化，此后默认变更
  // 不再影响该用户）。
  const current = await loadUserPrefs(prisma, viewId, userId);
  const base = current ?? baselineFromViewDefault(v.config);

  const { filters, ...rest } = patch;
  const next: ViewUserPrefs = defaultViewUserPrefs({
    ...base,
    ...rest,
    ...(filters !== undefined
      ? { filters: filters === null ? null : isFilterNode(filters) ? filters : null }
      : {}),
    version: 1,
  });

  await withWriteTx("viewUserPrefs.upsert", async (tx) =>
    tx.viewUserPref.upsert({
      where: { viewId_userId: { viewId, userId } },
      create: { viewId, userId, prefs: JSON.stringify(next) },
      update: { prefs: JSON.stringify(next) },
    }),
  );
  return c.json({ userPrefs: next });
}

// PUT 与 PATCH 同为合并语义（全量快照存储，差异仅在客户端语义偏好）。
viewUserPrefs.put("/:viewId/prefs", upsertPrefs);
viewUserPrefs.patch("/:viewId/prefs", upsertPrefs);

viewUserPrefs.delete("/:viewId/prefs", async (c) => {
  const viewId = c.req.param("viewId");
  if (!viewId) throw new HttpError(404, "视图不存在");
  const v = await loadViewForPrefs(viewId);
  const { userId } = await requireCanView(c, v.table.baseId);

  // 重置为默认：删掉自己的 prefs 行。行不存在（本来就跟随默认）同样返回 200。
  await withWriteTx("viewUserPrefs.reset", async (tx) =>
    tx.viewUserPref.deleteMany({ where: { viewId, userId } }),
  );
  return c.json({ ok: true });
});

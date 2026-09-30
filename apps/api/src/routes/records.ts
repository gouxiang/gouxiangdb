// apps/api/src/routes/records.ts
// 记录 CRUD + 列表查询（含视图配置编排）+ 批量操作 + CSV 导入 + 评论 + 回收站 + 搜索

import { Hono } from "hono";
import { z } from "zod";
import { SEARCH_PREVIEW_LIMIT, boundedPreviewMarker } from "./searchBounds.js";
import { prisma, withWriteTx, runWrite, type DbTx } from "../db.js";
import {
  requireCanView,
  requireCanEditData,
  requireCanComment,
  resolveBaseIdByTable,
  resolveBaseIdByRecord,
  HttpError,
} from "../guards.js";
import { requireTableManage } from "../domain/authz/tableManageGuards.js";
import { resyncTableMaskTx, syncTableForAllScopesTx } from "../domain/authz/scopeProjectionTx.js";
import { projectAdminForNewTableTx } from "../domain/authz/scopeDoubleWrite.js";
import {
  loadTableFields,
  queryRecords,
  parseViewConfig,
  visibleFields,
  hydrateRecordById,
} from "../domain/recordService.js";
import { isComputedFieldType, isSystemFieldType } from "../domain/types.js";
import { parseCSV, inferFieldType, coerceCellValueWithIssue } from "../domain/csv.js";
import { resolveFieldRestoreName, resolveTableRestoreName } from "../domain/restoreName.js";
import { createField } from "../domain/fieldService.js";
import { invalidateOrdinalCache } from "../domain/prismaDeps.js";
import { applyCreateDefaults, applyEditDefaults, applyReverseDefaultsForChild, applyLinkChangeDefaults } from "../domain/defaults.js";
import { syncRecordsTx, deleteRecordsTx, restoreRecordsTx } from "../domain/fieldIndex/sync.js";
import { enqueueChangeEventTx, enqueueChangeEventsTx } from "../domain/search/outbox.js";
import { keysetPagingActive } from "../domain/queryPlan/flags.js";
import { InvalidCursorError, OffsetWindowError } from "../domain/queryPlan/cursor.js";
import {
  syncNavFromEntitiesTx,
  purgeTableNodeTx,
} from "../domain/nav/sync.js";
import { resolveTableMask } from "../domain/authz/maskGate.js";
import { sanitizeViewConfigForMask } from "../domain/authz/fieldMask.js";
// 字段权限读侧（库权限 config.fields 的 hidden 档）：与写侧的 fieldWriteGate 同一份裁决。
import {
  fieldScopeOf,
  stripHiddenFromRecords,
  stripHiddenKeys,
} from "../domain/authz/fieldScope.js";

export const records = new Hono();

// M6/S4：写原语已移入 domain/recordWrite.ts（纯移动）+ re-export 保持既有导入点不变。
import { applyFieldWrites, assertUnique, createRecordTx, parseStoredFields, runMaskWriteGate, softDeleteRecordTx, updateRecordTx } from "../domain/recordWrite.js";
import { fieldWriteGate } from "../domain/authz/libraryPolicy.js";
export { assertRequiredOnCreate, assertUnique } from "../domain/recordWrite.js";

// ============ 工具 ============

async function baseIdOfTable(tableId: string): Promise<string> {
  const b = await resolveBaseIdByTable(tableId);
  if (!b) throw new HttpError(404, "数据表不存在");
  return b;
}

async function baseIdOfRecord(recordId: string): Promise<string> {
  const b = await resolveBaseIdByRecord(recordId);
  if (!b) throw new HttpError(404, "记录不存在");
  return b;
}


// ============ 列表查询 ============

records.get("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  const { userId, access } = await requireCanView(c, baseId);

  const viewId = c.req.query("viewId");
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  const search = c.req.query("search") ?? undefined;
  // S7：仅 keyset 分页正式生效时才识别 cursor；未生效（默认 off/read 未 on）时忽略该参数，
  // 老客户端行为一字不变。深翻窗口/坏游标的 400 也只在 keyset 生效时施加。
  const keysetOn = keysetPagingActive();
  const cursor = keysetOn ? (c.req.query("cursor") || null) : null;

  const fields = await loadTableFields(tableId);
  // 字段权限读侧：被配成 hidden 的字段连定义都不进查询（定义缺席 → hydrate 不填键 → 记录里没有它）。
  // 该表没配 hidden 时 scope.active=false，以下三处全部回落原值，响应逐字节不变。
  const scope = fieldScopeOf(access, tableId, fields);
  const scopeFields = scope.active ? scope.fields : fields;
  let config = parseViewConfig(null);

  if (viewId) {
    const v = await prisma.view.findUnique({ where: { id: viewId } });
    if (v && v.tableId === tableId) config = parseViewConfig(v.config);
  }
  // 视图配置脱敏：分组/聚合/排序/筛选若引用被隐藏字段，会在响应里把它泄回来（分组键值）。
  // 复用 M4/S6 的同一份脱敏实现，不另写一套。
  if (scope.active) config = sanitizeViewConfigForMask(config, scope.visibleIds);

  // M4/S6 fieldMask 出口（on 态）：可见字段子集 + 脱敏 config + 注入跨表可见性 hydrate 依赖
  // + compile 掩码外字段兜底。off/shadow mask=null，以下四项全部回落原值，响应与 S0 字节一致。
  const mask = await resolveTableMask(userId, tableId, scopeFields);
  const queryFields = mask ? mask.visibleFields : scopeFields;
  const queryConfig = mask ? mask.sanitizeConfig(config) : config;

  let result;
  try {
    result = await queryRecords({
      tableId, fields: queryFields, config: queryConfig, limit, offset, search, cursor,
      hydrateDeps: mask?.hydrateDeps,
      compileDeniedFieldIds: mask?.deniedIds ?? null,
      currentUserId: userId,
    });
  } catch (e) {
    // keyset 客户端错误统一转 400（错误类定义不牵 db.js，这里桥接到 HttpError 信封）。
    if (e instanceof InvalidCursorError || e instanceof OffsetWindowError) {
      throw new HttpError(400, e.message);
    }
    throw e;
  }

  // additive：仅 keyset 生效路径带 nextCursor/hasMore/degraded；其余路径键集合与 S0 快照一致。
  // fields/allFields 用同一可见子集（掩码后无权字段不出现，前端字段选择器自然不可选）。
  // 隐藏字段兜底再抹一次键：定义缺席本已不填，但公式/lookup 等计算列可能间接带出，成本是 O(列数)。
  const body: Record<string, unknown> = {
    records: stripHiddenFromRecords(result.records, scope.hiddenIds),
    total: result.total,
    filteredTotal: result.filteredTotal,
    fields: visibleFields(queryFields, queryConfig),
    allFields: queryFields,
    groups: result.groups,
    aggregations: result.aggregations,
  };
  if (keysetOn && "nextCursor" in result) {
    body.nextCursor = result.nextCursor ?? null;
    body.hasMore = result.hasMore ?? false;
    body.degraded = result.degraded ?? [];
  }
  return c.json(body);
});

// ============ 创建 ============

const createSchema = z.object({
  fields: z.record(z.unknown()).optional(),
  // draft=true：网格/看板/画廊/抽屉「先建空行再就地补值」的草稿模式，
  // 跳过创建期必填兜底（与 PATCH 编辑期允许临时为空的语义一致）。
  // 默认 false（缺省）= 严格：直接调 API / 表单提交必须满足必填。
  draft: z.boolean().optional(),
});

records.post("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  const { userId, access } = await requireCanEditData(c, baseId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const fields = await loadTableFields(tableId);

  // M4/S6 写键守卫（事务前）：客户端 payload 带掩码外/只读物理键 -> 403 FORBIDDEN_FIELD，整单不开事务。
  // 只校验客户端原始键；defaultNow 等服务端注入值属系统行为（同 createdTime），不在用户写键集内。
  const mask = await resolveTableMask(userId, tableId, fields);
  runMaskWriteGate(mask, Object.keys(parsed.data.fields ?? {}));

  // 日期字段「新建默认当前时间」：字段配置了 defaultNow 且本次未显式传值时，自动填当前时间。
  // U-10：用【本地墙钟】而非 UTC——UTC+8 用户在 00:00-08:00 新建时，UTC 日期还是昨天，
  // 且 datetime 编辑器（datetime-local）存的就是本地墙钟 yyyy-MM-ddThh:mm，两者必须一致。
  const payloadFields = { ...(parsed.data.fields ?? {}) };
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localDateTime = `${localDate}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  for (const f of fields) {
    if ((f.type === "date" || f.type === "datetime") && (f as { defaultNow?: boolean }).defaultNow) {
      const v = payloadFields[f.id];
      if (v === undefined || v === null || v === "") {
        payloadFields[f.id] = f.type === "date" ? localDate : localDateTime;
      }
    }
  }

  // 事务：创建记录 + 写入字段（含 link_row）要么一起成功，要么整体回滚，
  // 否则「字段校验失败但空记录已落库」会留下孤儿记录。
  const isDraft = parsed.data.draft === true;
  // M6/S4：事务体已移入 domain/recordWrite.ts（纯移动 + 显式传参）。
  // 字段级写闸：人对『仅可见』『隐藏』字段的写入在落盘前被挡（系统自动计算不受限）。
  const fieldGate = fieldWriteGate(access, tableId, (id) => fields.find((f) => f.id === id)?.name ?? id);
  const rec = await withWriteTx("record.create", (tx) => createRecordTx(tx, {
    tableId, payloadFields, fields, userId, isDraft, fieldGate,
  }));

  // 创建期默认逻辑：static 填入、autoNumber 编号、lookup/formula 初值、subtable 整表抓取播种
  // 属于增强行为，失败不应回滚已创建的记录（与编辑期一致）。
  try {
    await runWrite("defaults.create", () => applyCreateDefaults(tableId, rec.id, userId));
  } catch (e) {
    console.error("[defaults] create recalc failed:", e);
  }

  invalidateOrdinalCache(tableId);

  // 反向联动：新建记录若通过 links/subtable 直接挂到某父记录（含新增子表行），
  // 重算父表点引用 formula 默认值；公式字段实时 hydrate，前端据返回失效父表即可。
  let affectedParents: { tableId: string; recordId: string }[] = [];
  try {
    await runWrite("defaults.reverseOnCreate", async () => {
      const rev = await applyReverseDefaultsForChild(tableId, [rec.id], userId);
      affectedParents = rev.parents.flatMap((p) =>
        p.recordIds.map((rid) => ({ tableId: p.tableId, recordId: rid })),
      );
    });
  } catch (e) {
    console.error("[defaults] reverse recalc on create failed:", e);
  }

  // M1/S5：写后只 hydrate 本行返回（单行主键取数），替代旧 queryRecords(noPaging) 全表回查。
  // 取值与列表同一 hydrate 引擎，逐值等于旧全表结果里 .find(r=>r.id===rec.id) 的那一条。
  // M4/S6：on 态写后投影同读出口（可见子集 + 跨表可见性钩子），不回吐掩码字段值。
  const found = await hydrateRecordById(tableId, rec.id, mask
    ? { fields: mask.visibleFields, deps: mask.hydrateDeps }
    : undefined);
  return c.json({ record: found, affectedParents }, 201);
});

// ============ 回收站列表 ============
// 注意：静态路径必须注册在动态 `/:recordId` 之前，否则 Hono 会把 "trash" 当作 recordId
// 匹配到详情路由（历史上回收站页/全局搜索一直 404 的根因）。

records.get("/trash", async (c) => {
  const baseId = c.req.query("baseId");
  if (!baseId) return c.json({ error: "缺少 baseId" }, 400);
  const { access } = await requireCanView(c, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true, name: true },
  });
  const tableIds = tables.map((t) => t.id);
  const tableName = new Map(tables.map((t) => [t.id, t.name]));
  // 字段权限读侧：回收站用「第一个非空值」当记录名，隐藏字段的值不能借这个标题漏出来。
  // 每库表数有限，逐表取一次字段定义即可（该库一条 hidden 都没配时全部为空集，零行为变化）。
  const hiddenByTable = new Map<string, ReadonlySet<string>>();
  for (const t of tables) {
    const scope = fieldScopeOf(access, t.id, await loadTableFields(t.id));
    if (scope.active) hiddenByTable.set(t.id, scope.hiddenIds);
  }

  const [deletedRecords, deletedTables, deletedFields] = await Promise.all([
    prisma.record.findMany({
      where: { tableId: { in: tableIds }, deletedAt: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
    prisma.table.findMany({
      where: { baseId, deletedAt: { not: null } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.field.findMany({
      where: { tableId: { in: tableIds }, deletedAt: { not: null } },
      orderBy: { order: "asc" },
    }),
  ]);

  const fieldsOfTables = await prisma.field.findMany({
    where: { tableId: { in: tableIds } },
    select: { id: true, tableId: true },
  });
  const tableOfField = new Map(fieldsOfTables.map((f) => [f.id, f.tableId]));

  return c.json({
    items: [
      ...deletedTables.map((t) => ({
        kind: "table" as const,
        id: t.id,
        name: t.name,
        deletedAt: t.deletedAt!.toISOString(),
      })),
      ...deletedFields.map((f) => ({
        kind: "field" as const,
        id: f.id,
        name: f.name,
        deletedAt: f.deletedAt!.toISOString(),
        parentName: tableName.get(tableOfField.get(f.id) ?? "") ?? "",
      })),
      ...deletedRecords.map((r) => ({
        kind: "record" as const,
        id: r.id,
        name: recordTitle(r.fields, hiddenByTable.get(r.tableId)),
        deletedAt: r.deletedAt!.toISOString(),
        parentName: tableName.get(r.tableId) ?? "",
      })),
    ],
  });
});

// ============ 全局搜索 ============
// 同理，静态 /search 必须在 /:recordId 之前注册。

records.get("/search", async (c) => {
  const baseId = c.req.query("baseId");
  const q = (c.req.query("q") ?? "").trim();
  if (!baseId) return c.json({ error: "缺少 baseId" }, 400);
  if (q === "") return c.json({ results: [] });
  const { access } = await requireCanView(c, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true, name: true, primaryFieldId: true },
  });

  const results: { recordId: string; tableId: string; tableName: string; title: string; matchedField: string; snippet: string }[] = [];
  const lower = q.toLowerCase();

  for (const t of tables) {
    const fields = await loadTableFields(t.id);
    // 字段权限读侧：隐藏字段既不参与匹配，也不许借标题/摘要漏出去。
    const scope = fieldScopeOf(access, t.id, fields);
    const matchFields = scope.active ? scope.fields : fields;
    // ADR-0005：每表只取前 SEARCH_PREVIEW_LIMIT 条活记录做内存子串匹配（有界预览，
    // 非全量召回）；M5 统一检索派生库落地后替换。截断事实随响应 boundedPreview 标记返回。
    const recs = await prisma.record.findMany({
      where: { tableId: t.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: SEARCH_PREVIEW_LIMIT,
    });
    for (const r of recs) {
      const stored = parseStoredFields(r.fields);
      const primaryValue = scope.hiddenIds.has(t.primaryFieldId) ? undefined : stored[t.primaryFieldId];
      let title = primaryValue !== undefined && primaryValue !== null ? String(primaryValue) : "";

      let matched = "";
      let snippet = "";
      for (const f of matchFields) {
        if (isComputedFieldType(f.type)) continue;
        const v = stored[f.id];
        if (v === null || v === undefined) continue;
        const text = Array.isArray(v) ? v.join(", ") : String(v);
        if (text.toLowerCase().includes(lower)) {
          matched = f.name;
          snippet = text.length > 60 ? `${text.slice(0, 60)}…` : text;
          break;
        }
      }
      if (!matched) continue;
      if (!title) title = snippet;
      results.push({ recordId: r.id, tableId: t.id, tableName: t.name, title, matchedField: matched, snippet });
      if (results.length >= 100) break;
    }
    if (results.length >= 100) break;
  }

  // additive：保留 results 既有形状，另挂有界预览标记（ADR-0005，前端可提示"结果为预览"）。
  return c.json({ results, ...boundedPreviewMarker() });
});

/** 记录名：第一个非空值。hidden 是被隐藏字段集，跳过它们（未传 = 不跳，与加此参数前同义）。 */
function recordTitle(raw: unknown, hidden?: ReadonlySet<string>): string {
  const obj = parseStoredFields(raw);
  for (const [k, v] of Object.entries(obj)) {
    if (hidden?.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : "(空白)";
    return String(v);
  }
  return "(空白)";
}

// ============ 详情 ============

records.get("/:recordId", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  const { userId, access } = await requireCanView(c, baseId);

  const rec = await prisma.record.findUnique({ where: { id: recordId } });
  if (!rec || rec.deletedAt) throw new HttpError(404, "记录不存在");

  const allFields = await loadTableFields(rec.tableId);
  // 字段权限读侧（与列表同口径）：hidden 字段不进字段定义，hydrate 不填键，详情里也没有它。
  const scope = fieldScopeOf(access, rec.tableId, allFields);
  const scopeFields = scope.active ? scope.fields : allFields;
  // M4/S6：on 态详情投影与列表同口径（可见子集 hydrate + 跨表可见性钩子 + fields 清单收窄）。
  // 表级可达性仍由旧成员守卫负责（S6 不新增表级拒绝），本层只做字段维只减不增。
  const mask = await resolveTableMask(userId, rec.tableId, scopeFields);
  const fields = mask ? mask.visibleFields : scopeFields;
  // M1/S5：详情只 hydrate 本行（单行主键取数），替代旧 queryRecords(noPaging) 全表回查再 .find。
  const found = await hydrateRecordById(rec.tableId, recordId, mask
    ? { fields: mask.visibleFields, deps: mask.hydrateDeps }
    : undefined);
  if (!found) throw new HttpError(404, "记录不存在");

  return c.json({
    record: scope.active ? { ...found, fields: stripHiddenKeys(found.fields, scope.hiddenIds) } : found,
    fields,
  });
});

// ============ 更新 ============

const updateSchema = z.object({ fields: z.record(z.unknown()) });

records.patch("/:recordId", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  const { userId, access } = await requireCanEditData(c, baseId);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const rec = await prisma.record.findUnique({ where: { id: recordId } });
  if (!rec || rec.deletedAt) throw new HttpError(404, "记录不存在");

  const fields = await loadTableFields(rec.tableId);

  // M4/S6 写键守卫（事务前）：payload 带掩码外/只读物理键 -> 403 FORBIDDEN_FIELD，整行未改。
  const mask = await resolveTableMask(userId, rec.tableId, fields);
  runMaskWriteGate(mask, Object.keys(parsed.data.fields));

  // 事务：unique 校验 + 物理字段写入 + link_row 写入 + updatedBy 落库，
  // 任一步失败整体回滚，避免「链接写了一半、文本没写」的中间态。
  // M6/S4：事务体已移入 domain/recordWrite.ts（纯移动 + 显式传参）。
  const fieldGate = fieldWriteGate(access, rec.tableId, (id) => fields.find((f) => f.id === id)?.name ?? id);
  await withWriteTx("record.update", (tx) => updateRecordTx(tx, {
    tableId: rec.tableId, recordId, patch: parsed.data.fields, fields, userId, fieldGate,
  }));

  // 编辑期默认值联动：被触发的 lookup/formula 默认字段（及子表格重播种）由后端权威重算
  const changed = new Set(Object.keys(parsed.data.fields));
  if (changed.size > 0) {
    try {
      await runWrite("defaults.edit", () => applyEditDefaults(rec.tableId, recordId, changed, userId));
    } catch (e) {
      // 默认值联动失败不应阻断用户本次保存
      console.error("[defaults] edit recalc failed:", e);
    }
  }

  // 反向联动：
  //  1) 本记录作为某父记录的子表行、其物理字段（如金额/数量）被改 → 重算父表点引用 formula 默认值；
  //  2) 本次直接增删了本记录的 links/subtable 关联行 → 重算本记录自身的点引用 formula 默认值。
  // 公式字段（type=formula）读取时实时 hydrate，无需此处处理；这只补「落库的默认值公式」。
  let affectedParents: { tableId: string; recordId: string }[] = [];
  try {
    await runWrite("defaults.reverseOnUpdate", async () => {
      const rev = await applyReverseDefaultsForChild(rec.tableId, [recordId], userId);
      affectedParents = rev.parents.flatMap((p) =>
        p.recordIds.map((rid) => ({ tableId: p.tableId, recordId: rid })),
      );
      const touchedLink = fields.some(
        (f) => changed.has(f.id) && (f.type === "links" || f.type === "subtable"),
      );
      if (touchedLink) await applyLinkChangeDefaults(rec.tableId, [recordId]);
    });
  } catch (e) {
    console.error("[defaults] reverse recalc failed:", e);
  }

  // M1/S5：写后只 hydrate 本行返回（单行主键取数），替代旧 queryRecords(noPaging) 全表回查。
  // M4/S6：on 态写后投影同读出口（可见子集 + 跨表可见性钩子），不回吐掩码字段值。
  const found = await hydrateRecordById(rec.tableId, recordId, mask
    ? { fields: mask.visibleFields, deps: mask.hydrateDeps }
    : undefined);
  return c.json({
    record: found,
    affectedParents,
  });
});

// ============ 删除 ============

records.delete("/:recordId", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  const { userId } = await requireCanEditData(c, baseId);

  const rec = await prisma.record.findUnique({ where: { id: recordId } });
  if (!rec || rec.deletedAt) throw new HttpError(404, "记录不存在");

  // M1/S4：软删同事务撤掉该记录 sidecar 行（派生索引不保留软删记录，恢复时重建）。
  // M3/S1：原 $transaction([...]) 数组批收紧为交互事务，以承载 outbox 同事务登记。
  // M6/S4：事务体已移入 domain/recordWrite.ts（纯移动）。
  await withWriteTx("record.softDelete", (tx) => softDeleteRecordTx(tx, recordId));
  invalidateOrdinalCache(rec.tableId);

  // 反向联动：被删记录是某父记录的子表行 → 重算父表点引用 formula 默认值。
  // linkRow 已在上面事务中软删，故 includeDeleted 才能据其定位父记录。
  let affectedParents: { tableId: string; recordId: string }[] = [];
  try {
    await runWrite("defaults.reverseOnDelete", async () => {
      const rev = await applyReverseDefaultsForChild(rec.tableId, [recordId], userId, { includeDeleted: true });
      affectedParents = rev.parents.flatMap((p) =>
        p.recordIds.map((rid) => ({ tableId: p.tableId, recordId: rid })),
      );
    });
  } catch (e) {
    console.error("[defaults] reverse recalc on delete failed:", e);
  }
  return c.json({ ok: true, affectedParents });
});

// ============ 批量操作 ============

const bulkDeleteSchema = z.object({ ids: z.array(z.string()).min(1) });
const bulkUpdateSchema = z.object({ ids: z.array(z.string()).min(1), fields: z.record(z.unknown()) });

records.post("/bulk-delete", async (c) => {
  const parsed = bulkDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const first = await prisma.record.findUnique({ where: { id: parsed.data.ids[0]! } });
  if (!first) throw new HttpError(404, "记录不存在");
  const baseId = await baseIdOfTable(first.tableId);
  const { userId } = await requireCanEditData(c, baseId);

  const now = new Date();
  // 只软删属于本表的记录；ids 可能混入其它表/其它 Base 的 id（水平越权防护）。
  const scoped = await prisma.record.findMany({
    where: { id: { in: parsed.data.ids }, tableId: first.tableId, deletedAt: null },
    select: { id: true },
  });
  const scopedIds = scoped.map((r) => r.id);
  if (scopedIds.length === 0) return c.json({ ok: true, count: 0 });

  // 记录软删与关联软删必须原子：否则可能出现「记录已删但关联仍生效」的脏数据
  // M1/S4：同事务删除这些记录的 sidecar 行。
  // M3/S1：原 $transaction([...]) 数组批收紧为交互事务，以承载 outbox 批量登记。
  await withWriteTx("record.bulkSoftDelete", async (tx) => {
    await tx.record.updateMany({
      where: { id: { in: scopedIds } },
      data: { deletedAt: now },
    });
    // linkRow 同样只打软删标记，严格限定在本表记录集合上：
    // 涉及这些记录的 linkRow 必属于本表关联字段，不会误删其它 Base 记录之间的关联关系。
    await tx.linkRow.updateMany({
      where: { OR: [{ parentRowId: { in: scopedIds } }, { childRowId: { in: scopedIds } }], deletedAt: null },
      data: { deletedAt: now },
    });
    await deleteRecordsTx(tx, scopedIds);
    // M5/S1：批量软删逐条登记 delete（合并去重仍按实体各自生效）。
    await enqueueChangeEventsTx(tx, scopedIds.map((id) => ({
      entityType: "record" as const, entityId: id, op: "delete" as const, version: BigInt(now.getTime()),
    })));
  });
  invalidateOrdinalCache(first.tableId);

  // 反向联动：批量删除的子记录 → 父表点引用 formula 默认值重算（linkRow 已软删，includeDeleted）
  try {
    await runWrite("defaults.reverseOnBulkDelete", () =>
      applyReverseDefaultsForChild(first.tableId, scopedIds, userId, { includeDeleted: true }),
    );
  } catch (e) {
    console.error("[defaults] reverse recalc on bulk-delete failed:", e);
  }
  return c.json({ ok: true, count: scopedIds.length });
});

records.post("/bulk-update", async (c) => {
  const parsed = bulkUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const first = await prisma.record.findUnique({ where: { id: parsed.data.ids[0]! } });
  if (!first) throw new HttpError(404, "记录不存在");
  const baseId = await baseIdOfTable(first.tableId);
  const { userId, access } = await requireCanEditData(c, baseId);

  const fields = await loadTableFields(first.tableId);

  // M4/S6 写键守卫（事务前）：批量 payload 带掩码外/只读物理键 -> 403 FORBIDDEN_FIELD，整批不写。
  const mask = await resolveTableMask(userId, first.tableId, fields);
  runMaskWriteGate(mask, Object.keys(parsed.data.fields));
  // 字段级写闸（与单条 create/patch 同源同义）：批量通道不得绕过「仅可见/隐藏字段不可写」。整批拒绝。
  fieldWriteGate(access, first.tableId, (id) => fields.find((f) => f.id === id)?.name ?? id)(
    Object.keys(parsed.data.fields),
  );

  // 先收敛出本表真实待更新的记录 id（防止跨表/跨 Base id 混入）。
  const scopedRows = await prisma.record.findMany({
    where: { id: { in: parsed.data.ids }, tableId: first.tableId, deletedAt: null },
    select: { id: true },
  });
  const scopedIds = scopedRows.map((r) => r.id);
  if (scopedIds.length === 0) return c.json({ ok: true, count: 0 });

  // 写前整批唯一校验：①与批外存量冲突（排除批内 id）；②批内若多条写同一唯一值也拦截。
  const uniqueFields = fields.filter((fld) => fld.unique && !isComputedFieldType(fld.type) && !isSystemFieldType(fld.type));
  for (const uf of uniqueFields) {
    const v = parsed.data.fields[uf.id];
    if (v === undefined || v === null || v === "") continue;
    await assertUnique(first.tableId, fields, { [uf.id]: v }, undefined, scopedIds);
    if (scopedIds.length > 1) {
      throw new HttpError(409, `字段「${uf.name}」要求唯一，批量更新不能将多条记录设为同一值`);
    }
  }

  // 一批记录要么全部写成功，要么全部回滚（避免「前几条改了后几条失败」的半成品）
  await withWriteTx("record.bulkUpdate", async (tx) => {
    for (const id of scopedIds) {
      await applyFieldWrites(first.tableId, id, parsed.data.fields, fields, tx, false);
      await tx.record.update({ where: { id }, data: { updatedBy: userId } });
    }
    // M1/S4：整批 fields 在同一事务内统一重建一次 sidecar（避免逐行重复删插）。
    await syncRecordsTx(tx, first.tableId, scopedIds);
    // M5/S1：批量改，逐条登记 upsert（version 取提交时刻）。
    const bulkEditVersion = BigInt(Date.now());
    await enqueueChangeEventsTx(tx, scopedIds.map((id) => ({
      entityType: "record" as const, entityId: id, op: "upsert" as const, version: bulkEditVersion,
    })));
  });

  // 默认值联动属于增强行为，放在事务外逐个尽力执行，失败不影响批量写入结果
  const changed = new Set(Object.keys(parsed.data.fields));
  if (changed.size > 0) {
    for (const id of scopedIds) {
      try {
        await runWrite("defaults.bulkEdit", () => applyEditDefaults(first.tableId, id, changed, userId));
      } catch {
        // 批量场景默认值联动失败不阻断主流程
      }
    }
    // 反向联动：批量修改的记录若是某父记录的子表行，重算父表点引用 formula 默认值
    try {
      await runWrite("defaults.reverseOnBulkUpdate", () =>
        applyReverseDefaultsForChild(first.tableId, scopedIds, userId),
      );
    } catch (e) {
      console.error("[defaults] reverse recalc on bulk-update failed:", e);
    }
  }
  return c.json({ ok: true, count: scopedIds.length });
});

// ============ CSV 导入 ============

const importSchema = z.object({
  csv: z.string().min(1),
  hasHeader: z.boolean().default(true),
  mapping: z.record(z.string().nullable()).optional(),
});

records.post("/csv-import", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  // 导入数据本身只需 canEditData；但若 CSV 含需要「新建字段」的列，则必须有 canManageSchema（垂直越权防护）。
  const { userId, perm, access } = await requireCanView(c, baseId);
  if (!perm.canEditData) throw new HttpError(403, "当前角色无权编辑数据");

  const parsed = importSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const rows = parseCSV(parsed.data.csv);
  if (rows.length === 0) return c.json({ error: "CSV 为空" }, 400);

  const errors: string[] = [];
  let createdFields = 0;
  let createdRecords = 0;

  const existingFields = await loadTableFields(tableId);
  const header = parsed.data.hasHeader ? rows[0]! : rows[0]!.map((_, i) => `列 ${i + 1}`);
  const dataRows = parsed.data.hasHeader ? rows.slice(1) : rows;

  // 列 → 字段 id
  const columnFieldIds: (string | null)[] = [];
  for (let ci = 0; ci < header.length; ci++) {
    const colName = header[ci]!.trim();
    const mapped = parsed.data.mapping?.[colName];
    if (mapped !== undefined && mapped !== null) {
      columnFieldIds.push(mapped);
      continue;
    }
    // 用列名匹配已有字段
    const hit = existingFields.find((f) => f.name === colName && !isComputedFieldType(f.type));
    if (hit) {
      columnFieldIds.push(hit.id);
      continue;
    }
    // 新建字段（类型推断）——属于表结构变更，必须有 canManageSchema 权限。
    if (!perm.canManageSchema) {
      columnFieldIds.push(null);
      errors.push(`第 ${ci + 1} 列「${colName}」无对应字段，且当前角色无权新建字段（请在导入映射中指定已有列，或由管理员授权）`);
      continue;
    }
    const colValues = dataRows.map((r) => r[ci] ?? "");
    const type = inferFieldType(colValues);
    try {
      // 结构写事务由 createField 内部 withWriteTx 提供；此处不包 runWrite（避免队列自死锁）。
      // P1/S7：此处位于列解析循环、不在任何 withWriteTx 回调内（逐行事务在其后），故直接调
      // createField 无 reentrancy 风险；补传 userId 供结构写后 mask 重算。
      const { field } = await createField(
        { tableId, name: colName || `列 ${ci + 1}`, type: type as never },
        userId,
      );
      columnFieldIds.push(field.id);
      createdFields += 1;
    } catch {
      columnFieldIds.push(null);
      errors.push(`第 ${ci + 1} 列「${colName}」建字段失败`);
    }
  }

  const allFields = await loadTableFields(tableId);
  const fieldById = new Map(allFields.map((f) => [f.id, f]));

  // 字段级写闸（与单条 create/patch 同源）：CSV 的列可能按列名/显式 mapping 命中已有字段，
  // 命中「仅可见/隐藏」字段时整次导入拒绝——批量通道同样不得绕过字段权限。
  fieldWriteGate(access, tableId, (id) => fieldById.get(id)?.name ?? id)(
    columnFieldIds.filter((x): x is string => !!x),
  );

  for (let ri = 0; ri < dataRows.length; ri++) {
    const row = dataRows[ri]!;
    if (row.every((cell) => cell.trim() === "")) continue;
    const payload: Record<string, unknown> = {};
    for (let ci = 0; ci < columnFieldIds.length; ci++) {
      const fid = columnFieldIds[ci];
      if (!fid) continue;
      const f = fieldById.get(fid);
      if (!f || isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;
      // I-1：改用带诊断版本——非法值不再静默置空，记一条 errors 让「问题行」可见；
      // 但不中断导入：该行其余列照常落库（沿用既有的部分导入语义）。
      const { value, issue } = coerceCellValueWithIssue(row[ci] ?? "", f.type as never);
      if (issue) errors.push(`第 ${ri + 1} 行「${f.name}」的${issue}`);
      payload[fid] = value;
    }
    try {
      // U-4：单行「建记录 + 写字段」事务化——中途失败整行回滚，
      // 不再留下 fields 为空的裸记录；行级失败仍只记错误、继续后续行（部分导入语义不变）。
      // M1/S1：每行作为一个独立写工作单元入队（默认逐行，避免长事务阻塞所有写）。
      await withWriteTx("record.csvImportRow", async (tx) => {
        const rec = await tx.record.create({
          data: { tableId, fields: "{}", createdBy: userId, updatedBy: userId },
        });
        await applyFieldWrites(tableId, rec.id, payload, allFields, tx);
        // 唯一校验在同一行事务内、用 tx 做：unique 字段与存量记录（含本次导入此前各行）
        // 冲突即抛 409，被外层 catch 转为该行错误、继续后续行（部分导入语义不变）。
        await assertUnique(tableId, allFields, payload, rec.id, undefined, tx);
        // M5/S1：导入新建记录同事务登记 upsert。
        await enqueueChangeEventTx(tx, {
          entityType: "record", entityId: rec.id, op: "upsert", version: BigInt(Date.now()),
        });
      });
      createdRecords += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "导入某行失败");
    }
  }

  invalidateOrdinalCache(tableId);
  return c.json({ result: { createdFields, createdRecords, errors } }, 201);
});

// ============ 评论 ============

records.get("/:recordId/comments", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  await requireCanView(c, baseId);

  const rows = await prisma.comment.findMany({
    where: { recordId },
    include: { user: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return c.json({
    comments: rows.map((x) => ({
      id: x.id,
      recordId: x.recordId,
      userId: x.userId,
      displayName: x.user.displayName,
      body: x.body,
      createdAt: x.createdAt.toISOString(),
      updatedAt: x.updatedAt.toISOString(),
    })),
  });
});

const commentSchema = z.object({ body: z.string().min(1).max(2000) });

records.post("/:recordId/comments", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  const { userId } = await requireCanComment(c, baseId);

  const parsed = commentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "评论内容不能为空" }, 400);

  const x = await prisma.comment.create({ data: { recordId, userId, body: parsed.data.body } });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  return c.json(
    {
      comment: {
        id: x.id,
        recordId,
        userId,
        displayName: user?.displayName ?? "",
        body: x.body,
        createdAt: x.createdAt.toISOString(),
        updatedAt: x.updatedAt.toISOString(),
      },
    },
    201,
  );
});

records.delete("/comments/:commentId", async (c) => {
  const commentId = c.req.param("commentId");
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new HttpError(404, "评论不存在");
  const baseId = await baseIdOfRecord(comment.recordId);

  // 自己能删自己的；owner/creator 能删全部
  const { userId, role } = await requireCanComment(c, baseId);
  if (comment.userId !== userId && role !== "owner" && role !== "creator") {
    throw new HttpError(403, "无权删除他人评论");
  }
  await prisma.comment.delete({ where: { id: commentId } });
  return c.json({ ok: true });
});

// ============ 回收站：恢复 / 物理删除 ============
// （回收站列表 GET /trash 已上移到 /:recordId 之前注册，避免被动态路由截获）

const restoreSchema = z.object({ kind: z.enum(["record", "table", "field"]) });

/**
 * 恢复记录后回填关联关系。
 *
 * linkRow 在「删除记录」时只打软删标记（不清行），因此恢复记录时必须把关联重新置为有效，
 * 否则会出现「记录恢复了但关联全丢」的静默数据丢失。
 * 仅恢复两端记录都存活的关联：对端仍在回收站的，等它自己被恢复时再回填。
 */
async function restoreLinkRows(
  client: Pick<DbTx, "linkRow" | "record">,
  recordIds: string[],
): Promise<void> {
  if (recordIds.length === 0) return;
  const rows = await client.linkRow.findMany({
    where: {
      OR: [{ parentRowId: { in: recordIds } }, { childRowId: { in: recordIds } }],
      deletedAt: { not: null },
    },
    select: { id: true, parentRowId: true, childRowId: true },
  });
  if (rows.length === 0) return;
  const peerIds = Array.from(new Set(rows.flatMap((r) => [r.parentRowId, r.childRowId])));
  const alive = await client.record.findMany({ where: { id: { in: peerIds }, deletedAt: null }, select: { id: true } });
  const aliveSet = new Set(alive.map((r) => r.id));
  const ids = rows.filter((r) => aliveSet.has(r.parentRowId) && aliveSet.has(r.childRowId)).map((r) => r.id);
  if (ids.length > 0) await client.linkRow.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
}

records.post("/trash/:id/restore", async (c) => {
  const id = c.req.param("id");
  const parsed = restoreSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  // T-1：field/table 恢复可能因同名被自动改名，把最终名字透出给前端（提示文案另行派单）。
  let restoreName: string | undefined;
  let restoreRenamed: boolean | undefined;

  if (parsed.data.kind === "record") {
    const rec = await prisma.record.findUnique({ where: { id }, select: { tableId: true } });
    if (!rec) throw new HttpError(404, "记录不存在");
    // 恢复与彻底删除同档（可管理库）：普通编辑者不能自行恢复已删除的数据。
    await requireTableManage(c, rec.tableId);
    // M5/S1：原 record.update + linkRow + sidecar 三段裸写收紧进单事务，承载 outbox upsert。
    await withWriteTx("record.restore", async (tx) => {
      await tx.record.update({ where: { id }, data: { deletedAt: null } });
      await restoreLinkRows(tx, [id]);
      // M1/S4：记录恢复后按最新 fields 重建 sidecar（只对仍活记录）。
      if (rec) await restoreRecordsTx(tx, rec.tableId, [id]);
      // M5/S1：恢复登记 upsert（worker 重建派生检索行）。
      await enqueueChangeEventTx(tx, {
        entityType: "record", entityId: id, op: "upsert", version: BigInt(Date.now()),
      });
    });
  } else if (parsed.data.kind === "field") {
    const f = await prisma.field.findUnique({
      where: { id },
      select: {
        name: true,
        tableId: true,
        type: true,
        isReverse: true,
        reverseFieldId: true,
        linkFieldId: true,
        table: { select: { baseId: true } },
      },
    });
    if (!f) throw new HttpError(404, "字段不存在");
    // 恢复字段同回收站口径（manage_table）：与彻底删除同一档，不再按 canManageSchema 放行 creator。
    const { userId } = await requireTableManage(c, f.tableId);
    // T-1：恢复前查重名。删除后重建同名字段、再恢复旧的，会在同表落下两个同名活字段
    // （公式 {字段名} 引用歧义 / CSV 按列名匹配歧义）。恢复不能被 409 拒绝，故自动改名。
    const finalName = await resolveFieldRestoreName(prisma, id, f.tableId, f.name);
    await prisma.field.update({ where: { id }, data: { deletedAt: null, name: finalName } });
    restoreName = finalName;
    restoreRenamed = finalName !== f.name;
    // links/subtable 连带恢复的 partner 字段可能位于另一张表，记录其 tableId 供 mask 重算。
    let partnerTableId: string | null = null;
    // links/subtable 配对反向字段一并恢复（删除时是对称软删的，单独恢复一个会成孤儿）
    if (f.type === "links" || f.type === "subtable") {
      const partnerId = f.isReverse ? f.reverseFieldId : f.linkFieldId;
      if (partnerId) {
        const partner = await prisma.field.findUnique({
          where: { id: partnerId },
          select: { name: true, tableId: true, deletedAt: true },
        });
        if (partner) partnerTableId = partner.tableId;
        // 配对字段同样查重名（同一个表内不允许两个同名活字段）；
        // 若它已经是活字段则什么都不做（保持原 updateMany 只复活软删行的语义）。
        if (partner?.deletedAt) {
          const partnerName = await resolveFieldRestoreName(
            prisma, partnerId, partner.tableId, partner.name,
          );
          await prisma.field.updateMany({
            where: { id: partnerId, deletedAt: { not: null } },
            data: { deletedAt: null, name: partnerName },
          });
        }
      }
      // 删字段时 linkRow 只打了软删标记，恢复字段时一并恢复，否则关联数据静默丢失
      const fieldIds = [id, ...(partnerId ? [partnerId] : [])];
      await prisma.linkRow.updateMany({
        where: { linkFieldId: { in: fieldIds }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
    }
    // P1/S7 #11：字段复活（历史非事务现状，不在此重构）后新开一个仅做 mask 重算的事务：
    // 正向表必算；partner 字段若在另一张表，partner 表也重算（同回调内顺序 await）。
    await withWriteTx("field.restore.resync", async (tx2) => {
      await resyncTableMaskTx(tx2, f.tableId, userId);
      if (partnerTableId && partnerTableId !== f.tableId) {
        await resyncTableMaskTx(tx2, partnerTableId, userId);
      }
    });
  } else {
    const t = await prisma.table.findUnique({ where: { id }, select: { baseId: true, name: true } });
    if (!t) throw new HttpError(404, "数据表不存在");
    // 恢复表同回收站口径（manage_table）：与彻底删除同一档，不再按 canManageSchema 放行 creator。
    const { userId } = await requireTableManage(c, id);
    // M3/S3 #14：原裸多写收紧进单事务。恢复表连带恢复字段/记录（级联软删，单恢复会成空壳），
    // 视图 order=-1 重排为可见；nav 子树节点（table/view）原地复活、重算 ord/path
    // （仅当其 base 活；base 仍软删时期望集不含该表，节点保持软删与实体悬挂态一致）。
    let finalName = t.name;
    await withWriteTx("table.restore", async (tx) => {
      // T-1：同字段分支，恢复前查同 base 下同名活表，冲突则自动改名。
      // 硬契约：此处只能用传入的 tx（写队列并发度 1，回调内再入队 runWrite/withWriteTx 会自死锁）。
      finalName = await resolveTableRestoreName(tx, id, t.baseId, t.name);
      await tx.table.update({ where: { id }, data: { deletedAt: null, name: finalName } });
      await tx.field.updateMany({ where: { tableId: id, deletedAt: { not: null } }, data: { deletedAt: null } });
      // 先取回待恢复记录 id，恢复后按「两端都存活」回填关联
      const restoredRows = await tx.record.findMany({
        where: { tableId: id, deletedAt: { not: null } },
        select: { id: true },
      });
      await tx.record.updateMany({ where: { tableId: id, deletedAt: { not: null } }, data: { deletedAt: null } });
      await restoreLinkRows(tx, restoredRows.map((r) => r.id));
      const restoredIds = restoredRows.map((r) => r.id);
      // M1/S4：整表恢复后批量重建全部恢复记录的 sidecar（prisma 自成语句，内部按批删插）。
      if (restoredRows.length > 0) {
        await restoreRecordsTx(tx, id, restoredIds);
        // M5/S1：整表恢复的记录逐条登记 upsert。
        const restoreVersion = BigInt(Date.now());
        await enqueueChangeEventsTx(tx, restoredIds.map((rid) => ({
          entityType: "record" as const, entityId: rid, op: "upsert" as const, version: restoreVersion,
        })));
      }
      // 删表时视图被置 order=-1 隐藏，恢复时按原序无关地重置为可见顺序
      const hiddenViews = await tx.view.findMany({ where: { tableId: id, order: -1 }, select: { id: true } });
      for (let i = 0; i < hiddenViews.length; i++) {
        await tx.view.update({ where: { id: hiddenViews[i]!.id }, data: { order: i } });
      }
      await syncNavFromEntitiesTx(tx);
      // P1/S7 #5：表恢复同建表——为该库每条命中 scope 角色补齐恢复表节点 scope:role 策略，
      // 并补 role_admin 隐含策略（恢复表此前投影随删表被删，须重建；漏补会 OVERDENY）。
      await syncTableForAllScopesTx(tx, "base", t.baseId, id, "add", userId);
      await projectAdminForNewTableTx(tx, t.baseId, id, userId);
    });
    restoreName = finalName;
    restoreRenamed = finalName !== t.name;
  }
  // 恢复记录没有「名字」概念，保持原响应形态；字段/表一律带 renamed+name，前端无需分支判空。
  return c.json(
    restoreName === undefined
      ? { ok: true }
      : { ok: true, renamed: restoreRenamed === true, name: restoreName },
  );
});

records.delete("/trash/:id", async (c) => {
  const id = c.req.param("id");
  const kind = c.req.query("kind") ?? "record";

  if (kind === "record") {
    const rec = await prisma.record.findUnique({ where: { id }, select: { tableId: true } });
    if (!rec) throw new HttpError(404, "记录不存在");
    await requireTableManage(c, rec.tableId);
    // M5/S1：三段裸写收紧进单事务，并在实体物理删后登记 delete 墓碑（change_events 无 FK，
    // 实体行消失后事件仍可被 worker 消费以清派生检索行）。
    await withWriteTx("record.purge", async (tx) => {
      await tx.linkRow.deleteMany({
        where: { OR: [{ parentRowId: id }, { childRowId: id }] },
      });
      await tx.comment.deleteMany({ where: { recordId: id } });
      await tx.record.delete({ where: { id } });
      await enqueueChangeEventTx(tx, {
        entityType: "record", entityId: id, op: "delete", version: BigInt(Date.now()),
      });
    });
  } else if (kind === "field") {
    const f = await prisma.field.findUnique({
      where: { id },
      select: { tableId: true },
    });
    if (!f) throw new HttpError(404, "字段不存在");
    await requireTableManage(c, f.tableId);
    // U-10：物理删 link 字段时连带清掉它产生的 link_row（fields 对 link_rows 无 FK，
    // 不清会留孤儿关联行；record 端 purge 已有 deleteMany/Cascade 双保险，table 端走 Cascade 链）
    await prisma.linkRow.deleteMany({ where: { linkFieldId: id } });
    await prisma.field.delete({ where: { id } });
  } else {
    const t = await prisma.table.findUnique({ where: { id }, select: { baseId: true } });
    if (!t) throw new HttpError(404, "数据表不存在");
    await requireTableManage(c, id);
    // M3/S3 #15：物理删表收紧进事务。nav 守卫先于任何删除：table 节点仍被菜单引用则 409
    // （C-12，不静默级联删菜单）；守卫通过后清 view/table 节点，再清评论、删实体（views 随表 cascade）。
    await withWriteTx("table.purge", async (tx) => {
      await purgeTableNodeTx(tx, id);
      // Comment 无外键级联，物理删表前先清该表所有记录的评论，避免孤儿
      const recIds = await tx.record.findMany({ where: { tableId: id }, select: { id: true } });
      if (recIds.length > 0) {
        await tx.comment.deleteMany({ where: { recordId: { in: recIds.map((r) => r.id) } } });
      }
      await tx.table.delete({ where: { id } });
      // M5/S1：表物理删级联——按 tableId 收集的记录逐条登记 delete（实体随 cascade 消失，
      // 事件无 FK 仍可消费清派生行）。在表删之后、同事务内登记。
      if (recIds.length > 0) {
        const purgeVersion = BigInt(Date.now());
        await enqueueChangeEventsTx(tx, recIds.map((r) => ({
          entityType: "record" as const, entityId: r.id, op: "delete" as const, version: purgeVersion,
        })));
      }
    });
  }
  return c.json({ ok: true });
});


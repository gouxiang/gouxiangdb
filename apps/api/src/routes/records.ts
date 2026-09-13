// apps/api/src/routes/records.ts
// 记录 CRUD + 列表查询（含视图配置编排）+ 批量操作 + CSV 导入 + 评论 + 回收站 + 搜索

import { Hono } from "hono";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, withWriteTx, withWriteBatch, runWrite, type DbTx } from "../db.js";
import {
  requireCanView,
  requireCanEditData,
  requireCanComment,
  requireCanManageBase,
  requireCanManageSchema,
  resolveBaseIdByTable,
  resolveBaseIdByRecord,
  HttpError,
} from "../guards.js";
import {
  loadTableFields,
  queryRecords,
  parseViewConfig,
  visibleFields,
  hydrateRecordById,
} from "../domain/recordService.js";
import { isComputedFieldType, isSystemFieldType } from "../domain/types.js";
import { parseCSV, inferFieldType, coerceCellValue } from "../domain/csv.js";
import { createField } from "../domain/fieldService.js";
import { invalidateOrdinalCache } from "../domain/prismaDeps.js";
import { applyCreateDefaults, applyEditDefaults, applyReverseDefaultsForChild, applyLinkChangeDefaults } from "../domain/defaults.js";
import { syncRecordsTx, deleteRecordsStatement, restoreRecordsTx } from "../domain/fieldIndex/sync.js";
import { isNumberRuleEmpty } from "@gx/shared-types";

export const records = new Hono();

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

function parseStoredFields(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

/**
 * 把 links 字段的写入落到 link_row 表。
 * 数据永远挂在正向字段上（v1 同构）：
 *   正向字段 → parentRowId = 本记录, childRowId = 目标
 *   反向字段 → 找到正向字段 id，parentRowId = 目标, childRowId = 本记录
 *
 * 安全：targets 必须属于该关联字段的「关联表」（relatedTableId）。
 * 正向字段 relatedTableId 指向被关联表（targets 为其子记录）；
 * 反向字段 relatedTableId 回指主表（targets 为其父记录）——两种情况合法目标都在 relatedTableId 内。
 * 防止越权链接/读取其它 Base 的记录（IDOR）。
 */
async function writeLinks(
  linkField: { id: string; isReverse: boolean; reverseFieldId: string | null; linkFieldId: string | null; relationKind: string | null; relatedTableId: string | null },
  recordId: string,
  targets: string[],
  db: DbTx = prisma,
): Promise<void> {
  const forwardId = linkField.isReverse ? (linkField.reverseFieldId ?? linkField.linkFieldId) : linkField.id;
  if (!forwardId) return;

  // 去重：避免同一目标被写入两次触发 (linkFieldId,parentRowId,childRowId) 唯一约束
  targets = Array.from(new Set(targets));

  // 越权校验：所有目标记录必须真实存在且属于该字段的关联表（间接保证同一 Base）。
  if (linkField.relatedTableId && targets.length > 0) {
    const owned = await db.record.findMany({
      where: { id: { in: targets }, tableId: linkField.relatedTableId, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((r) => r.id));
    const illegal = targets.filter((t) => !ownedIds.has(t));
    if (illegal.length > 0) {
      throw new HttpError(400, `关联记录无效：${illegal.length} 条记录不属于关联数据表（可能已删除或无权关联）`);
    }
  }

  // 取正向字段，以正向关系类型判定基数（反向字段自身的 relationKind 是其反向，不能用于判断 bt）。
  const forwardField = linkField.isReverse
    ? await db.field.findUnique({ where: { id: forwardId }, select: { relationKind: true } })
    : null;
  const forwardKind = linkField.isReverse ? (forwardField?.relationKind ?? linkField.relationKind) : linkField.relationKind;

  // 单基数关系（bt，多对一）：多侧的每条子记录只能挂一个父。
  const isBt = forwardKind === "bt";

  if (linkField.isReverse) {
    // 反向字段：recordId 是「逻辑父」（反向视角），targets 是「逻辑子」。
    // 存储结构与正向一致（数据只挂在正向字段），反向写入等价于
    //   parentRowId = 目标（targets），childRowId = 本记录（recordId）
    // 先清掉本记录作为 child 时的现有父链接（"我在哪些父的子列表里"）。
    await db.linkRow.deleteMany({ where: { linkFieldId: forwardId, childRowId: recordId } });
    // bt 关系：每个子（target）只能属于一个父。把它在其它父下的旧链接清掉，
    // 否则一条子记录会同时属于多个父，违反多对一基数。
    if (isBt && targets.length > 0) {
      await db.linkRow.deleteMany({ where: { linkFieldId: forwardId, parentRowId: { in: targets } } });
    }
    for (let i = 0; i < targets.length; i++) {
      await db.linkRow.create({
        data: { linkFieldId: forwardId, parentRowId: targets[i]!, childRowId: recordId, ord: i },
      });
    }
  } else {
    // 正向字段：recordId 是「源」（parentRowId），targets 是「子」（childRowId）。
    if (isBt) {
      // U-6：bt（多对一）本源只能挂一个目标——此前 slice(0,1) 静默丢弃多余目标，
      // 调用方以为写入了 N 条实际只落 1 条（数据丢失无感知）。改为明确报错，
      // 与 :89 越权校验同一失败语义；正常前端路径单选不会触发。
      if (targets.length > 1) {
        throw new HttpError(400, `该关联字段为多对一（每个记录只能关联 1 条），本次传入了 ${targets.length} 条`);
      }
      // bt：本源（每个 B）只能挂一个 A，先清掉本源的旧子链接再写入。
      await db.linkRow.deleteMany({ where: { linkFieldId: forwardId, parentRowId: recordId } });
      for (let i = 0; i < targets.length; i++) {
        await db.linkRow.create({
          data: { linkFieldId: forwardId, parentRowId: recordId, childRowId: targets[i]!, ord: i },
        });
      }
    } else {
      // mm / hm(正向)：多值，清本记录旧链接后重建。
      await db.linkRow.deleteMany({ where: { linkFieldId: forwardId, parentRowId: recordId } });
      for (let i = 0; i < targets.length; i++) {
        await db.linkRow.create({
          data: { linkFieldId: forwardId, parentRowId: recordId, childRowId: targets[i]!, ord: i },
        });
      }
    }
  }
}

/** 拆分写入：物理字段进 records.fields，links 字段进 link_row */
async function applyFieldWrites(
  tableId: string,
  recordId: string,
  patch: Record<string, unknown>,
  fields: Awaited<ReturnType<typeof loadTableFields>>,
  db: DbTx = prisma,
  // 批量路径（bulkUpdate）逐行调用时传 false，由调用方在事务末对整批 id 统一 sync，
  // 避免 N 次重复删插；单条 create/update/CSV 行级事务用默认 true。
  syncSidecar = true,
): Promise<void> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const physical: Record<string, unknown> = {};

  for (const [fieldId, value] of Object.entries(patch)) {
    const f = byId.get(fieldId);
    if (!f) continue;

    // subtable 在存储层与 links 完全一致（同一张 link_row 表，双向字段配对），
    // 只是 UI 层呈现为子表格；写入路由必须与 links 一致，否则关联写不进 link_row。
    if (f.type === "links" || f.type === "subtable") {
      const targets = Array.isArray(value)
        ? (value as unknown[]).map((v) =>
            typeof v === "object" && v !== null && "recordId" in (v as object)
              ? String((v as { recordId: string }).recordId)
              : String(v),
          )
        : value === null || value === ""
          ? []
          : [String(value)];
      await writeLinks(f, recordId, targets, db);
      continue;
    }

    // 计算字段与系统字段不可写
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type) || f.type === "autoNumber") continue;

    // required 校验
    if (f.required && (value === null || value === "" || (Array.isArray(value) && value.length === 0))) {
      throw new HttpError(400, `字段「${f.name}」为必填`);
    }
    // maxLength 校验（单行文本限制字数）
    const maxLen = (f as { maxLength?: number | null }).maxLength;
    if (maxLen && typeof value === "string" && value.length > maxLen) {
      throw new HttpError(400, `字段「${f.name}」最多 ${maxLen} 个字符，当前 ${value.length} 个`);
    }
    physical[fieldId] = value;
  }

  if (Object.keys(physical).length > 0) {
    const current = await db.record.findUnique({ where: { id: recordId }, select: { fields: true } });
    const merged = { ...parseStoredFields(current?.fields), ...physical };
    await db.record.update({ where: { id: recordId }, data: { fields: JSON.stringify(merged) } });
    // M1/S4：fields JSON 写收口于此，同一交互事务内重建该记录的 sidecar 行
    //（先删后插，随事务提交/回滚同生共死）。批量路径传 syncSidecar=false 交由
    // 调用方事务末统一 sync；全局 client（defaults 补偿写）时 sync 自成语句；
    // 内存 mock 缺 $executeRawUnsafe 时 sync 自动跳过。
    if (syncSidecar) await syncRecordsTx(db, tableId, [recordId]);
  }
  void tableId;
}

/**
 * 创建期必填校验：applyFieldWrites 只遍历【本次 payload 出现】的字段，
 * 若整条必填字段被省略则不会被触及，等于必填被绕过。这里对【全表】required
 * 字段统一兜底。但下列字段即便省略也会在创建后被自动填值，应视为已满足：
 *   - date/datetime 的 defaultNow（POST 处理器已提前注入 payload）
 *   - autoNumber 带非空编号规则（applyCreateDefaults 会编号）
 *   - defaultConfig=static 且带非空静态默认（applyCreateDefaults 会填）
 * lookup/formula 默认依赖其它字段、可能算出空，不豁免。
 */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function hasStaticDefault(f: { defaultConfig?: unknown }): boolean {
  const cfg = f.defaultConfig as { mode?: unknown; value?: unknown } | null;
  return !!cfg && cfg.mode === "static" && !isEmptyValue(cfg.value);
}

export async function assertRequiredOnCreate(
  fields: Awaited<ReturnType<typeof loadTableFields>>,
  values: Record<string, unknown>,
): Promise<void> {
  for (const f of fields) {
    if (!f.required) continue;
    // 计算字段/系统字段不参与（也无法在创建时直接写）
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;
    if (!isEmptyValue(values[f.id])) continue;
    // 会被创建后默认逻辑自动填值的字段，豁免：
    //  - autoNumber 带非空编号规则
    //  - defaultConfig=static 且静态值非空
    if (f.type === "autoNumber" && !isNumberRuleEmpty((f.numberRule as never) ?? null)) continue;
    if (hasStaticDefault(f)) continue;
    throw new HttpError(400, `字段「${f.name}」为必填`);
  }
}

/**
 * unique 校验：遍历所有标记 unique 且本次写入了非空值的字段，
 * 检查同表其它未删除记录是否已存在相同值。
 * （旧实现 PATCH 里 findFirst 没带字段值过滤、POST 完全不校验，等于没校验。）
 */
// 导出仅供 M1/S0 characterization 测试直接注入 fake db 锁行为（S6 unique 走索引后对拍）；
// 行为零改动，路由内部仍按原名调用。
export async function assertUnique(
  tableId: string,
  fields: Awaited<ReturnType<typeof loadTableFields>>,
  values: Record<string, unknown>,
  excludeRecordId?: string,
  excludeRecordIds?: string[],
  db: DbTx = prisma,
): Promise<void> {
  const uniqueFields = fields.filter((f) => f.unique && !isComputedFieldType(f.type) && !isSystemFieldType(f.type));
  if (uniqueFields.length === 0) return;

  const exclude = new Set<string>(excludeRecordIds ?? (excludeRecordId ? [excludeRecordId] : []));
  const others = await db.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true, fields: true },
  });
  for (const f of uniqueFields) {
    const v = values[f.id];
    if (v === undefined || v === null || v === "") continue;
    for (const r of others) {
      if (exclude.has(r.id)) continue;
      const stored = parseStoredFields(r.fields);
      if (stored[f.id] === v) {
        throw new HttpError(409, `字段「${f.name}」要求唯一，该值已存在`);
      }
    }
  }
}

// ============ 列表查询 ============

records.get("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  await requireCanView(c, baseId);

  const viewId = c.req.query("viewId");
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  const search = c.req.query("search") ?? undefined;

  const fields = await loadTableFields(tableId);
  let config = parseViewConfig(null);

  if (viewId) {
    const v = await prisma.view.findUnique({ where: { id: viewId } });
    if (v && v.tableId === tableId) config = parseViewConfig(v.config);
  }

  const result = await queryRecords({ tableId, fields, config, limit, offset, search });

  return c.json({
    records: result.records,
    total: result.total,
    filteredTotal: result.filteredTotal,
    fields: visibleFields(fields, config),
    allFields: fields,
    groups: result.groups,
    aggregations: result.aggregations,
  });
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
  const { userId } = await requireCanEditData(c, baseId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const fields = await loadTableFields(tableId);

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
  const rec = await withWriteTx("record.create", async (tx) => {
    // 创建期必填兜底：对全表 required 字段统一校验（含 payload 完全省略的字段）。
    // draft 模式（就地新建空行草稿）跳过，与编辑期允许临时为空保持一致。
    if (!isDraft) {
      await assertRequiredOnCreate(fields, payloadFields);
    }
    // unique 校验放进事务内，避免并发下检查与写入之间被插队（TOCTOU）
    await assertUnique(tableId, fields, payloadFields, undefined, undefined, tx);
    const created = await tx.record.create({
      data: { tableId, fields: "{}", createdBy: userId, updatedBy: userId },
    });
    if (Object.keys(payloadFields).length > 0) {
      await applyFieldWrites(tableId, created.id, payloadFields, fields, tx);
    }
    return created;
  });

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
  const found = await hydrateRecordById(tableId, rec.id);
  return c.json({ record: found, affectedParents }, 201);
});

// ============ 回收站列表 ============
// 注意：静态路径必须注册在动态 `/:recordId` 之前，否则 Hono 会把 "trash" 当作 recordId
// 匹配到详情路由（历史上回收站页/全局搜索一直 404 的根因）。

records.get("/trash", async (c) => {
  const baseId = c.req.query("baseId");
  if (!baseId) return c.json({ error: "缺少 baseId" }, 400);
  await requireCanView(c, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true, name: true },
  });
  const tableIds = tables.map((t) => t.id);
  const tableName = new Map(tables.map((t) => [t.id, t.name]));

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
        name: recordTitle(r.fields),
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
  await requireCanView(c, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true, name: true, primaryFieldId: true },
  });

  const results: { recordId: string; tableId: string; tableName: string; title: string; matchedField: string; snippet: string }[] = [];
  const lower = q.toLowerCase();

  for (const t of tables) {
    const fields = await loadTableFields(t.id);
    const recs = await prisma.record.findMany({
      where: { tableId: t.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: 2000,
    });
    for (const r of recs) {
      const stored = parseStoredFields(r.fields);
      const primaryValue = stored[t.primaryFieldId];
      let title = primaryValue !== undefined && primaryValue !== null ? String(primaryValue) : "";

      let matched = "";
      let snippet = "";
      for (const f of fields) {
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

  return c.json({ results });
});

function recordTitle(raw: unknown): string {
  const obj = parseStoredFields(raw);
  for (const v of Object.values(obj)) {
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
  await requireCanView(c, baseId);

  const rec = await prisma.record.findUnique({ where: { id: recordId } });
  if (!rec || rec.deletedAt) throw new HttpError(404, "记录不存在");

  const fields = await loadTableFields(rec.tableId);
  // M1/S5：详情只 hydrate 本行（单行主键取数），替代旧 queryRecords(noPaging) 全表回查再 .find。
  const found = await hydrateRecordById(rec.tableId, recordId);
  if (!found) throw new HttpError(404, "记录不存在");

  return c.json({ record: found, fields });
});

// ============ 更新 ============

const updateSchema = z.object({ fields: z.record(z.unknown()) });

records.patch("/:recordId", async (c) => {
  const recordId = c.req.param("recordId");
  const baseId = await baseIdOfRecord(recordId);
  const { userId } = await requireCanEditData(c, baseId);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const rec = await prisma.record.findUnique({ where: { id: recordId } });
  if (!rec || rec.deletedAt) throw new HttpError(404, "记录不存在");

  const fields = await loadTableFields(rec.tableId);

  // 事务：unique 校验 + 物理字段写入 + link_row 写入 + updatedBy 落库，
  // 任一步失败整体回滚，避免「链接写了一半、文本没写」的中间态。
  await withWriteTx("record.update", async (tx) => {
    await assertUnique(rec.tableId, fields, parsed.data.fields, recordId, undefined, tx);
    await applyFieldWrites(rec.tableId, recordId, parsed.data.fields, fields, tx);
    await tx.record.update({ where: { id: recordId }, data: { updatedBy: userId } });
  });

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
  const found = await hydrateRecordById(rec.tableId, recordId);
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

  // M1/S4：软删同批撤掉该记录 sidecar 行（派生索引不保留软删记录，恢复时重建）。
  const softDeleteStmts: Prisma.PrismaPromise<unknown>[] = [
    prisma.record.update({ where: { id: recordId }, data: { deletedAt: new Date() } }),
    // 关联数据只打软删标记（不清行）：记录从回收站恢复时，关联关系随之恢复，不会丢数据
    prisma.linkRow.updateMany({
      where: { OR: [{ parentRowId: recordId }, { childRowId: recordId }], deletedAt: null },
      data: { deletedAt: new Date() },
    }),
  ];
  const sidecarDel = deleteRecordsStatement([recordId]);
  if (sidecarDel) softDeleteStmts.push(sidecarDel);
  await withWriteBatch("record.softDelete", softDeleteStmts);
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
  // M1/S4：同批删除这些记录的 sidecar 行。
  const bulkDeleteStmts: Prisma.PrismaPromise<unknown>[] = [
    prisma.record.updateMany({
      where: { id: { in: scopedIds } },
      data: { deletedAt: now },
    }),
    // linkRow 同样只打软删标记，严格限定在本表记录集合上：
    // 涉及这些记录的 linkRow 必属于本表关联字段，不会误删其它 Base 记录之间的关联关系。
    prisma.linkRow.updateMany({
      where: { OR: [{ parentRowId: { in: scopedIds } }, { childRowId: { in: scopedIds } }], deletedAt: null },
      data: { deletedAt: now },
    }),
  ];
  const bulkSidecarDel = deleteRecordsStatement(scopedIds);
  if (bulkSidecarDel) bulkDeleteStmts.push(bulkSidecarDel);
  await withWriteBatch("record.bulkSoftDelete", bulkDeleteStmts);
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
  const { userId } = await requireCanEditData(c, baseId);

  const fields = await loadTableFields(first.tableId);

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
  const { userId, perm } = await requireCanView(c, baseId);
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
      const { field } = await runWrite("field.createFromCsv", () =>
        createField({ tableId, name: colName || `列 ${ci + 1}`, type: type as never }),
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

  for (const row of dataRows) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const payload: Record<string, unknown> = {};
    for (let ci = 0; ci < columnFieldIds.length; ci++) {
      const fid = columnFieldIds[ci];
      if (!fid) continue;
      const f = fieldById.get(fid);
      if (!f || isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;
      payload[fid] = coerceCellValue(row[ci] ?? "", f.type as never);
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
async function restoreLinkRows(recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return;
  const rows = await prisma.linkRow.findMany({
    where: {
      OR: [{ parentRowId: { in: recordIds } }, { childRowId: { in: recordIds } }],
      deletedAt: { not: null },
    },
    select: { id: true, parentRowId: true, childRowId: true },
  });
  if (rows.length === 0) return;
  const peerIds = Array.from(new Set(rows.flatMap((r) => [r.parentRowId, r.childRowId])));
  const alive = await prisma.record.findMany({ where: { id: { in: peerIds }, deletedAt: null }, select: { id: true } });
  const aliveSet = new Set(alive.map((r) => r.id));
  const ids = rows.filter((r) => aliveSet.has(r.parentRowId) && aliveSet.has(r.childRowId)).map((r) => r.id);
  if (ids.length > 0) await prisma.linkRow.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
}

records.post("/trash/:id/restore", async (c) => {
  const id = c.req.param("id");
  const parsed = restoreSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  if (parsed.data.kind === "record") {
    const baseId = await baseIdOfRecord(id);
    await requireCanEditData(c, baseId);
    const rec = await prisma.record.findUnique({ where: { id }, select: { tableId: true } });
    await prisma.record.update({ where: { id }, data: { deletedAt: null } });
    await restoreLinkRows([id]);
    // M1/S4：记录恢复后按最新 fields 重建 sidecar（只对仍活记录，prisma 自成语句）。
    if (rec) await restoreRecordsTx(prisma, rec.tableId, [id]);
  } else if (parsed.data.kind === "field") {
    const f = await prisma.field.findUnique({
      where: { id },
      select: { table: { select: { baseId: true } } },
    });
    if (!f) throw new HttpError(404, "字段不存在");
    // 恢复字段属于表结构变更，与删除字段一致需要 canManageSchema（垂直越权防护）。
    await requireCanManageSchema(c, f.table.baseId);
    await prisma.field.update({ where: { id }, data: { deletedAt: null } });
    // links/subtable 配对反向字段一并恢复（删除时是对称软删的，单独恢复一个会成孤儿）
    const field = await prisma.field.findUnique({ where: { id } });
    if (field && (field.type === "links" || field.type === "subtable")) {
      const partnerId = field.isReverse ? field.reverseFieldId : field.linkFieldId;
      if (partnerId) {
        await prisma.field.updateMany({
          where: { id: partnerId, deletedAt: { not: null } },
          data: { deletedAt: null },
        });
      }
      // 删字段时 linkRow 只打了软删标记，恢复字段时一并恢复，否则关联数据静默丢失
      const fieldIds = [field.id, ...(partnerId ? [partnerId] : [])];
      await prisma.linkRow.updateMany({
        where: { linkFieldId: { in: fieldIds }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
    }
  } else {
    const t = await prisma.table.findUnique({ where: { id }, select: { baseId: true } });
    if (!t) throw new HttpError(404, "数据表不存在");
    // 恢复表属于表结构变更，与删除表一致需要 canManageSchema。
    await requireCanManageSchema(c, t.baseId);
    // 恢复表时连带恢复其字段、记录（删表是级联软删的，单独恢复表会得到空壳）
    await prisma.table.update({ where: { id }, data: { deletedAt: null } });
    await prisma.field.updateMany({ where: { tableId: id, deletedAt: { not: null } }, data: { deletedAt: null } });
    // 先取回待恢复记录 id，恢复后按「两端都存活」回填关联
    const restoredRows = await prisma.record.findMany({
      where: { tableId: id, deletedAt: { not: null } },
      select: { id: true },
    });
    await prisma.record.updateMany({ where: { tableId: id, deletedAt: { not: null } }, data: { deletedAt: null } });
    await restoreLinkRows(restoredRows.map((r) => r.id));
    // M1/S4：整表恢复后批量重建全部恢复记录的 sidecar（prisma 自成语句，内部按批删插）。
    if (restoredRows.length > 0) {
      await restoreRecordsTx(prisma, id, restoredRows.map((r) => r.id));
    }
    // 删表时视图被置 order=-1 隐藏，恢复时按原序无关地重置为可见顺序
    const hiddenViews = await prisma.view.findMany({ where: { tableId: id, order: -1 }, select: { id: true } });
    for (let i = 0; i < hiddenViews.length; i++) {
      await prisma.view.update({ where: { id: hiddenViews[i]!.id }, data: { order: i } });
    }
  }
  return c.json({ ok: true });
});

records.delete("/trash/:id", async (c) => {
  const id = c.req.param("id");
  const kind = c.req.query("kind") ?? "record";

  if (kind === "record") {
    const baseId = await baseIdOfRecord(id);
    await requireCanManageBase(c, baseId);
    await prisma.linkRow.deleteMany({
      where: { OR: [{ parentRowId: id }, { childRowId: id }] },
    });
    await prisma.comment.deleteMany({ where: { recordId: id } });
    await prisma.record.delete({ where: { id } });
  } else if (kind === "field") {
    const f = await prisma.field.findUnique({
      where: { id },
      select: { table: { select: { baseId: true } } },
    });
    if (!f) throw new HttpError(404, "字段不存在");
    await requireCanManageBase(c, f.table.baseId);
    // U-10：物理删 link 字段时连带清掉它产生的 link_row（fields 对 link_rows 无 FK，
    // 不清会留孤儿关联行；record 端 purge 已有 deleteMany/Cascade 双保险，table 端走 Cascade 链）
    await prisma.linkRow.deleteMany({ where: { linkFieldId: id } });
    await prisma.field.delete({ where: { id } });
  } else {
    const t = await prisma.table.findUnique({ where: { id }, select: { baseId: true } });
    if (!t) throw new HttpError(404, "数据表不存在");
    await requireCanManageBase(c, t.baseId);
    // Comment 无外键级联，物理删表前先清该表所有记录的评论，避免孤儿
    const recIds = await prisma.record.findMany({ where: { tableId: id }, select: { id: true } });
    if (recIds.length > 0) {
      await prisma.comment.deleteMany({ where: { recordId: { in: recIds.map((r) => r.id) } } });
    }
    await prisma.table.delete({ where: { id } });
  }
  return c.json({ ok: true });
});


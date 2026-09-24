// apps/api/src/routes/tables.ts
// 数据表 CRUD + 复制 + 清空 + CSV 导出

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx, type DbTx } from "../db.js";
import {
  requireCanView,
  requireCanEditData,
  resolveBaseIdByTable,
  HttpError,
} from "../guards.js";
import {
  requireCreateTable,
  requireTableManage,
  requireSchemaDesign,
} from "../domain/authz/tableManageGuards.js";
import { makeOptions } from "../domain/fieldService.js";
import { loadTableFields } from "../domain/recordService.js";
import { exportTableCsv } from "../domain/csvExport.js";
import { resolveTableMask } from "../domain/authz/maskGate.js";
import { invalidateOrdinalCache } from "../domain/prismaDeps.js";
import { deleteTableTx, rebuildTableTx } from "../domain/fieldIndex/sync.js";
import { enqueueChangeEventsTx } from "../domain/search/outbox.js";
import {
  syncNavFromEntitiesTx,
  softDeleteSubtreeTx,
} from "../domain/nav/sync.js";
import { nodeId } from "../domain/nav/backfill.js";
import { entityIconSchema, entityIconColorSchema } from "../validators/entity-icon.js";

export const tables = new Hono();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  withDefaults: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  primaryFieldId: z.string().optional(),
  // 自定义图标（白名单）与图标颜色（#RRGGBB）；null = 清除回默认，缺省 = 不改动。
  // create 不开放，保持建表轻量。
  icon: entityIconSchema,
  iconColor: entityIconColorSchema,
});

async function baseIdOf(tableId: string): Promise<string> {
  const b = await resolveBaseIdByTable(tableId);
  if (!b) throw new HttpError(404, "数据表不存在");
  return b;
}

// ============ 表名唯一性（同库 + 未软删 + trim 后精确匹配）============
//
// 口径与字段名重名（routes/fields.ts 创建端点）一致：409 + `表名「X」已存在`。
// 不加数据库唯一索引：存量库里已有重复表名，加索引会让迁移失败、老库起不来——
// 唯一性只在应用层保证，且只在「新建 / 改名 / 显式命名复制」三条写路径拦，存量重复不动。
// 查重必须在 withWriteTx 回调内用 tx 做：外部查会有「两个请求都读到没重复→双双写入」的
// 竞态，而 withWriteTx 是并发度 1 的串行写队列，事务内查重可杜绝它（回调内禁止再入队）。

/**
 * 断言名称在该库内未被占用；占用则抛 409（调用方所在事务随之回滚）。
 * excludeTableId：改名场景排除自己，避免「只改图标」或「改名成自己现在的名字」被误判。
 */
async function assertTableNameFree(
  tx: DbTx,
  baseId: string,
  name: string,
  excludeTableId?: string,
): Promise<void> {
  const trimmed = name.trim();
  const dup = await tx.table.findFirst({
    where: {
      baseId,
      name: trimmed,
      deletedAt: null,
      ...(excludeTableId ? { id: { not: excludeTableId } } : {}),
    },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, `表名「${trimmed}」已存在`);
}

/**
 * 复制表未显式命名时的自动排号：base → `${base} 2` → `${base} 3` …
 * 每次候选都在事务内实查（逐个编号），存量库里已存在的同名副本会被自动绕开。
 * 超过 maxTries 仍全部冲突才抛错——正常不会走到，避免无限循环。
 */
async function resolveCopyTableName(
  tx: DbTx,
  baseId: string,
  base: string,
  maxTries = 50,
): Promise<string> {
  for (let i = 1; i <= maxTries; i += 1) {
    const candidate = i === 1 ? base : `${base} ${i}`;
    const dup = await tx.table.findFirst({
      where: { baseId, name: candidate, deletedAt: null },
      select: { id: true },
    });
    if (!dup) return candidate;
  }
  throw new HttpError(409, `表名「${base}」及其后 ${maxTries} 个编号均已被占用`);
}

// ============ Base 下的表列表 ============

tables.get("/", async (c) => {
  const baseId = c.req.query("baseId");
  if (!baseId) return c.json({ error: "缺少 baseId" }, 400);
  await requireCanView(c, baseId);

  const rows = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    include: { _count: { select: { records: { where: { deletedAt: null } } } } },
    orderBy: { createdAt: "asc" },
  });
  return c.json({
    tables: rows.map((t) => ({
      id: t.id,
      baseId: t.baseId,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      icon: t.icon,
      iconColor: t.iconColor,
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdBy,
      recordCount: t._count.records,
    })),
  });
});

// ============ 创建 ============

tables.post("/", async (c) => {
  const baseId = c.req.query("baseId");
  if (!baseId) return c.json({ error: "缺少 baseId" }, 400);
  const { userId } = await requireCreateTable(c, baseId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
  // 表名统一以 trim 后为准落库（「 客户表 」与「客户表」视为同名）。
  // trim 后为空 → 400 拦在事务之前：放行会落库一张看不到名字的表，而且第二次会被
  // assertTableNameFree 拦成 `409 表名「」已存在`——用户既看不到表名也看不懂这句报错。
  const name = parsed.data.name.trim();
  if (!name) return c.json({ error: "表名不能为空" }, 400);

  // U-9：建表多步写事务化——任何一步失败整体回滚，
  // 不再留下无 primaryField / 无视图的半截表。
  const { table, primaryFieldId } = await withWriteTx("table.create", async (tx) => {
    // 表名同库唯一：事务内查重（见 assertTableNameFree 注释），命中则整体回滚，不留半截表。
    await assertTableNameFree(tx, baseId, name);
    // shareEnabled 继承当前库级总闸：表级开关是库级「允许分享」的快照，
    // tableShareAllowed() 两级都判。不继承的话，管理员打开库开关之后新建的表依旧是 0，
    // 又是一张「库已允许、却没入口能开」的死表（表级没有写端点）。
    const owner = await tx.base.findUnique({ where: { id: baseId }, select: { shareEnabled: true } });
    const t = await tx.table.create({
      data: {
        baseId,
        name,
        primaryFieldId: "",
        createdBy: userId,
        shareEnabled: owner?.shareEnabled ?? 0,
      },
    });

    const nameField = await tx.field.create({
      data: { tableId: t.id, name: "名称", type: "singleLineText", order: 0 },
    });
    await tx.table.update({ where: { id: t.id }, data: { primaryFieldId: nameField.id } });

    if (parsed.data.withDefaults) {
      await tx.field.create({
        data: { tableId: t.id, name: "数量", type: "number", order: 1, precision: 0 },
      });
      await tx.field.create({
        data: {
          tableId: t.id,
          name: "状态",
          type: "singleSelect",
          order: 2,
          options: JSON.stringify(makeOptions(["未开始", "进行中", "已完成"])),
        },
      });
      await tx.field.create({ data: { tableId: t.id, name: "日期", type: "date", order: 3 } });
      await tx.field.create({ data: { tableId: t.id, name: "备注", type: "longText", order: 4 } });
    }

    const config = {
      hiddenFieldIds: [],
      fieldOrder: [],
      rowHeight: "medium",
      filters: null,
      sorts: [],
      search: "",
      groupByFieldId: null,
      collapsedGroupKeys: [],
      aggregations: {},
      rowColor: { mode: "none", conditions: [] },
      coverFieldId: null,
      cardFieldIds: [],
      kanbanFieldId: null,
      dateFieldId: null,
      formFields: [],
      formTitle: "",
      formDescription: "",
      detailFieldIds: [],
      detailLayout: null,
    };
    await tx.view.create({
      data: { tableId: t.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(config) },
    });
    // M3/S3 #4：同事务同步 table + view 节点（field 不建节点）。
    await syncNavFromEntitiesTx(tx);
    return { table: t, primaryFieldId: nameField.id };
  });

  return c.json({
    table: {
      id: table.id,
      baseId,
      name: table.name,
      primaryFieldId,
      // create 不接受自定义图标（保持轻量），新表恒为未自定义，由前端渲染默认。
      icon: null,
      iconColor: null,
      createdAt: table.createdAt.toISOString(),
      createdBy: userId,
      recordCount: 0,
    },
  }, 201);
});

// ============ 详情 / 更新 / 删除 ============

tables.get("/:tableId", async (c) => {
  const tableId = c.req.param("tableId");
  const baseId = await baseIdOf(tableId);
  await requireCanView(c, baseId);

  const t = await prisma.table.findUnique({
    where: { id: tableId },
    include: { _count: { select: { records: { where: { deletedAt: null } } } } },
  });
  if (!t || t.deletedAt) throw new HttpError(404, "数据表不存在");

  return c.json({
    table: {
      id: t.id,
      baseId: t.baseId,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      icon: t.icon,
      iconColor: t.iconColor,
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdBy,
      recordCount: t._count.records,
    },
  });
});

tables.patch("/:tableId", async (c) => {
  const tableId = c.req.param("tableId");
  const baseId = await baseIdOf(tableId);
  await requireTableManage(c, tableId);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  // 表名同库唯一：只有显式传了 name 才校验（本端点也用于改 icon/iconColor，那时不得查重）；
  // 排除自己（id: not tableId）——只改图标、或改名成自己现在的名字都不该报 409。
  const trimmedName = parsed.data.name?.trim();
  // 同上：改名塞纯空格会把表改成空串名（看不见），且下次改名还会撞「表名「」已存在」。
  // 只挡显式传了 name 且 trim 后为空的情况——不带 name 的只改图标请求继续放行。
  if (trimmedName !== undefined && !trimmedName) {
    return c.json({ error: "表名不能为空" }, 400);
  }

  // M3/S3 #5：改名收紧进事务（原 runWrite 非事务），同事务同步节点 name。
  // icon / iconColor 不进 nav_nodes（实体图标走读取时解析），故只有改名才触发 nav 同步。
  const t = await withWriteTx("table.update", async (tx) => {
    const data = trimmedName === undefined ? parsed.data : { ...parsed.data, name: trimmedName };
    if (trimmedName !== undefined) await assertTableNameFree(tx, baseId, trimmedName, tableId);
    const updated = await tx.table.update({ where: { id: tableId }, data });
    if (parsed.data.name !== undefined) await syncNavFromEntitiesTx(tx);
    return updated;
  });
  return c.json({
    table: {
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      icon: t.icon,
      iconColor: t.iconColor,
    },
  });
});

tables.delete("/:tableId", async (c) => {
  const tableId = c.req.param("tableId");
  await baseIdOf(tableId);
  await requireTableManage(c, tableId);

  const now = new Date();
  // M3/S3 #6：原 withWriteBatch 数组事务无法承载 nav async 原语，收紧为 withWriteTx 回调；
  // table 及视图节点整棵软删（视图实体置 order=-1 隐藏，views 表无 deletedAt 列）。
  await withWriteTx("table.softDelete", async (tx) => {
    await tx.table.update({ where: { id: tableId }, data: { deletedAt: now } });
    // M5/S1：级联软删的活记录逐条登记 delete（先取 id，再更新）。
    const liveRecords = await tx.record.findMany({
      where: { tableId, deletedAt: null }, select: { id: true },
    });
    await tx.record.updateMany({ where: { tableId }, data: { deletedAt: now } });
    await tx.field.updateMany({ where: { tableId }, data: { deletedAt: now } });
    await tx.view.updateMany({ where: { tableId }, data: { order: -1 } });
    await softDeleteSubtreeTx(tx, nodeId("table", tableId));
    if (liveRecords.length > 0) {
      const softVersion = BigInt(now.getTime());
      await enqueueChangeEventsTx(tx, liveRecords.map((r) => ({
        entityType: "record" as const, entityId: r.id, op: "delete" as const, version: softVersion,
      })));
    }
  });
  invalidateOrdinalCache(tableId);
  return c.json({ ok: true });
});

// ============ 复制表（含字段，不含数据）============

tables.post("/:tableId/duplicate", async (c) => {
  const tableId = c.req.param("tableId");
  const baseId = await baseIdOf(tableId);
  const { userId } = await requireSchemaDesign(c, tableId);

  const src = await prisma.table.findUnique({ where: { id: tableId } });
  if (!src || src.deletedAt) throw new HttpError(404, "数据表不存在");
  const fields = await loadTableFields(tableId);

  const body = await c.req.json().catch(() => ({}));
  // trim 后为空串视同「没传」——避免显式塞一串空格绕过默认名、落库一张看不见名字的表。
  const explicitName = typeof body?.name === "string" ? body.name.trim() : "";
  const withData = body?.withData === true;

  // M3/S3 #7：复制表原 runWrite（非事务）收紧进 withWriteTx；nav 同步 upsert 新表/视图节点。
  // 计划 §4.4-7：复制产生的新表【不自动加菜单 shortcut】，以"未收纳"态等用户编排（菜单层不动）。
  const { copy, primary } = await withWriteTx("table.duplicate", async (tx) => {
  // 表名同库唯一：客户端显式命名 → 冲突直接 409（与建表/改名同口径）；
  // 客户端没传（走默认「X 副本」）→ 不打断流程，事务内自动排号绕开已存在的同名副本。
  let name: string;
  if (explicitName) {
    await assertTableNameFree(tx, baseId, explicitName);
    name = explicitName;
  } else {
    name = await resolveCopyTableName(tx, baseId, `${src.name} 副本`);
  }
  const copy = await tx.table.create({
    // 视觉标识（自定义图标/颜色）随副本继承，避免复制后莫名回退到默认图标。
    // shareEnabled 一并继承源表（它本身是库级「允许分享」总闸的快照）——
    // 否则复制出来的表会默认 0，成为又一张「库已允许、却没入口能开」的死表。
    data: { baseId, name, primaryFieldId: "", createdBy: userId, icon: src.icon, iconColor: src.iconColor, shareEnabled: src.shareEnabled },
  });

  // 字段 id 映射（tabsConfig 内部引用的字段 id 需要重映射）
  // 跨表关系/聚合字段（links/subtable/lookup/rollup/count）依赖其它表或关联字段，
  // 复制成独立表会产生悬挂引用/误配对反向字段，统一跳过（与 NocoDB 复制表语义一致）。
  const SKIP_COPY_TYPES = new Set(["links", "subtable", "lookup", "rollup", "count"]);
  const idMap = new Map<string, string>();
  for (const f of fields) {
    if (SKIP_COPY_TYPES.has(f.type)) continue;
    const nf = await tx.field.create({
      data: {
        tableId: copy.id,
        name: f.name,
        type: f.type,
        description: f.description,
        order: f.order,
        required: f.required,
        unique: f.unique,
        options: f.options ? JSON.stringify(f.options) : null,
        precision: f.precision,
        maxLength: (f as { maxLength?: number | null }).maxLength ?? null,
        defaultNow: Boolean((f as { defaultNow?: boolean }).defaultNow),
        formula: f.formula,
        // tabsConfig 内部字段 id 稍后重映射
        tabsConfig: f.tabsConfig ? JSON.stringify(f.tabsConfig) : null,
      },
    });
    idMap.set(f.id, nf.id);
  }

  // 重映射 tabsConfig 内部引用的字段 id（fieldIds / widths 的 key / rows.items.fieldId）
  for (const f of fields) {
    if (f.type !== "tabs" || !f.tabsConfig) continue;
    const newId = idMap.get(f.id);
    if (!newId) continue;
    const remappedTabs = f.tabsConfig.map((t) => ({
      ...t,
      fieldIds: t.fieldIds.map((fid) => idMap.get(fid)).filter((x): x is string => Boolean(x)),
      widths: t.widths
        ? Object.fromEntries(
            Object.entries(t.widths)
              .filter(([k]) => idMap.has(k))
              .map(([k, v]) => [idMap.get(k)!, v]),
          )
        : undefined,
      rows: t.rows
        ? t.rows.map((r) => ({
            items: r.items
              .filter((it) => idMap.has(it.fieldId))
              .map((it) => ({ fieldId: idMap.get(it.fieldId)!, widthPct: it.widthPct })),
          }))
        : undefined,
    }));
    await tx.field.update({
      where: { id: newId },
      data: { tabsConfig: JSON.stringify(remappedTabs) },
    });
  }

  const primary = idMap.get(src.primaryFieldId) ?? fields[0]?.id ?? "";
  await tx.table.update({ where: { id: copy.id }, data: { primaryFieldId: primary } });

  // 数据复制
  if (withData) {
    const recs = await tx.record.findMany({ where: { tableId, deletedAt: null } });
    const recMap = new Map<string, string>();
    for (const r of recs) {
      const nr = await tx.record.create({
        data: {
          tableId: copy.id,
          fields: r.fields,
          createdBy: r.createdBy,
          updatedBy: r.updatedBy,
        },
      });
      recMap.set(r.id, nr.id);
    }
    // 重映射记录内的字段 id
    for (const [oldId, newRecId] of recMap) {
      const r = recs.find((x) => x.id === oldId);
      if (!r) continue;
      try {
        const obj = JSON.parse(r.fields) as Record<string, unknown>;
        const remapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          remapped[idMap.get(k) ?? k] = v;
        }
        await tx.record.update({ where: { id: newRecId }, data: { fields: JSON.stringify(remapped) } });
      } catch {
        /* 忽略解析失败 */
      }
    }
    // M5/S1：复制产生的新记录逐条登记 upsert（id 为新表记录 id）。
    const dupVersion = BigInt(Date.now());
    await enqueueChangeEventsTx(tx, Array.from(recMap.values()).map((newId) => ({
      entityType: "record" as const, entityId: newId, op: "upsert" as const, version: dupVersion,
    })));
  }

  const config = {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
  };
  await tx.view.create({
    data: { tableId: copy.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(config) },
  });

  // M1/S4：复制表的数据已按新字段 id 重映射落库，全量重建新表 sidecar（派生冗余）。
  if (withData) {
    await rebuildTableTx(tx, copy.id);
  }

  await syncNavFromEntitiesTx(tx);
  return { copy, primary };
  });

  return c.json({
    table: { id: copy.id, name: copy.name, primaryFieldId: primary, icon: copy.icon, iconColor: copy.iconColor },
  }, 201);
});

// ============ CSV 导出 ============

tables.get("/:tableId/export.csv", async (c) => {
  const tableId = c.req.param("tableId");
  const baseId = await baseIdOf(tableId);
  const { userId } = await requireCanView(c, baseId);

  const viewId = c.req.query("viewId");
  let viewConfigRaw: string | null = null;
  if (viewId) {
    const v = await prisma.view.findUnique({ where: { id: viewId } });
    if (v && v.tableId === tableId) viewConfigRaw = v.config;
  }

  // M4/S6：on 态字段门就绪时按可见字段子集投影（表头列序/行值/视图 config 同口径收窄）；
  // off/shadow 返回 null，exportTableCsv 收 undefined 走原路径，与 S0 字节一致。
  const fields = await loadTableFields(tableId);
  const mask = await resolveTableMask(userId, tableId, fields);

  // M1/S5：走只读网关 keyset 分批拉取 + 批量化 hydrate（每批 500），不全表入堆；
  // 视图 filters/sorts/search 的逐值口径由 csvExport 复用 applyViewQuery 保持。
  const { csv } = await exportTableCsv(tableId, viewConfigRaw, undefined, undefined,
    mask && {
      visibleFields: mask.visibleFields,
      sanitizeConfig: mask.sanitizeConfig,
      hydrateDeps: mask.hydrateDeps,
    },
    userId);

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="table-${tableId}.csv"`);
  return c.body(csv);
});

// ============ 清空表数据 ============

tables.post("/:tableId/clear", async (c) => {
  const tableId = c.req.param("tableId");
  const baseId = await baseIdOf(tableId);
  await requireCanEditData(c, baseId);
  // 软删记录，其关联数据同样只打软删标记（不清行），保证从回收站恢复后关联不丢
  const liveRecIds = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true },
  });
  const ids = liveRecIds.map((r) => r.id);
  const clearNow = new Date();
  // M5/S1：原 $transaction([...]) 数组批收紧为交互事务，承载 sidecar 清理与 outbox 批量登记。
  await withWriteTx("table.clear", async (tx) => {
    if (ids.length > 0) {
      // 软删记录，其关联数据同样只打软删标记（不清行），保证从回收站恢复后关联不丢
      await tx.linkRow.updateMany({
        where: { OR: [{ parentRowId: { in: ids } }, { childRowId: { in: ids } }], deletedAt: null },
        data: { deletedAt: clearNow },
      });
    }
    await tx.record.updateMany({
      where: { tableId, deletedAt: null },
      data: { deletedAt: clearNow },
    });
    // M1/S4：表清空同事务撤掉该表全部 sidecar 行（记录可从回收站恢复，恢复时不批量重建——
    // 与「整表恢复」路径不同；单条记录恢复会各自重建）。
    await deleteTableTx(tx, tableId);
    // M5/S1：被清空记录逐条登记 delete。
    if (ids.length > 0) {
      const clearVersion = BigInt(clearNow.getTime());
      await enqueueChangeEventsTx(tx, ids.map((rid) => ({
        entityType: "record" as const, entityId: rid, op: "delete" as const, version: clearVersion,
      })));
    }
  });
  invalidateOrdinalCache(tableId);
  return c.json({ ok: true });
});

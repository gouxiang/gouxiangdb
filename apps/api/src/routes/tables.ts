// apps/api/src/routes/tables.ts
// 数据表 CRUD + 复制 + 清空 + CSV 导出

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../db.js";
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
import {
  createTable,
  updateTable,
  softDeleteTable,
  assertTableNameFree,
  resolveCopyTableName,
} from "../domain/tableService.js";
import { loadTableFields } from "../domain/recordService.js";
import { exportTableCsv } from "../domain/csvExport.js";
import { resolveTableMask } from "../domain/authz/maskGate.js";
import { invalidateOrdinalCache } from "../domain/prismaDeps.js";
import { deleteTableTx, rebuildTableTx } from "../domain/fieldIndex/sync.js";
import { enqueueChangeEventsTx } from "../domain/search/outbox.js";
import { syncNavFromEntitiesTx } from "../domain/nav/sync.js";
import { syncTableForAllScopesTx } from "../domain/authz/scopeProjectionTx.js";
import { projectAdminForNewTableTx } from "../domain/authz/scopeDoubleWrite.js";
import { entityIconSchema, entityIconColorSchema } from "../validators/entity-icon.js";
import {
  recordLocalStructureReplicaTx,
  recordLocalReplicaTx,
} from "../domain/sync/localOutbox.js";
import { offlineNodeId, offlineClientId } from "../configOfflineReplica.js";

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

// 表名唯一性 / 复制自动排号的口径见 domain/tableService.ts（REST 与 MCP 单一真源）。

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
  // trim 后为空 → 400 拦在事务之前：放行会落库一张看不到名字的表，且报错也看不懂。
  const name = parsed.data.name.trim();
  if (!name) return c.json({ error: "表名不能为空" }, 400);

  // U-9：建表多步写事务化（domain/tableService），任何一步失败整体回滚，
  // 不再留下无 primaryField / 无视图的半截表。
  const created = await createTable(
    { baseId, name, withDefaults: parsed.data.withDefaults ?? false },
    userId,
  );

  return c.json({
    table: {
      id: created.tableId,
      baseId,
      name,
      primaryFieldId: created.primaryFieldId,
      // create 不接受自定义图标（保持轻量），新表恒为未自定义，由前端渲染默认。
      icon: null,
      iconColor: null,
      createdAt: created.createdAt.toISOString(),
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
  const { userId } = await requireTableManage(c, tableId);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  // 表名同库唯一：只有显式传了 name 才校验（本端点也用于改 icon/iconColor，那时不得查重）；
  // 改名塞纯空格会把表改成空串名（看不见），只挡显式传了 name 且 trim 后为空的情况。
  if (parsed.data.name !== undefined && !parsed.data.name.trim()) {
    return c.json({ error: "表名不能为空" }, 400);
  }

  // M3/S3 #5：改名收紧进事务（domain/tableService），同事务同步节点 name。
  const t = await updateTable(tableId, baseId, {
    name: parsed.data.name,
    primaryFieldId: parsed.data.primaryFieldId,
    icon: parsed.data.icon,
    iconColor: parsed.data.iconColor,
  }, userId);
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
  const baseId = await baseIdOf(tableId);
  const { userId } = await requireTableManage(c, tableId);

  // M3/S3 #6：删表收紧进事务（domain/tableService）；table 及视图节点整棵软删。
  // baseId 传入供 YN7 结构 oplog（软删后同事务点查仍可见，但显式传更稳）。
  await softDeleteTable(tableId, userId, baseId);
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
  // S2c 补盲：复制出的普通字段（跨表类型已跳过）收集 (newFieldId,name,type)，在 create_table
  // outbox 之后统一落 add_field（顺序即 push 回放顺序：先建表再建字段）。
  const copiedFields: { id: string; name: string; type: string }[] = [];
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
    copiedFields.push({ id: nf.id, name: f.name, type: f.type });
  }
  // S2c 补盲：复制表是「裸建表 + 逐字段复制」，不是 withDefaults 建表，故 create_table 记
  // withDefaults:false、不含子实体 preset 键（与在线 wrapper 对裸建表的忠实表达一致）；字段随后
  // 逐条 add_field。默认关首行零 IO；异常随本事务整体回滚。
  await recordLocalStructureReplicaTx(tx, {
    entityType: "table", entityId: copy.id, tableId: copy.id, baseId,
    op: "create_table", actorId: userId,
    payload: { name, withDefaults: false },
  }, { nodeId: offlineNodeId(), clientId: offlineClientId() });
  for (const cf of copiedFields) {
    // input 严格照 fieldService.ts add_field 拼法：payload 仅 tableId/name/type（跨表类型已跳过，
    // 无 create_link_field / reverseFieldId）。
    await recordLocalStructureReplicaTx(tx, {
      entityType: "field", entityId: cf.id, tableId: copy.id, baseId,
      op: "add_field", actorId: userId,
      payload: { tableId: copy.id, name: cf.name, type: cf.type },
    }, { nodeId: offlineNodeId(), clientId: offlineClientId() });
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
  // S2c 补盲：主字段设置无独立物理写、create_table(withDefaults:false) 也不带 preset，故回放后
  // 服务端 primaryFieldId 会停在 create 时的空串——必须再发一条 update_table_settings 表达。
  // 仅当 primary 非空【且确为本次复制出的新字段 id】时发：既有 fallback `fields[0]?.id` 取的是
  // 源表字段 id（跨表类型被跳过时可能落到它），那不是新表活字段，回放端会 400，不能发。
  if (primary && copiedFields.some((cf) => cf.id === primary)) {
    await recordLocalStructureReplicaTx(tx, {
      entityType: "table", entityId: copy.id, tableId: copy.id, baseId,
      op: "update_table_settings", actorId: userId,
      // 键名严格照回放端 structureRegistry update_table_settings 读取的 payload.primaryFieldId。
      payload: { primaryFieldId: primary },
    }, { nodeId: offlineNodeId(), clientId: offlineClientId() });
  }

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
    // S2c 补盲：复制记录的字段名快照（newFieldId -> name），供 outbox changes 落 fieldName。
    const newFieldName = new Map(copiedFields.map((cf) => [cf.id, cf.name]));
    // 重映射记录内的字段 id；同时收集每条新记录的 FieldChange[]（create：before=null），供
    // 结构 outbox 落完后逐条落 record create（push 适配层把 changes.after 映射成 create.fields）。
    const copiedRecs: { newRecId: string; changes: { fieldId: string; fieldName: string; before: null; after: unknown }[] }[] = [];
    for (const [oldId, newRecId] of recMap) {
      const r = recs.find((x) => x.id === oldId);
      if (!r) continue;
      let remapped: Record<string, unknown> = {};
      try {
        const obj = JSON.parse(r.fields) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          remapped[idMap.get(k) ?? k] = v;
        }
        await tx.record.update({ where: { id: newRecId }, data: { fields: JSON.stringify(remapped) } });
      } catch {
        /* 忽略解析失败 */
      }
      // 只为成功复制的字段（newFieldName 命中）生成 changes；跨表跳过字段残留旧 id，不进 outbox。
      const changes = Object.entries(remapped)
        .filter(([fid]) => newFieldName.has(fid))
        .map(([fid, v]) => ({ fieldId: fid, fieldName: newFieldName.get(fid) ?? fid, before: null, after: v }));
      copiedRecs.push({ newRecId, changes });
    }
    // S2b 补盲：逐条落 record create outbox（在 add_field 之后、create_view 之前；changes 照记录
    // 实际写入字段构造，op=create）。默认关首行零 IO。
    for (const cr of copiedRecs) {
      await recordLocalReplicaTx(tx, {
        entityType: "record", entityId: cr.newRecId, tableId: copy.id,
        op: "create", actorId: userId, changes: cr.changes,
      }, { nodeId: offlineNodeId(), clientId: offlineClientId() });
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
  const newView = await tx.view.create({
    data: { tableId: copy.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(config) },
  });
  // S2c 补盲：复制表固定新建一个网格视图（不复制源表视图），对它落 create_view（input 照
  //   viewService.ts create_view 拼法：payload={tableId,name,type,config}；默认关首行零 IO）。
  await recordLocalStructureReplicaTx(tx, {
    entityType: "view", entityId: newView.id, tableId: copy.id, baseId,
    op: "create_view", actorId: userId,
    payload: { tableId: copy.id, name: "网格视图", type: "grid", config },
  }, { nodeId: offlineNodeId(), clientId: offlineClientId() });

  // M1/S4：复制表的数据已按新字段 id 重映射落库，全量重建新表 sidecar（派生冗余）。
  if (withData) {
    await rebuildTableTx(tx, copy.id);
  }

  await syncNavFromEntitiesTx(tx);
  // P1/S7 #4：复制产生的新表按 scope 现配重算投影（源表字段 mask 不跨复制继承）。
  await syncTableForAllScopesTx(tx, "base", baseId, copy.id, "add", userId);
  await projectAdminForNewTableTx(tx, baseId, copy.id, userId);
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

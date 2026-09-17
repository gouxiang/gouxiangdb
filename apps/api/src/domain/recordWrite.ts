// M6/S4 记录写原语（**从 routes/records.ts 原样移动**；纯重构：除 import 外内容逐字一致）。
//
// 目的（team-lead 裁决 A）：REST 与 MCP 共用同一写实现，避免两套写语义漂移。
// 本文件只含写相关原语与校验：字段掩码写闸门、字段拆分写入（含 links）、创建期必填兜底、unique 校验。
// **不含 Hono Context 依赖**（路由侧负责解析请求与组响应）。
//
// 迁移对照（原 routes/records.ts 行号 -> 本文件）：
//   runMaskWriteGate         45-54  -> 本文件
//   parseStoredFields        70-79  -> 本文件
//   writeLinks               82-169 -> 本文件
//   applyFieldWrites        171-231 -> 本文件
//   isEmptyValue/hasStaticDefault/assertRequiredOnCreate 233-267 -> 本文件
//   assertUnique            269-312 -> 本文件
//   assertUniqueFullScan    314-337 -> 本文件

import { prisma, type DbTx } from "../db.js";
import { HttpError } from "../guards.js";
import { loadTableFields } from "./recordService.js";
import { deleteRecordsTx, syncRecordsTx } from "./fieldIndex/sync.js";
import { enqueueChangeEventTx } from "./search/outbox.js";
import { applyCreateDefaults } from "./defaults.js";
import { sidecarUniqueMatch, findUniqueConflictTx } from "./queryPlan/uniqueSidecar.js";
import type { resolveTableMask } from "./authz/maskGate.js";
import { AuthzFieldError } from "./authz/fieldMask.js";
import { isNumberRuleEmpty } from "@gx/shared-types";
import { isComputedFieldType, isSystemFieldType } from "./types.js";
import { resolveSidecarReadMode, resolveSidecarWriteEnabled } from "./queryPlan/flags.js";

/** M4/S6：字段掩码域错误 -> HTTP 403 FORBIDDEN_FIELD 统一信封（整单拒绝，事务不开）。 */
export function runMaskWriteGate(mask: Awaited<ReturnType<typeof resolveTableMask>>, keys: readonly string[]): void {
  if (!mask) return; // off/shadow：不校验（响应与 S0 一致）
  try {
    mask.assertWritable(keys);
  } catch (e) {
    if (e instanceof AuthzFieldError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
}

export function parseStoredFields(raw: unknown): Record<string, unknown> {
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
export async function applyFieldWrites(
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

  // M1/S6：读计划器 on 且写侧在维护、且 tx 具备 raw 能力时，unique 走 sidecar 等值索引
  //（同事务强一致）。shadow/off/写停/fake prisma/任一非空字段不能精确单列匹配 → 回退全表校验。
  const readOn = resolveSidecarReadMode() === "on" && resolveSidecarWriteEnabled();
  const txHasRaw = typeof (db as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === "function";
  const checked = uniqueFields
    .map((f) => ({ f, v: values[f.id] }))
    .filter((x) => x.v !== undefined && x.v !== null && x.v !== "");
  const allMatchable = checked.every((x) => sidecarUniqueMatch(x.f, x.v) !== null);

  if (readOn && txHasRaw && allMatchable) {
    for (const { f, v } of checked) {
      const conflictId = await findUniqueConflictTx({
        tx: db as unknown, tableId, field: f, value: v, exclude,
        readEnabled: true, writeEnabled: true,
      });
      if (conflictId) {
        throw new HttpError(409, `字段「${f.name}」要求唯一，该值已存在`);
      }
    }
    return;
  }

  await assertUniqueFullScan(tableId, uniqueFields, values, exclude, db);
}

/** S5 前的全表唯一校验（回退路径；sidecar 不可用/不可精确匹配时使用，行为与文案不变）。 */
async function assertUniqueFullScan(
  tableId: string,
  uniqueFields: Awaited<ReturnType<typeof loadTableFields>>,
  values: Record<string, unknown>,
  exclude: Set<string>,
  db: DbTx,
): Promise<void> {
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

/**
 * 软删记录的事务体（**从 routes/records.ts 原样移动**：M1/S4 sidecar 撤销 + M3/S1 outbox 同事务登记）。
 * 调用方职责：前置存在性/权限校验、事务包裹（withWriteTx("record.softDelete")）、
 * 事务后的 invalidateOrdinalCache 与 defaults 反向重算（保持既有顺序不变）。
 */
export async function softDeleteRecordTx(tx: DbTx, recordId: string): Promise<void> {
  await tx.record.update({ where: { id: recordId }, data: { deletedAt: new Date() } });
  // 关联数据只打软删标记（不清行）：记录从回收站恢复时，关联关系随之恢复，不会丢数据
  await tx.linkRow.updateMany({
    where: { OR: [{ parentRowId: recordId }, { childRowId: recordId }], deletedAt: null },
    data: { deletedAt: new Date() },
  });
  await deleteRecordsTx(tx, [recordId]);
  // M5/S1：软删登记 delete（worker 清派生检索行）；与实体写共生死。
  await enqueueChangeEventTx(tx, {
    entityType: "record", entityId: recordId, op: "delete", version: BigInt(Date.now()),
  });
}

/** createRecordTx 入参（MCP 与 REST 同口径；显式传参、无 Hono Context）。 */
export interface CreateRecordParams {
  tableId: string;
  payloadFields: Record<string, unknown>;
  fields: Awaited<ReturnType<typeof loadTableFields>>;
  userId: string;
  /** draft=true 跳过创建期必填兜底（就地新建空行草稿，与编辑期允许临时为空一致）。 */
  isDraft: boolean;
}

/**
 * 创建记录的事务体（**从 routes/records.ts:172-191 原样移动** + 显式传参）。
 * 顺序未改：draft 跳过必填兜底 -> assertRequiredOnCreate -> assertUnique（事务内防 TOCTOU）-> record.create
 * -> applyFieldWrites（含 links/sidecar）-> outbox upsert。调用方负责 defaults 补偿写与写后 hydrate。
 */
export async function createRecordTx(tx: DbTx, params: CreateRecordParams): Promise<{ id: string; tableId: string }> {
    // draft 模式（就地新建空行草稿）跳过，与编辑期允许临时为空保持一致。
    if (!params.isDraft) {
      await assertRequiredOnCreate(params.fields, params.payloadFields);
    }
    // unique 校验放进事务内，避免并发下检查与写入之间被插队（TOCTOU）
    await assertUnique(params.tableId, params.fields, params.payloadFields, undefined, undefined, tx);
    const created = await tx.record.create({
      data: { tableId: params.tableId, fields: "{}", createdBy: params.userId, updatedBy: params.userId },
    });
    if (Object.keys(params.payloadFields).length > 0) {
      await applyFieldWrites(params.tableId, created.id, params.payloadFields, params.fields, tx);
    }
    // M5/S1：同事务登记检索 outbox（实体建，upsert）。失败随本事务整体回滚。
    await enqueueChangeEventTx(tx, {
      entityType: "record", entityId: created.id, op: "upsert", version: BigInt(Date.now()),
    });
    return created;
}

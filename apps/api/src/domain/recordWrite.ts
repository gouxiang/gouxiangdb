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
import { sidecarUniqueMatch, findUniqueConflictTx } from "./queryPlan/uniqueSidecar.js";
import { diffRecordFields } from "./recordChanges/diff.js";
import { appendRecordChangeTx } from "./recordChanges/store.js";
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

/**
 * 变更历史（数据日志）的写点标注。由 create/update 两条路径显式传入：
 * `op` 决定日志条目的类型（create 的 before 恒空 = 初始值快照；update 才是前后值比对），
 * `actorId` 是操作人（null = 系统写）。
 *
 * 不传 = 不记日志。保留这个"不记"的口子是为了让纯内部修复性写入（如 sidecar 回填）
 * 不污染「谁改了什么」这份账。
 */
export interface FieldWriteTrace {
  op: "create" | "update";
  actorId: string | null;
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
  trace?: FieldWriteTrace,
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
    const before = parseStoredFields(current?.fields);
    const merged = { ...before, ...physical };
    await db.record.update({ where: { id: recordId }, data: { fields: JSON.stringify(merged) } });
    // 变更历史：before/after 已在这三行里全部在内存，前后值零额外 IO 即可推出。
    // 与字段写同事务共生死（字段写回滚则日志一并回滚，绝不会出现"日志说改了、实际没改"）。
    // 两道兜底保证它不成为业务写的失败点：
    //   - GX_RECORD_CHANGES 显式 off 时 appendRecordChangeTx 内部直接 return，零开销；
    //   - 写库抛错时它内部 try/catch 吞掉并只告警一次（真旁路），本事务照常提交。
    //   开关默认开启（历史不可回溯补写），见 configRecordChanges.ts 的翻转理由。
    if (trace) {
      const changes = diffRecordFields({ op: trace.op, beforeFields: before, afterFields: merged, fields });
      // update 且一个字段都没真变 → 不落行：「点了保存但什么都没改」不该在日志里刷屏，
      // 更不该留下一条 changes 为空、读侧还要靠"空则不返回"兜底的条目。
      // create 不受此限：记录本身被建出来了，即便没落到物理字段也是一次真实的新建。
      if (trace.op === "create" || changes.length > 0) {
        await appendRecordChangeTx(db, {
          tableId, recordId, op: trace.op, actorId: trace.actorId, changes,
        });
      }
    }
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
export async function softDeleteRecordTx(tx: DbTx, recordId: string, actorId: string | null = null): Promise<void> {
  // select 出 tableId：变更历史行要带 tableId（按表清理/巡检用），靠 update 的返回顺带取回，零额外 IO。
  const deleted = await tx.record.update({
    where: { id: recordId },
    data: { deletedAt: new Date() },
    select: { tableId: true },
  });
  // 关联数据只打软删标记（不清行）：记录从回收站恢复时，关联关系随之恢复，不会丢数据
  await tx.linkRow.updateMany({
    where: { OR: [{ parentRowId: recordId }, { childRowId: recordId }], deletedAt: null },
    data: { deletedAt: new Date() },
  });
  await deleteRecordsTx(tx, [recordId]);
  // 变更历史：软删是整行进回收站，无字段级前后值 → changes 恒空（读侧对 delete 豁免"空则不返回"）。
  await appendRecordChangeTx(tx, {
    tableId: deleted.tableId, recordId, op: "delete", actorId, changes: [],
  });
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
  /**
   * 字段级写闸：由调用方从「角色 × 库」裁决结果派生，收到待写字段名后自行决定抛什么错。
   * 只挡【人】的写入——公式/自动关联等系统自动计算走 applyFieldWrites 内部的
   * isComputedFieldType/isSystemFieldType 分支，根本不经过这里，故不受"仅可见"限制。
   */
  fieldGate?: (fieldIds: readonly string[]) => void;
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
    // 字段级写闸先于任何写：整条记录的字段要么全过，要么一条都不写（不留半条记录）。
    params.fieldGate?.(Object.keys(params.payloadFields));
    // unique 校验放进事务内，避免并发下检查与写入之间被插队（TOCTOU）
    await assertUnique(params.tableId, params.fields, params.payloadFields, undefined, undefined, tx);
    const created = await tx.record.create({
      data: { tableId: params.tableId, fields: "{}", createdBy: params.userId, updatedBy: params.userId },
    });
    if (Object.keys(params.payloadFields).length > 0) {
      await applyFieldWrites(params.tableId, created.id, params.payloadFields, params.fields, tx, true, {
        op: "create", actorId: params.userId,
      });
    }
    // M5/S1：同事务登记检索 outbox（实体建，upsert）。失败随本事务整体回滚。
    await enqueueChangeEventTx(tx, {
      entityType: "record", entityId: created.id, op: "upsert", version: BigInt(Date.now()),
    });
    return created;
}

/** updateRecordTx 入参（MCP 与 REST 同口径；显式传参、无 Hono Context）。 */
export interface UpdateRecordParams {
  tableId: string;
  recordId: string;
  /** 本次写入的字段映射（仅含 payload 出现的键）。 */
  patch: Record<string, unknown>;
  fields: Awaited<ReturnType<typeof loadTableFields>>;
  userId: string;
  /** 同 CreateRecordParams.fieldGate：字段级写闸（只挡人的写入）。 */
  fieldGate?: (fieldIds: readonly string[]) => void;
}

/**
 * 更新记录的事务体（**从 routes/records.ts:388-396 原样移动** + 显式传参）。
 * 顺序未改：assertUnique（排除自身）-> applyFieldWrites（含 links/sidecar）-> record.update(updatedBy)
 * -> outbox upsert。调用方负责 defaults 联动、写后 hydrate 与掩码投影。
 */
export async function updateRecordTx(tx: DbTx, params: UpdateRecordParams): Promise<void> {
    // 字段级写闸先于任何写：与批量路径的 runMaskWriteGate 同口径——整批要么全过要么不写。
    params.fieldGate?.(Object.keys(params.patch));
    await assertUnique(params.tableId, params.fields, params.patch, params.recordId, undefined, tx);
    await applyFieldWrites(params.tableId, params.recordId, params.patch, params.fields, tx, true, {
      op: "update", actorId: params.userId,
    });
    await tx.record.update({ where: { id: params.recordId }, data: { updatedBy: params.userId } });
    // M5/S1：记录改，同事务登记 upsert（与物理字段写共生死）。
    await enqueueChangeEventTx(tx, {
      entityType: "record", entityId: params.recordId, op: "upsert", version: BigInt(Date.now()),
    });
}

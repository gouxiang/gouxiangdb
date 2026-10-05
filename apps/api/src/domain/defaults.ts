// apps/api/src/domain/defaults.ts
// 字段默认内容 / 自动编号 / 子表格整表抓取 —— 创建期播种与编辑期联动重算
//
// 三种默认来源（DefaultConfig）：
//   static  —— 固定值，创建时填入，之后不重算
//   lookup  —— 按筛选从源表取「唯一匹配」记录的某字段值；匹配字段（valueType=field）引用本表
//   formula —— 仅本表标量字段公式，本表依赖字段变化时重算
//
// 子表格（subtable）的 lookup 默认值语义为「整表抓取模板行」：
//   源表=目标表 → 直接建立 linkRow 关联（绝不删除模板记录）
//   源表≠目标表 → 按字段名克隆到实际目标表（标记为种子行），再关联
//   重播种只清理本字段的种子行，手动添加/选择的行保留。

import { prisma } from "../db.js";
import type { FieldMeta, FieldValue } from "./types.js";
import { isComputedFieldType, isSystemFieldType } from "./types.js";
import { loadTableFields } from "./recordService.js";
import { evalFilter, type RawValue } from "./filter.js";
import { formulaFieldRefs, type FormulaValue } from "./formula.js";
import { evaluateRecordFormula } from "./hydrate.js";
import type { DefaultConfig, NumberRule, NumberSegment } from "@gx/shared-types";
import { CURRENT_USER_SENTINEL, isNumberRuleEmpty, isTypeAssignable } from "@gx/shared-types";
import { syncRecordsTx } from "./fieldIndex/sync.js";

// 父记录 fields 中记录「某子表格字段已播种的种子行」的保留 key（cuid 不会与之冲突）
const SEED_MARKER_KEY = "__gxSeeded";

interface SeedEntry {
  sourceId: string;
  childId: string;
  cloned: boolean;
  at: string;
}

type SeedMarker = Record<string, SeedEntry[]>;

function parseStored(raw: unknown): Record<string, unknown> {
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

function asDefaultConfig(v: unknown): DefaultConfig | null {
  if (!v || typeof v !== "object") return null;
  const mode = (v as { mode?: unknown }).mode;
  if (mode === "static" || mode === "lookup" || mode === "formula") return v as DefaultConfig;
  return null;
}

// ============ 标量默认值（static / lookup / formula） ============

/** FormulaValue → 可落库的 cell 值 */
function formulaValueToCell(v: FormulaValue): FieldValue {
  switch (v.t) {
    case "num":
      return v.v;
    case "str":
      return v.v;
    case "bool":
      return v.v;
    case "list":
      return v.v.map((x) => (x.t === "num" ? x.v : x.t === "bool" ? x.v : x.t === "str" ? x.v : null));
    case "null":
      return null;
  }
}

/**
 * 公式默认值求值：与公式字段共用同一套 hydration 取值/类型转换/执行
 * （evaluateRecordFormula → 第一轮基底 + 第二轮公式），
 * 因此默认值公式同样支持普通字段、子表格/关联点字段 {关联.子字段}、以及引用其他公式字段，
 * 同一公式在「公式字段」与「默认设置」两个入口结果完全一致。
 */
async function evalFormulaDefault(tableId: string, recordId: string, formula: string): Promise<FieldValue> {
  const { value } = await evaluateRecordFormula(tableId, recordId, formula);
  return formulaValueToCell(value);
}

/** lookup 抓取：返回源表中唯一命中记录的目标字段值；0 条或多条 → null（不填） */
async function resolveLookupValue(
  cfg: Extract<DefaultConfig, { mode: "lookup" }>,
  self: Record<string, unknown>,
  hostField?: FieldMeta,
): Promise<FieldValue> {
  const sourceFields = await loadTableFields(cfg.sourceTableId);
  const recs = await prisma.record.findMany({
    where: { tableId: cfg.sourceTableId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const matched: typeof recs = [];
  for (const r of recs) {
    const stored = parseStored(r.fields);
    const ok = evalFilter(
      cfg.filter,
      (fid: string): RawValue => stored[fid] ?? null,
      (selfFid: string): RawValue => (self[selfFid] ?? null) as RawValue,
    );
    if (ok) matched.push(r);
  }
  if (matched.length !== 1) return null;

  // 取值字段：显式 valueFieldId，否则源表主字段
  let valueFieldId: string | null = (cfg.valueFieldId as string | null) ?? null;
  if (!valueFieldId) {
    const t = await prisma.table.findUnique({ where: { id: cfg.sourceTableId }, select: { primaryFieldId: true } });
    valueFieldId = t?.primaryFieldId ?? sourceFields[0]?.id ?? null;
  }
  if (!valueFieldId) return null;
  // 运行时类型兜底：取值字段类型必须与宿主字段兼容（存量脏配置/旧数据不跨类型填值）
  if (hostField) {
    const vf = sourceFields.find((f) => f.id === valueFieldId);
    if (vf && !isTypeAssignable(hostField.type as never, vf.type as never)) {
      console.warn(`[defaults] 跳过跨类型默认抓取：字段「${hostField.name}」(${hostField.type}) 不能取「${vf.name}」(${vf.type}) 的值`);
      return null;
    }
  }
  const v = parseStored(matched[0]!.fields)[valueFieldId];
  return (v === undefined ? null : (v as FieldValue)) ?? null;
}

/** 计算一个标量默认字段的当前值（static 直接返回，lookup/formula 计算）；无值返回 null */
async function resolveScalarDefault(
  field: FieldMeta,
  recordId: string,
  self: Record<string, unknown>,
): Promise<FieldValue> {
  const cfg = asDefaultConfig(field.defaultConfig);
  if (!cfg) return null;
  if (cfg.mode === "static") {
    return (cfg.value === undefined ? null : (cfg.value as FieldValue)) ?? null;
  }
  if (cfg.mode === "formula") {
    if (!cfg.formula?.trim()) return null;
    return await evalFormulaDefault(field.tableId, recordId, cfg.formula);
  }
  // lookup（标量字段；子表格的 lookup 走 materializeSubtable）
  return await resolveLookupValue(cfg, self, field);
}

/**
 * 某默认字段在编辑期被哪些「本表字段」触发重算：
 *   formula → 公式引用的本表字段（按名解析为 id）
 *   lookup  → 筛选中 valueType=field 的匹配字段 id
 */
function defaultTriggerFieldIds(field: FieldMeta, allFields?: FieldMeta[]): Set<string> {
  const out = new Set<string>();
  const cfg = asDefaultConfig(field.defaultConfig);
  if (!cfg) return out;
  if (cfg.mode === "formula") {
    const byName = new Map((allFields ?? []).map((f) => [f.name, f]));
    for (const raw of formulaFieldRefs(cfg.formula ?? "")) {
      const name = raw.split(".")[0]!;
      const f = byName.get(name);
      if (f) out.add(f.id);
    }
  } else if (cfg.mode === "lookup") {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { kind?: string; valueType?: string; valueFieldId?: string; children?: unknown[]; child?: unknown };
      if (n.kind === "condition" && n.valueType === "field" && n.valueFieldId) out.add(n.valueFieldId);
      if (Array.isArray(n.children)) n.children.forEach(walk);
      if (n.child) walk(n.child);
    };
    walk(cfg.filter);
  }
  return out;
}

// ============ 自动编号 ============

function padCounter(n: number, digits: number): string {
  const s = String(Math.max(1, n));
  const d = Number.isFinite(digits) && digits > 0 ? Math.floor(digits) : 0;
  return d > s.length ? "0".repeat(d - s.length) + s : s;
}

function timeBucket(format: string, createdAt: Date): string {
  const y = createdAt.getFullYear();
  const m = String(createdAt.getMonth() + 1).padStart(2, "0");
  const d = String(createdAt.getDate()).padStart(2, "0");
  if (format === "yyyy") return String(y);
  if (format === "yyyyMM") return `${y}${m}`;
  return `${y}${m}${d}`;
}

/** 计数器行 id：不依赖外部 cuid 包，随机+时间即可（参照 fieldService.ts newId）。 */
function newCounterId(): string {
  return `anc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** 生成自动编号字符串 */
async function resolveAutoNumber(
  rule: NumberRule,
  tableId: string,
  recordCreatedAt: Date,
  self: Record<string, unknown>,
  hostFieldId: string,
): Promise<string> {
  const segments = rule.segments as NumberSegment[];
  const parts: string[] = [];
  for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
    const seg = segments[segIndex]!;
    if (seg.type === "fixed") {
      parts.push(seg.text ?? "");
    } else if (seg.type === "time") {
      parts.push(timeBucket(seg.format, recordCreatedAt));
    } else if (seg.type === "field") {
      const v = self[seg.fieldId];
      parts.push(v === null || v === undefined ? "" : Array.isArray(v) ? v.join(",") : String(v));
    } else if (seg.type === "counter") {
      const digits = seg.digits ?? 4;
      // 桶由 reset 决定：never→global；year/month/day→按 recordCreatedAt；field→按重置字段值。
      let resetKind: string;
      let bucket: string;
      if (seg.reset === "year") {
        resetKind = "year";
        bucket = timeBucket("yyyy", recordCreatedAt);
      } else if (seg.reset === "month") {
        resetKind = "month";
        bucket = timeBucket("yyyyMM", recordCreatedAt);
      } else if (seg.reset === "day") {
        resetKind = "day";
        bucket = timeBucket("yyyyMMdd", recordCreatedAt);
      } else if (seg.reset === "field") {
        resetKind = "field";
        bucket = seg.resetFieldId ? toComparable(self[seg.resetFieldId]) : "";
      } else {
        resetKind = "global";
        bucket = "global";
      }
      const key = `${hostFieldId}:${segIndex}:${resetKind}:${bucket}`;
      // 原子认领下一个序号（SQLite UPSERT）：不存在从 1 起，存在 value+1。
      // 本函数运行在 applyCreateDefaults 的 runWrite 串行上下文（records.ts:198），
      // 单进程安全；不要在此再排队 withWriteTx。
      const rows = await prisma.$queryRawUnsafe<{ value: bigint | number }[]>(
        "INSERT INTO auto_number_counters (id,tableId,key,value) VALUES (?,?,?,1) "
          + "ON CONFLICT(tableId,key) DO UPDATE SET value=value+1 RETURNING value",
        newCounterId(),
        tableId,
        key,
      );
      const next = Number(rows[0]!.value);
      parts.push(padCounter(next, digits));
    }
  }
  return parts.join("");
}

function toComparable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  return String(v);
}

// ============ 创建期：填默认值 + 编号 + 子表播种 ============

/**
 * 创建记录后应用「创建期」默认逻辑：
 *  1. static 标量默认（payload 未显式给值时）
 *  2. lookup / formula 标量默认（按当前已填值计算；命中才写）
 *  3. autoNumber 规则字段生成编号并持久化
 *  4. subtable 的 lookup 默认 → 整表抓取播种
 * 返回需要写入 fields 的标量键值（subtable 播种已直接落 linkRow/克隆）。
 */
export async function applyCreateDefaults(
  tableId: string,
  recordId: string,
  userId: string,
): Promise<void> {
  const fields = await loadTableFields(tableId);
  const rec = await prisma.record.findUnique({ where: { id: recordId }, select: { fields: true, createdAt: true } });
  if (!rec) return;
  const self = parseStored(rec.fields);

  const writes: Record<string, unknown> = {};

  for (const f of fields) {
    // 自动编号：有规则才持久化
    if (f.type === "autoNumber") {
      const rule = (f.numberRule as NumberRule | null) ?? null;
      if (rule && !isNumberRuleEmpty(rule)) {
        writes[f.id] = await resolveAutoNumber(rule, tableId, rec.createdAt, self, f.id);
      }
      continue;
    }
    // 仅物理字段可落标量默认
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;

    const cfg = asDefaultConfig(f.defaultConfig);
    if (!cfg) continue;

    if (f.type === "subtable" && cfg.mode === "lookup") {
      await materializeSubtable(f, recordId, userId, cfg);
      continue;
    }

    // 子表格只处理 lookup；其余非 subtable 字段处理三态
    if (f.type === "subtable") continue;

    // static：仅当用户未显式给值
    if (cfg.mode === "static") {
      if (self[f.id] === undefined || self[f.id] === null || self[f.id] === "") {
        if (cfg.value !== undefined && cfg.value !== null && cfg.value !== "") {
          // 成员字段的动态「当前用户」：落库这一刻替换成实际操作人的 userId。
          // sentinel 只在这里被消费，不会进入名册查询，故前端不会出现 id 前缀式乱码。
          writes[f.id] =
            f.type === "member" && cfg.value === CURRENT_USER_SENTINEL ? userId : cfg.value;
        }
      }
      continue;
    }
    // lookup / formula：创建时按当前值计算（依赖字段为空通常得 null，则不填）
    const val = await resolveScalarDefault(f, recordId, self);
    if (val !== null && val !== undefined && val !== "") writes[f.id] = val;
  }

  if (Object.keys(writes).length > 0) {
    const merged = { ...self, ...writes };
    await prisma.record.update({ where: { id: recordId }, data: { fields: JSON.stringify(merged) } });
    // M1/S4：默认值/自动编号写入后同连接重建 sidecar（全局 client，自成语句）。
    await syncRecordsTx(prisma, tableId, [recordId]);
  }
}

/**
 * 编辑期联动：当 changedFieldIds 中某字段是某默认字段的触发字段时，重算该默认字段。
 * - lookup/formula 标量：重算并覆盖（键字段变化才触发；手动值在键字段不变时保留）
 * - subtable lookup：匹配字段变化 → 重新播种
 */
export async function applyEditDefaults(
  tableId: string,
  recordId: string,
  changedFieldIds: Set<string>,
  userId: string,
): Promise<void> {
  const fields = await loadTableFields(tableId);
  const rec = await prisma.record.findUnique({ where: { id: recordId }, select: { fields: true } });
  if (!rec) return;
  const self = parseStored(rec.fields);

  const writes: Record<string, unknown> = {};

  for (const f of fields) {
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;
    const cfg = asDefaultConfig(f.defaultConfig);
    if (!cfg) continue;

    // 用户本次直接编辑了该默认字段本身 → 以手动值为准，不重算覆盖
    if (changedFieldIds.has(f.id)) continue;

    // 触发字段集合
    const triggers = defaultTriggerFieldIds(f, fields);
    let hit = false;
    for (const t of triggers) {
      if (changedFieldIds.has(t)) { hit = true; break; }
    }
    if (!hit) continue;

    if (f.type === "subtable" && cfg.mode === "lookup") {
      await materializeSubtable(f, recordId, userId, cfg);
      continue;
    }
    if (f.type === "subtable") continue;

    if (cfg.mode === "static") continue; // static 编辑期不重算
    const val = await resolveScalarDefault(f, recordId, self);
    writes[f.id] = val; // 计算结果（含 null=清空）覆盖，符合"键字段变化即重抓/重算"
  }

  if (Object.keys(writes).length > 0) {
    const merged = { ...self, ...writes };
    await prisma.record.update({ where: { id: recordId }, data: { fields: JSON.stringify(merged) } });
    // M1/S4：编辑期联动重算写入后重建 sidecar（tableId 为本函数首参）。
    await syncRecordsTx(prisma, tableId, [recordId]);
  }
}

// ============ 子表格整表抓取 ============

function readSeedMarker(self: Record<string, unknown>): SeedMarker {
  const m = self[SEED_MARKER_KEY];
  if (m && typeof m === "object") return m as SeedMarker;
  return {};
}

async function materializeSubtable(
  field: FieldMeta,
  parentRecordId: string,
  userId: string,
  cfg: Extract<DefaultConfig, { mode: "lookup" }>,
): Promise<void> {
  const targetTableId = field.relatedTableId;
  if (!targetTableId) return;
  const sourceTableId = cfg.sourceTableId;
  if (!sourceTableId) return;

  const parentRec = await prisma.record.findUnique({ where: { id: parentRecordId }, select: { fields: true } });
  const parentSelf = parseStored(parentRec?.fields);

  // 1) 清理本字段旧种子行
  const marker = readSeedMarker(parentSelf);
  const oldSeeds = marker[field.id] ?? [];
  const directLink = sourceTableId === targetTableId;
  for (const seed of oldSeeds) {
    // 删 linkRow（父→子）
    await prisma.linkRow.deleteMany({
      where: { linkFieldId: field.id, parentRowId: parentRecordId, childRowId: seed.childId },
    });
    // 克隆行（异表）才删除记录；直连模板表记录绝不删
    if (seed.cloned && !directLink) {
      await prisma.linkRow.deleteMany({
        where: { OR: [{ parentRowId: seed.childId }, { childRowId: seed.childId }] },
      });
      await prisma.comment.deleteMany({ where: { recordId: seed.childId } });
      await prisma.record.deleteMany({ where: { id: seed.childId, tableId: targetTableId } });
    }
  }
  delete marker[field.id];

  // 2) 抓取源表命中行
  const sourceFields = await loadTableFields(sourceTableId);
  const sourceRecs = await prisma.record.findMany({
    where: { tableId: sourceTableId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const matched = sourceRecs.filter((r) => {
    const stored = parseStored(r.fields);
    return evalFilter(
      cfg.filter,
      (fid: string): RawValue => stored[fid] ?? null,
      (selfFid: string): RawValue => (parentSelf[selfFid] ?? null) as RawValue,
    );
  });
  if (matched.length === 0) {
    await persistSeedMarker(parentRecordId, parentSelf, marker);
    return;
  }

  // 异表克隆：按字段名映射
  const targetFields = directLink ? sourceFields : await loadTableFields(targetTableId);
  const sourceByName = new Map(sourceFields.map((f) => [f.name, f]));
  const targetByName = new Map(targetFields.map((f) => [f.name, f]));

  const newSeeds: SeedEntry[] = [];
  for (let i = 0; i < matched.length; i++) {
    const src = matched[i]!;
    let childId: string;
    let cloned = false;
    if (directLink) {
      childId = src.id;
    } else {
      // 克隆到目标表：同名、可落物理列的字段拷值
      const srcStored = parseStored(src.fields);
      const clonedFields: Record<string, unknown> = {};
      for (const [name, tf] of targetByName) {
        const sf = sourceByName.get(name);
        if (!sf) continue;
        if (isComputedFieldType(tf.type) || isSystemFieldType(tf.type) || tf.type === "autoNumber") continue;
        if (tf.type === "links" || tf.type === "subtable") continue;
        const v = srcStored[sf.id];
        if (v !== undefined && v !== null) clonedFields[tf.id] = v;
      }
      const created = await prisma.record.create({
        data: { tableId: targetTableId, fields: JSON.stringify(clonedFields), createdBy: userId, updatedBy: userId },
      });
      childId = created.id;
      cloned = true;
      // M1/S4：克隆播种的新行携带物理字段值，重建其 sidecar（目标表）。
      await syncRecordsTx(prisma, targetTableId, [created.id]);
    }
    // 用 upsert 而非 create：可能残留同三元组的历史行（含软删行），否则会撞唯一约束
    await prisma.linkRow.upsert({
      where: {
        linkFieldId_parentRowId_childRowId: {
          linkFieldId: field.id,
          parentRowId: parentRecordId,
          childRowId: childId,
        },
      },
      create: { linkFieldId: field.id, parentRowId: parentRecordId, childRowId: childId, ord: i },
      update: { ord: i, deletedAt: null },
    });
    newSeeds.push({ sourceId: src.id, childId, cloned, at: new Date().toISOString() });
  }

  marker[field.id] = newSeeds;
  await persistSeedMarker(parentRecordId, parentSelf, marker);
}

async function persistSeedMarker(recordId: string, self: Record<string, unknown>, marker: SeedMarker): Promise<void> {
  const hasAny = Object.keys(marker).length > 0;
  const merged = { ...self };
  if (hasAny) merged[SEED_MARKER_KEY] = marker;
  else delete merged[SEED_MARKER_KEY];
  await prisma.record.update({ where: { id: recordId }, data: { fields: JSON.stringify(merged) } });
}

// ============ 反向联动：子表/关联记录变化 → 父表默认值公式重算 ============
//
// 公式字段（type=formula）在读取时实时 hydrate，子表数据一变，父表读出来就是新值，无需落库。
// 但「默认设置里的公式」是落库值：当用户直接在子表 B 改数字、增删子表行时，
// 父表 A 中引用了 {子表格.子字段} 的默认值公式不会被常规 applyEditDefaults 覆盖
//（那只处理本表字段触发），因此需要这里的反向重算，保证「详情页改子表数字/增删行后立即生效」。

/** 该表是否存在引用点字段（含 .）的 formula 默认字段；无则跳过反向重算省 IO */
async function tableHasFormulaDefaultDots(tableId: string): Promise<boolean> {
  const fields = await loadTableFields(tableId);
  return fields.some((f) => {
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) return false;
    const cfg = asDefaultConfig(f.defaultConfig);
    return cfg?.mode === "formula" && (cfg.formula ?? "").includes(".");
  });
}

/**
 * 重算指定父记录上所有【引用点字段】的 formula 默认字段并落库。
 * 幂等：结果与现值相同也写（JSON 重建，开销可忽略）。失败只告警，不阻断调用方主流程。
 */
async function recomputeParentFormulaDefaults(parentTableId: string, parentRecordIds: string[]): Promise<void> {
  const ids = [...new Set(parentRecordIds)];
  if (ids.length === 0) return;
  const fields = await loadTableFields(parentTableId);

  const dotDefaults = fields.filter((f) => {
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) return false;
    const cfg = asDefaultConfig(f.defaultConfig);
    return cfg?.mode === "formula" && (cfg.formula ?? "").includes(".");
  });
  if (dotDefaults.length === 0) return;

  const recs = await prisma.record.findMany({
    where: { id: { in: ids }, tableId: parentTableId, deletedAt: null },
    select: { id: true, fields: true },
  });

  await Promise.all(
    recs.map(async (rec) => {
      const self = parseStored(rec.fields);
      const writes: Record<string, unknown> = {};
      for (const f of dotDefaults) {
        try {
          writes[f.id] = await resolveScalarDefault(f, rec.id, self);
        } catch (e) {
          console.error(`[defaults] reverse formula recalc failed field=${f.id} record=${rec.id}:`, e);
        }
      }
      if (Object.keys(writes).length > 0) {
        await prisma.record.update({
          where: { id: rec.id },
          data: { fields: JSON.stringify({ ...self, ...writes }) },
        });
        // M1/S4：父表点引用公式默认值重算写入后重建 sidecar（父表）。
        await syncRecordsTx(prisma, parentTableId, [rec.id]);
      }
    }),
  );
}

/**
 * 子记录（子表/关联表的一行）发生变化后，找到把它挂为 child 的所有父记录，
 * 重算父表的点引用 formula 默认字段。
 * @param includeDeleted true 用于子记录被删除场景——linkRow 已同步软删，仍需据此找到父记录。
 */
export async function applyReverseDefaultsForChild(
  childTableId: string,
  childRecordIds: string[],
  userId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<{ parents: { tableId: string; recordIds: string[] }[] }> {
  void userId;
  const ids = [...new Set(childRecordIds)];
  if (ids.length === 0) return { parents: [] };

  // 找到以这些记录为 child 的（可能已软删的）linkRow → 其 linkFieldId 是父表的正向 links/subtable 字段
  const linkRows = await prisma.linkRow.findMany({
    where: { childRowId: { in: ids }, ...(opts.includeDeleted ? {} : { deletedAt: null }) },
    select: { linkFieldId: true, parentRowId: true },
  });
  if (linkRows.length === 0) return { parents: [] };

  // 按父表的 link 字段分组（字段所在表即父表）
  const fieldIds = [...new Set(linkRows.map((r) => r.linkFieldId))];
  const linkFields = await prisma.field.findMany({
    where: { id: { in: fieldIds } },
    select: { id: true, tableId: true },
  });
  const fieldTable = new Map(linkFields.map((f) => [f.id, f.tableId]));

  const parentsByTable = new Map<string, Set<string>>();
  for (const row of linkRows) {
    const tableId = fieldTable.get(row.linkFieldId);
    if (!tableId) continue;
    let set = parentsByTable.get(tableId);
    if (!set) {
      set = new Set();
      parentsByTable.set(tableId, set);
    }
    set.add(row.parentRowId);
  }

  const parents: { tableId: string; recordIds: string[] }[] = [];
  for (const [tableId, parentIds] of parentsByTable) {
    parents.push({ tableId, recordIds: [...parentIds] });
    // 快速短路：父表没有点引用 formula 默认字段就不落库重算
    if (!(await tableHasFormulaDefaultDots(tableId))) continue;
    await recomputeParentFormulaDefaults(tableId, [...parentIds]);
  }
  void childTableId;
  return { parents };
}

/**
 * 父记录上 links/subtable 关联集合发生增删后，重算父记录自身的点引用 formula 默认字段。
 * 与 applyEditDefaults 互补：后者只在「本表物理字段变化」时触发，
 * 而关联行增删（linkRow 变化）不经过物理字段，需要这里显式重算。
 */
export async function applyLinkChangeDefaults(
  parentTableId: string,
  parentRecordIds: string[],
): Promise<void> {
  const ids = [...new Set(parentRecordIds)];
  if (ids.length === 0) return;
  if (!(await tableHasFormulaDefaultDots(parentTableId))) return;
  await recomputeParentFormulaDefaults(parentTableId, ids);
}

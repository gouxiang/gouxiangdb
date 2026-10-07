// apps/api/src/domain/hydrate.ts
// 记录 hydration 核心（v1 Core/RecordRepository.swift hydrate TS 严格同构）
//
// 两轮计算（与 v1 一致）：
//   第一轮：物理字段 → 系统字段 → autoNumber → links(正/反) → lookup → rollup → count
//   第二轮：formula（公式可引用第一轮的所有结果，包括 {关联字段} 与 {关联字段.子字段}）
//
// 三个必须保真移植的 v1 真 bug 修复点：
//   1. 双向关联无限递归 → hydrateLinked 浅层（跳过 links/lookup/rollup/count/formula）
//   2. bt(多对一) 的反向是 hm(一对多)，不是 bt
//   3. 公式点引用 {关联字段.子字段} 要真查关联记录的子字段，不是拿 title 糊弄
//
// v2 相对 v1 的改进：抽出 HydrateDeps 依赖注入，使 hydrate 可在无 DB 的情况下单测。

import type { FieldMeta, FieldValue, LinkRef, RawRecord, HydratedRecord } from "./types.js";
import { isComputedFieldType, isSystemFieldType } from "./types.js";
import { safeEvaluateFormula, formulaFieldRefs, fnum, fstr, fbool, flist, FNULL, type FormulaValue } from "./formula.js";
import { prismaDeps } from "./prismaDeps.js";
import { evalFilter, type RawValue } from "./filter.js";

// ============ 依赖注入 ============

export interface LinkRowRef {
  id: string;
  linkFieldId: string;
  parentRowId: string;
  childRowId: string;
  ord: number;
}

export interface HydrateDeps {
  getFields(tableId: string): Promise<FieldMeta[]>;
  getRecordsByIds(ids: string[]): Promise<RawRecord[]>;
  getLinkRows(q: { linkFieldId?: string; parentRowId?: string; childRowId?: string }): Promise<LinkRowRef[]>;
  countLinkRows(q: { linkFieldId?: string; parentRowId?: string; childRowId?: string }): Promise<number>;
  /** autoNumber 用：该记录在表内的序号（1-based） */
  getRecordOrdinal(tableId: string, recordId: string): Promise<number>;
  resolveUserName(userId: string): Promise<string>;
  /**
   * M1/S5 可选批量：按 (linkFieldId, 方向) 分组，每组一条 parentRowId IN / childRowId IN 查询。
   * 只增不改：未实现时 hydrate 回退到逐条 getLinkRows（值完全一致，仅查询数不收敛）。
   * 返回与 qs 同序、同组的 linkRows（已排除软删，顺序不要求，解析侧按 ord 重排）。
   */
  getLinkRowsBulk?(qs: LinkBatchQuery[]): Promise<LinkRowRef[][]>;
  /**
   * M1/S5 可选批量：一次 user IN 解析页内去重后的 createdBy/updatedBy。
   * 未实现时回退逐条 resolveUserName（值一致）。返回 userId -> 显示名（缺失键由调用方回退 id）。
   */
  resolveUserNames?(userIds: string[]): Promise<Record<string, string>>;
  /**
   * M4/S6 可选字段掩码（fieldMask 五出口，引擎永久单一化后恒由
   * authz/maskSession 注入）。
   * 返回 null=该表不裁剪；否则给表级可见性与可见字段集（空集=表级完全不可见）。
   * 结构类型（不 import authz 域，避免 hydrate -> authz 反向依赖）。
   */
  resolveFieldVisibility?(tableId: string): Promise<{ tableVisible: boolean; visibleIds: ReadonlySet<string> | null } | null>;
}

/** 批量 linkRows 查询的一组：dir="parent" 表示本组记录是 parent（正向，取 child）；"child" 反之。 */
export interface LinkBatchQuery {
  linkFieldId: string;
  dir: "parent" | "child";
  rowIds: string[];
}

interface HydrationContext {
  deps: HydrateDeps;
  fieldCache: Map<string, FieldMeta[]>;
  /** 浅层记录缓存：tableId:recordId -> 物理字段值 map */
  shallowCache: Map<string, Record<string, FieldValue>>;
  /** 完整 hydration 缓存：tableId:recordId -> 第一轮+公式后的字段值 map（点引用取子记录值用） */
  mergedCache: Map<string, Record<string, FieldValue>>;
  /** 嵌套 hydration 进行中的记录键（点引用循环依赖守卫，区别于顶层 stack） */
  merging: Set<string>;
  /** 防递归栈 */
  stack: Set<string>;
}

function createContext(deps: HydrateDeps, firstTableId: string, fields: FieldMeta[]): HydrationContext {
  return {
    deps,
    fieldCache: new Map([[firstTableId, fields]]),
    shallowCache: new Map(),
    mergedCache: new Map(),
    merging: new Set(),
    stack: new Set(),
  };
}

// ============ 主入口 ============

/**
 * M1/S5 两阶段批量化开关：GX_HYDRATE_PREFETCH=off 回退旧逐行串行实现（紧急回滚，
 * 行为与取值完全一致，仅查询数不收敛）。未设置/=on 均走批量预取（NODE_ENV=test 也默认开，
 * 由 S0 逐值快照对拍保证一致）。
 */
function resolvePrefetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GX_HYDRATE_PREFETCH !== "off";
}

export async function hydrateRecords(
  records: RawRecord[],
  fields: FieldMeta[],
  deps: HydrateDeps,
): Promise<HydratedRecord[]> {
  if (records.length === 0) return [];
  if (!resolvePrefetchEnabled()) return await hydrateRecordsLegacy(records, fields, deps);

  // 两阶段：BatchStore 沿 links 依赖图 BFS 预热（每字段×方向一条 linkRows IN、每对端表一条
  // records IN、每表一次 fields、页内用户一次 IN），随后逐行跑【原封不动】的第一轮 + 公式。
  // 缓存未命中仍回退单条查询，故正确性不依赖预热完整度；cell 取值与旧实现逐值一致。
  const { BatchStore } = await import("./hydrateBatch.js");
  const store = new BatchStore(deps);
  const tableId = records[0]!.tableId;
  store.seedFields(tableId, fields);
  await store.prefetch(records);

  const ctx = createContext(store.wrappedDeps(), tableId, fields);
  const out: HydratedRecord[] = [];
  for (const r of records) {
    ctx.stack.clear();
    out.push(await hydrateOne(r, fields, ctx));
  }
  return out;
}

/**
 * 旧逐行串行实现（M1/S5 前的行为）：每行新建递归上下文，逐字段/逐对端 N+1 查询。
 * 保留为 GX_HYDRATE_PREFETCH=off 的回滚分支与逐值 A/B 对照基线，不得改其取值算法。
 */
export async function hydrateRecordsLegacy(
  records: RawRecord[],
  fields: FieldMeta[],
  deps: HydrateDeps,
): Promise<HydratedRecord[]> {
  const ctx = createContext(deps, records[0]?.tableId ?? "", fields);
  const out: HydratedRecord[] = [];
  for (const r of records) {
    ctx.stack.clear();
    out.push(await hydrateOne(r, fields, ctx));
  }
  return out;
}

// ============ 单条 hydration ============

async function hydrateOne(raw: RawRecord, fields: FieldMeta[], ctx: HydrationContext): Promise<HydratedRecord> {
  const visitKey = `${raw.tableId}:${raw.id}`;

  // 递归切断：返回空壳（v1 同类保护）
  if (ctx.stack.has(visitKey)) {
    return {
      id: raw.id,
      tableId: raw.tableId,
      fields: {},
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      createdBy: raw.createdBy,
      updatedBy: raw.updatedBy,
    };
  }
  ctx.stack.add(visitKey);
  ctx.merging.add(visitKey);

  // ---- 第一轮 ----
  const merged = await buildFirstPassMerged(raw, fields, ctx);

  // ---- 第二轮：formula ----
  // 按依赖拓扑序计算：链式公式（A 引用 B）不依赖字段排列顺序，循环依赖置 null 不炸整表。
  // （此前按 fields.order 顺序求值，公式结果会随字段拖动顺序变化，属静默数据错误。）
  await computeFormulas(raw, fields, merged, ctx);

  ctx.mergedCache.set(visitKey, merged);
  ctx.merging.delete(visitKey);
  ctx.stack.delete(visitKey);

  return {
    id: raw.id,
    tableId: raw.tableId,
    fields: merged,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    createdBy: raw.createdBy,
    updatedBy: raw.updatedBy,
  };
}

// ============ 第一轮：物理 → 系统 → autoNumber → links/subtable → lookup/rollup/count ============

/**
 * 计算记录的第一轮字段基底（不含公式）。
 * hydrateOne 与 evaluateRecordFormula（默认值公式统一求值）共用，保证两条链路取值完全一致。
 */
export async function buildFirstPassMerged(
  raw: RawRecord,
  fields: FieldMeta[],
  ctx: HydrationContext,
): Promise<Record<string, FieldValue>> {
  const stored = parseStored(raw.fields);
  const merged: Record<string, FieldValue> = {};

  for (const f of fields) {
    if (isComputedFieldType(f.type) || isSystemFieldType(f.type)) continue;
    merged[f.id] = stored[f.id] ?? null;
  }

  // 系统字段
  for (const f of fields) {
    switch (f.type) {
      case "createdTime":
        merged[f.id] = raw.createdAt;
        break;
      case "lastModifiedTime":
        merged[f.id] = raw.updatedAt;
        break;
      case "createdBy":
        merged[f.id] = raw.createdBy ? await ctx.deps.resolveUserName(raw.createdBy) : null;
        break;
      case "lastModifiedBy":
        merged[f.id] = raw.updatedBy ? await ctx.deps.resolveUserName(raw.updatedBy) : null;
        break;
      case "autoNumber":
        // 配置了编号规则的 autoNumber 在创建时已持久化为字符串编号，优先使用（稳定、不随删除/排序变）；
        // 无规则旧字段回退为记录序号现算。
        if (stored[f.id] !== null && stored[f.id] !== undefined && stored[f.id] !== "") {
          merged[f.id] = stored[f.id];
        } else {
          merged[f.id] = await ctx.deps.getRecordOrdinal(raw.tableId, raw.id);
        }
        break;
      default:
        break;
    }
  }

  // links / subtable（正向 + 反向）—— subtable 在存储层与 links 完全一致，UI 层呈现为子表格
  for (const f of fields) {
    if (f.type !== "links" && f.type !== "subtable") continue;
    merged[f.id] = f.isReverse
      ? await resolveReverseLinks(raw, f, ctx)
      : await resolveForwardLinks(raw, f, ctx);
  }

  // lookup / rollup / count
  for (const f of fields) {
    if (f.type === "lookup") {
      merged[f.id] = await resolveLookup(raw, f, fields, ctx);
    } else if (f.type === "rollup") {
      const vals = await resolveLookup(raw, f, fields, ctx);
      merged[f.id] = applyRollup(f, vals);
    } else if (f.type === "count") {
      merged[f.id] = await resolveCount(raw, f, fields, ctx);
    }
  }

  return merged;
}

// ============ 公式 ============

/**
 * 按依赖拓扑序计算所有公式字段。
 * - 公式可引用其他公式字段（链式），用 Kahn 拓扑排序保证被引用者先算
 * - 循环依赖（A 引用 B，B 引用 A）无法求值的字段置 null，不炸整表
 */
async function computeFormulas(
  raw: RawRecord,
  fields: FieldMeta[],
  merged: Record<string, FieldValue>,
  ctx: HydrationContext,
): Promise<void> {
  const formulaFields = fields.filter((f) => f.type === "formula" && f.formula);
  if (formulaFields.length === 0) return;

  const byName = new Map(fields.map((f) => [f.name, f]));

  // 依赖边：本公式 -> 它引用的公式字段 id
  const deps = new Map<string, Set<string>>();
  for (const f of formulaFields) {
    const refs = formulaFieldRefs(f.formula!);
    const set = new Set<string>();
    for (const r of refs) {
      // 点引用的顶层名字是关联字段名，不是公式字段，跳过
      const target = byName.get(r.split(".")[0]!);
      if (target && target.type === "formula" && target.id !== f.id) set.add(target.id);
    }
    deps.set(f.id, set);
  }

  // Kahn
  const done = new Set<string>();
  let progressed = true;
  while (progressed && done.size < formulaFields.length) {
    progressed = false;
    for (const f of formulaFields) {
      if (done.has(f.id)) continue;
      const d = deps.get(f.id) ?? new Set();
      if ([...d].some((x) => !done.has(x))) continue;
      await evalOneFormula(raw, f, fields, merged, ctx);
      done.add(f.id);
      progressed = true;
    }
  }
  // 剩下的都是循环依赖
  for (const f of formulaFields) {
    if (!done.has(f.id)) merged[f.id] = null;
  }
}

async function evalOneFormula(
  raw: RawRecord,
  self: FieldMeta,
  fields: FieldMeta[],
  merged: Record<string, FieldValue>,
  ctx: HydrationContext,
): Promise<void> {
  const src = await buildFormulaSource(self.formula!, self.id, fields, merged, ctx);
  const { value } = safeEvaluateFormula(self.formula!, src);
  merged[self.id] = formulaValueToCell(value);
}

/**
 * 构造公式的字段取值函数（含点引用真查子字段）。
 * 跨表数据统一在「字段层」解析为带类型的值后注入，公式引擎只做常规函数/表达式，不再自行查跨表：
 * - {字段名}          ：物理字段或计算字段值（自引用 excludeFieldId 返回 null，防死循环）
 * - {关联字段}        ：LinkRef[] → title 用 ", " 拼接（展示用字符串）
 * - {关联字段.子字段} ：真查每条关联记录的该子字段值，**保留原始类型**：
 *                       · 0 条 / 无值       → null
 *                       · 恰好 1 条有效值    → 标量（数字/布尔/字符串）
 *                       · 多条有效值         → list（SUM/MIN/MAX/AVERAGE/CONCAT/LEN 等可直接吃列表）
 */
export async function buildFormulaSource(
  formula: string,
  excludeFieldId: string | null,
  fields: FieldMeta[],
  merged: Record<string, FieldValue>,
  ctx: HydrationContext,
): Promise<(name: string) => FormulaValue> {
  // 预解析点引用（异步查库，避免求值函数里做 IO）→ 带类型的值
  const dotted = new Map<string, FormulaValue>();

  for (const ref of formulaFieldRefs(formula)) {
    if (!ref.includes(".") || dotted.has(ref)) continue;
    const dot = ref.indexOf(".");
    const linkName = ref.slice(0, dot);
    const subName = ref.slice(dot + 1);

    const lf = fields.find((f) => f.name === linkName && (f.type === "links" || f.type === "subtable"));
    if (!lf) {
      dotted.set(ref, FNULL);
      continue;
    }
    const links = merged[lf.id] as LinkRef[] | undefined;
    if (!links || links.length === 0) {
      dotted.set(ref, FNULL);
      continue;
    }

    const vals: FormulaValue[] = [];
    for (const l of links) {
      // 每条 link 自带 tableId（反向关联也正确）；取子记录完整 hydration 后的值，
      // 因此 {子表格.某公式字段} / {关联.lookup字段} 同样可读。
      const childFields = await loadFieldsCached(l.tableId, ctx);
      const subField = childFields.find((f) => f.name === subName);
      if (!subField) continue;
      // M4/S6：对端字段对当前主体被 mask -> 该点引用以 null 参与（与真实空值不可区分，裁决 A-4）。
      const peerVis = await visibilityOf(ctx, l.tableId);
      if (!fieldVisible(peerVis, subField.id)) continue;
      const childMerged = await getMergedCached(l.tableId, l.recordId, ctx);
      if (!childMerged) continue;
      const v = cellToFormulaValue(childMerged[subField.id] ?? null);
      if (v.t !== "null") vals.push(v);
    }
    if (vals.length === 0) dotted.set(ref, FNULL);
    else if (vals.length === 1) dotted.set(ref, vals[0]!);
    else dotted.set(ref, flist(vals));
  }

  return (name: string): FormulaValue => {
    // 点引用：取预解析的带类型结果
    if (name.includes(".")) {
      return dotted.get(name) ?? FNULL;
    }

    const f = fields.find((x) => x.name === name);
    if (!f) return FNULL;
    if (excludeFieldId && f.id === excludeFieldId) return FNULL; // 自引用 → null，避免死循环
    const v = merged[f.id];
    if (v === null || v === undefined) return FNULL;
    if (Array.isArray(v)) {
      if (v.length === 0) return FNULL;
      // LinkRef[] → title 拼接
      if (typeof v[0] === "object" && v[0] !== null && "title" in (v[0] as object)) {
        return fstr((v as LinkRef[]).map((l) => l.title).join(", "));
      }
      // 多值物理字段（多选/lookup 结果等）→ 列表
      return flist((v as unknown[]).map((x) => cellToFormulaValue(x as FieldValue)));
    }
    return cellToFormulaValue(v);
  };
}

/** 已落库的标量/数组元素 cell 值 → FormulaValue（保留类型） */
function cellToFormulaValue(v: FieldValue): FormulaValue {
  if (v === null || v === undefined || v === "") return FNULL;
  if (typeof v === "number") return fnum(v);
  if (typeof v === "boolean") return fbool(v);
  return fstr(String(v));
}

/**
 * 取另一条记录的完整 hydration 结果（第一轮 + 公式），带缓存与循环守卫。
 * 点引用 {关联.子字段} 的子字段若本身是 lookup/rollup/公式，也能取到计算后的值。
 * 循环点引用（A 的公式点引用 B，B 又点引用 A）返回 null，不无限递归。
 */
async function getMergedCached(
  tableId: string,
  recordId: string,
  ctx: HydrationContext,
): Promise<Record<string, FieldValue> | null> {
  const key = `${tableId}:${recordId}`;
  const hit = ctx.mergedCache.get(key);
  if (hit) return hit;
  if (ctx.merging.has(key)) return null;
  const raw = (await ctx.deps.getRecordsByIds([recordId]))[0];
  if (!raw || raw.tableId !== tableId) return null;
  ctx.merging.add(key);
  try {
    // M4/S6：跨表点引用取对端记录时按对端可见性收窄字段集——否则对端一个【可见公式字段】
    // 内部引用对端被 mask 字段，会经公式计算结果泄漏（A-4 最小泄漏纵深收口）。
    // 收窄后被 mask 字段在 merged 缺席，公式取值天然 FNULL，与对端真空值不可区分。
    const allFields = await loadFieldsCached(tableId, ctx);
    const peerVis = await visibilityOf(ctx, tableId);
    const fields = peerVis ? allFields.filter((f) => fieldVisible(peerVis, f.id)) : allFields;
    const merged = await buildFirstPassMerged(raw, fields, ctx);
    await computeFormulas(raw, fields, merged, ctx);
    ctx.mergedCache.set(key, merged);
    return merged;
  } finally {
    ctx.merging.delete(key);
  }
}

/**
 * 对【任意公式文本】在一条记录上求值（默认值公式与公式字段共用同一套取值/类型转换/执行）。
 * 内部跑一遍 hydrate 第一轮（物理→系统→autoNumber→links→lookup→rollup→count）作为字段取值基底，
 * 因此默认值公式也能读普通字段、子表格点字段、关联字段，结果与公式字段完全一致。
 * 不传 excludeFieldId：默认值宿主不是公式字段，不存在自引用环。
 */
export async function evaluateRecordFormula(
  tableId: string,
  recordId: string,
  formula: string,
): Promise<{ value: FormulaValue; error: string | null }> {
  const rawRow = await prismaDeps.getRecordsByIds([recordId]).then((rs) => rs[0]);
  if (!rawRow) return { value: FNULL, error: "记录不存在" };
  const fields = await prismaDeps.getFields(tableId);
  const ctx = createContext(prismaDeps, tableId, fields);
  const merged = await buildFirstPassMerged(rawRow, fields, ctx);
  // 默认值公式本身可能引用其他公式字段 → 先把基底上的公式字段也算出来
  await computeFormulas(rawRow, fields, merged, ctx);
  ctx.mergedCache.set(`${tableId}:${recordId}`, merged);
  const src = await buildFormulaSource(formula, null, fields, merged, ctx);
  return safeEvaluateFormula(formula, src);
}

// ============ Links ============

async function resolveForwardLinks(raw: RawRecord, f: FieldMeta, ctx: HydrationContext): Promise<LinkRef[]> {
  if (!f.relatedTableId) return [];
  const rows = await ctx.deps.getLinkRows({ linkFieldId: f.id, parentRowId: raw.id });
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.ord - b.ord);
  const ids = rows.map((r) => r.childRowId);
  return await buildLinkRefs(ids, f.relatedTableId, f.linkDisplayFieldId, ctx);
}

async function resolveReverseLinks(raw: RawRecord, f: FieldMeta, ctx: HydrationContext): Promise<LinkRef[]> {
  // 反向字段：数据挂在正向字段上（linkRow.linkFieldId = forwardId），本记录是 child
  const forwardId = f.reverseFieldId ?? f.linkFieldId;
  if (!forwardId || !f.relatedTableId) return [];
  const rows = await ctx.deps.getLinkRows({ linkFieldId: forwardId, childRowId: raw.id });
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.ord - b.ord);
  const ids = rows.map((r) => r.parentRowId);
  return await buildLinkRefs(ids, f.relatedTableId, f.linkDisplayFieldId, ctx);
}

async function buildLinkRefs(
  ids: string[],
  tableId: string,
  displayFieldId: string | null,
  ctx: HydrationContext,
): Promise<LinkRef[]> {
  const records = await ctx.deps.getRecordsByIds(ids);
  const fields = await loadFieldsCached(tableId, ctx);
  // M4/S6 裁决 A-4：对端表对当前主体完全不可见 -> 引用整体走不可见通道（无 id/title/tableId）。
  const vis = await visibilityOf(ctx, tableId);
  if (vis && !vis.tableVisible) return [];
  const byId = new Map(records.map((r) => [r.id, r]));

  const out: LinkRef[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const title = await primaryTitle(r, fields, displayFieldId, ctx, vis);
    // ①档：表可见但无任何可见展示值时以真实 recordId 为标题（非空、非伪造；
    // 不显示空、不出现"无权限"措辞，§0-4/§4.4 末）。
    out.push({
      tableId: r.tableId,
      recordId: r.id,
      title: title ?? r.id,
    });
  }
  return out;
}

/**
 * 记录主标题：优先 linkDisplayFieldId，其次表 physical 候选，最后第一个非计算字段。
 * M4/S6：传 vis 时只在【可见字段】中选标题；候选被 mask 或无可见非空值 -> 返回 null，
 * 由 buildLinkRefs 回退真实 recordId（①档）。不传 vis（off/shadow）保持原 "(无标题)" 兜底。
 */
export async function primaryTitle(
  r: RawRecord,
  fields: FieldMeta[],
  displayFieldId: string | null,
  ctx?: HydrationContext,
  vis?: TableVisibility | null,
): Promise<string | null> {
  const stored = parseStored(r.fields);

  const candidates: string[] = [];
  if (displayFieldId && fieldVisible(vis, displayFieldId)) candidates.push(displayFieldId);
  const physical = fields.filter((f) => !isComputedFieldType(f.type) && !isSystemFieldType(f.type));
  candidates.push(...physical.map((f) => f.id).filter((fid) => fieldVisible(vis, fid)));

  for (const fid of candidates) {
    const v = stored[fid];
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      return (v as unknown[]).map((x) => (typeof x === "object" && x && "title" in x ? (x as LinkRef).title : String(x))).join(", ");
    }
    return String(v);
  }
  // on 态掩码（vis 存在）无可见展示值 -> null（回退 recordId）；off/shadow 保持旧串。
  if (vis !== undefined) return null;
  return "(无标题)";
}

/** M4/S6 对端表可见性（结构类型，与 authz/maskSession.TableVisibility 同形，hydrate 不 import authz）。 */
interface TableVisibility {
  tableVisible: boolean;
  visibleIds: ReadonlySet<string> | null;
}

/** 取某表对当前主体可见性；无掩码钩子（off/shadow）返回 null=不裁剪。 */
async function visibilityOf(ctx: HydrationContext, tableId: string): Promise<TableVisibility | null> {
  if (!ctx.deps.resolveFieldVisibility) return null;
  return await ctx.deps.resolveFieldVisibility(tableId);
}

/** 字段在该可见性下是否可见（null 或 visibleIds=null 表示全可见）。 */
function fieldVisible(vis: TableVisibility | null | undefined, fieldId: string): boolean {
  if (!vis || vis.visibleIds === null) return true;
  return vis.visibleIds.has(fieldId);
}

function parseStored(f: unknown): Record<string, FieldValue> {
  if (!f) return {};
  if (typeof f === "string") {
    try {
      return JSON.parse(f) as Record<string, FieldValue>;
    } catch {
      return {};
    }
  }
  return f as Record<string, FieldValue>;
}

// ============ Lookup / Rollup / Count ============

/**
 * 解析「本记录经由某个 links 字段能看到的对面记录」。
 * 返回 { otherTableId, otherFieldIds, otherRecordIds }
 */
async function resolveLinkedPeerIds(
  raw: RawRecord,
  linkField: FieldMeta,
  ctx: HydrationContext,
): Promise<string[]> {
  if (linkField.type !== "links") return [];

  if (!linkField.isReverse) {
    // 正向：本记录是 parent，对面是 child
    const rows = await ctx.deps.getLinkRows({ linkFieldId: linkField.id, parentRowId: raw.id });
    rows.sort((a, b) => a.ord - b.ord);
    return rows.map((r) => r.childRowId);
  }
  // 反向：数据挂在正向字段上，本记录是 child，对面是 parent
  const forwardId = linkField.reverseFieldId ?? linkField.linkFieldId;
  if (!forwardId) return [];
  const rows = await ctx.deps.getLinkRows({ linkFieldId: forwardId, childRowId: raw.id });
  rows.sort((a, b) => a.ord - b.ord);
  return rows.map((r) => r.parentRowId);
}

async function resolveLookup(
  raw: RawRecord,
  f: FieldMeta,
  fields: FieldMeta[],
  ctx: HydrationContext,
): Promise<FieldValue> {
  if (!f.lookupFieldId) return [];

  // linkFieldId 指向本表的 links 字段（v1 同构）
  const linkField = f.linkFieldId
    ? fields.find((x) => x.id === f.linkFieldId)
    : fields.find((x) => x.type === "links");
  if (!linkField || linkField.type !== "links") return [];

  const otherIds = await resolveLinkedPeerIds(raw, linkField, ctx);
  if (otherIds.length === 0) return [];

  // M4/S6：对端表表级完全不可见 -> lookup/rollup 取空（与无关联同形，②档不泄漏对端记录数/值）。
  const peerTableId = linkField.relatedTableId;
  let peerVis: TableVisibility | null = null;
  if (peerTableId) {
    peerVis = await visibilityOf(ctx, peerTableId);
    if (peerVis && !peerVis.tableVisible) return [];
  }

  const otherRecords = await ctx.deps.getRecordsByIds(otherIds);
  const byId = new Map(otherRecords.map((r) => [r.id, r]));

  const filterNode = f.recordFilter as Parameters<typeof evalFilter>[0] | null;
  // 「匹配字段」取当前本表记录值（raw）
  const selfStored = parseStored(raw.fields);
  const values: FieldValue[] = [];
  for (const oid of otherIds) {
    const r = byId.get(oid);
    if (!r) continue;
    const stored = parseStored(r.fields);
    if (filterNode) {
      const ok = evalFilter(
        filterNode,
        (fid: string): RawValue => stored[fid] ?? null,
        (selfFid: string): RawValue => (selfStored[selfFid] ?? null) as RawValue,
      );
      if (!ok) continue;
    }
    // M4/S6：lookup 目标字段对当前主体被 mask -> 该对端值缺席（①档，与对端本就为空不可区分）。
    if (!fieldVisible(peerVis, f.lookupFieldId)) continue;
    const v = stored[f.lookupFieldId];
    if (v === undefined || v === null || v === "") continue;
    values.push(v);
  }
  return values;
}

function applyRollup(f: FieldMeta, values: FieldValue): FieldValue {
  const arr = Array.isArray(values) ? values : values === null ? [] : [values];
  if (arr.length === 0) return f.rollupFunction === "count" ? 0 : null;

  const nums = arr
    .flatMap((v) => (Array.isArray(v) ? (v as unknown[]) : [v]))
    .map((v) => (typeof v === "number" ? v : Number(String(v))))
    .filter((n) => Number.isFinite(n));

  switch (f.rollupFunction) {
    case "sum":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return nums.length === 0 ? null : Math.min(...nums);
    case "max":
      return nums.length === 0 ? null : Math.max(...nums);
    case "count":
      return arr.length;
    default:
      return null;
  }
}

async function resolveCount(
  raw: RawRecord,
  f: FieldMeta,
  fields: FieldMeta[],
  ctx: HydrationContext,
): Promise<number> {
  const linkField = f.linkFieldId ? fields.find((x) => x.id === f.linkFieldId) : fields.find((x) => x.type === "links");
  if (!linkField || linkField.type !== "links") return 0;

  const ids = await resolveLinkedPeerIds(raw, linkField, ctx);
  if (ids.length === 0) return 0;

  // M4/S6：对端表表级完全不可见 -> count 归零（②档，不借关联计数泄漏对端记录存在性）。
  if (linkField.relatedTableId) {
    const peerVis = await visibilityOf(ctx, linkField.relatedTableId);
    if (peerVis && !peerVis.tableVisible) return 0;
  }

  const filterNode = f.recordFilter as Parameters<typeof evalFilter>[0] | null;
  if (!filterNode) {
    // 无筛选时的快速路径也必须过滤已软删的对端记录，
    // 否则 count 会把软删记录计入，与 lookup/rollup（getRecordsByIds 带 deletedAt:null）结果不一致。
    const live = await ctx.deps.getRecordsByIds(ids);
    return live.length;
  }

  const selfStored = parseStored(raw.fields);
  const peerRecords = await ctx.deps.getRecordsByIds(ids);
  let n = 0;
  for (const r of peerRecords) {
    const stored = parseStored(r.fields);
    const ok = evalFilter(
      filterNode,
      (fid: string): RawValue => stored[fid] ?? null,
      (selfFid: string): RawValue => (selfStored[selfFid] ?? null) as RawValue,
    );
    if (ok) n++;
  }
  return n;
}

// ============ 工具 ============

async function loadFieldsCached(tableId: string, ctx: HydrationContext): Promise<FieldMeta[]> {
  const hit = ctx.fieldCache.get(tableId);
  if (hit) return hit;
  const fields = await ctx.deps.getFields(tableId);
  ctx.fieldCache.set(tableId, fields);
  return fields;
}

function formulaValueToCell(v: FormulaValue): FieldValue {
  switch (v.t) {
    case "num":
      return v.v;
    case "str":
      return v.v;
    case "bool":
      return v.v;
    case "list":
      // 公式直接返回列表（未套聚合）：转成标量数组交给单元格渲染
      return v.v.map(formulaValueToCell);
    case "null":
      return null;
  }
}


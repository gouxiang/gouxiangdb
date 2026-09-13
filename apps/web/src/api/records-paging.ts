// S8 列表分页/有界预览/降级判定的纯函数与前端常量。
// 全部为无副作用纯函数，便于单测覆盖能力探测、有界截断、400 分类、degraded 判定。
// React hook 层在 records-paging-hooks.ts，视图组件只消费 hook 的派生结果。
import type { FieldDTO } from "@gx/shared-types";

/**
 * 看板/月历等「需全量排布」视图的前端保守预览上限（M1）。
 * 这些视图要把记录分组/铺到日期格，不能无界拉全表（目标 50 万行会直接拖垮浏览器）；
 * 游标档按页续翻到此值即停，超过则进入「前 N 条预览」并显式提示收窄筛选。
 * 取 10000（规格 GX_GROUP_BOUND）：覆盖典型看板列数 × 每列卡片密度，同时把
 * hydration/DOM 成本压在可接受范围；有界提示保证超限时绝不谎报全量。
 */
export const GX_GROUP_BOUND = 10000;

/**
 * 有界视图续翻每页大小。服务端单页硬上限 1000，取满以减少往返。
 */
export const BOUNDED_PAGE_SIZE = 1000;

/**
 * 网格「加载更多」每页大小。刻意等于服务端列表默认页大小 200：
 * keyset 全 off（默认）时首页不带 limit，结果与旧版逐字节一致（灰度回退零行为变化）。
 */
export const GRID_PAGE_SIZE = 200;

/** 关联记录选择器候选页大小：小页 + 服务端关键字搜索，防百万行候选表拖垮选择器。 */
export const LINK_CANDIDATE_LIMIT = 50;

/** 服务端降级原因码：宽口径内存精修超阈值，分组/聚合/排序结果为受限口径。 */
export const DEGRADED_COMPUTED_IN_MEM = "computedInMem";

/** 列表页响应中与 S7 分页契约相关的最小结构（client.ts 实际类型的结构化子集）。 */
export interface PageLike {
  records: unknown[];
  total: number;
  filteredTotal: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  degraded?: string[];
}

/**
 * 能力探测（全前端唯一判定点）：服务端 keyset 灰度开启时响应【必带】hasMore 键，
 * 默认 off 时响应【根本不含】该键。用 hasOwnProperty 区分「显式 false」与「键不存在」，
 * off 态严格走旧的单页行为，一个像素不变。
 */
export function supportsKeyset(page: PageLike | undefined | null): boolean {
  return !!page && Object.prototype.hasOwnProperty.call(page, "hasMore");
}

/** 是否还有下一页可续翻（仅在 keyset 能力存在时才有意义）。 */
export function pageHasMore(page: PageLike | undefined | null): boolean {
  return !!page && page.hasMore === true && !!page.nextCursor;
}

/** 累加各页记录并按 id 去重（写后失效重拉/游标边界重叠时可能出现重复行）。 */
export function mergePages<T extends { id: string }>(pages: { records: T[] }[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of pages) {
    for (const r of p.records) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

export interface BoundedState {
  /** 截断到预览上限后的记录。 */
  records: { id: string }[];
  /** 已去重累计条数（截断前）。 */
  loadedCount: number;
  /** 是否为受限预览（达到前端上限 / 服务端仍有未取页 / 声明总量超出已取条数）。 */
  bounded: boolean;
}

/**
 * 有界预览判定（游标档与非游标档共用）：
 * - 游标档：自动续翻到 GX_GROUP_BOUND 即停（hook 的 getNextPageParam 返回 undefined），
 *   此时累计达到 bound；或 hook 未触顶但服务端仍有下一页 → bounded。
 * - 非游标档（keyset off）：只有服务端默认单页（≤200 < bound），无 nextPage、
 *   累计也到不了 bound → bounded 恒 false，严格维持现状（off 态零像素变化）。
 * declaredTotal 仅用于提示文案展示总量，不参与判定，避免 off 态平白多出一条提示。
 */
export function computeBounded(
  pages: { records: { id: string }[] }[],
  hasNextPage: boolean,
  bound: number = GX_GROUP_BOUND,
): BoundedState {
  const merged = mergePages(pages);
  const records = merged.slice(0, bound);
  const bounded = hasNextPage || merged.length >= bound;
  return { records, loadedCount: merged.length, bounded };
}

/**
 * 400 类分页错误识别：服务端对坏/过期游标、深 offset 超窗统一回 400。
 * 只认状态码，不匹配文案（文案可能调整），客户端据此丢弃游标回第一页。
 */
export function isPagingClientError(status: number): boolean {
  return status === 400;
}

// ============ degraded：计算字段/搜索受限判定 ============

/**
 * 不入 sidecar 物理索引、服务端只能内存精修的字段类型：
 * 计算字段（lookup/rollup/count/formula）、关联、附件、系统审计字段、长正文。
 * 口径对齐后端 isIndexedField（domain/fieldIndex/policy.ts）：这些类型不物化进索引列。
 */
const NON_PHYSICAL_TYPES = new Set<string>([
  "lookup",
  "rollup",
  "count",
  "formula",
  "links",
  "subtable",
  "attachment",
  "longText",
  "richText",
  "json",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
  "tabs",
]);

/** 计算/关联/容器/系统字段：即便作为主字段也不可物理下推（对齐后端 isPhysicalScalar）。 */
const NON_PHYSICAL_EVEN_PRIMARY = new Set<string>([
  "lookup",
  "rollup",
  "count",
  "formula",
  "links",
  "subtable",
  "tabs",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
]);

/**
 * 该字段能否被物理下推（进 sidecar 索引）。口径对齐后端 isIndexedField：
 * - 普通字段：短文本/数值/日期/勾选/单多选 可下推；计算/关联/附件/长正文/系统字段不可；
 * - 主字段即便物理类型是 longText 也按文本入索引（isPrimary 放行 longText/richText/json）。
 */
export function isPhysicalField(field: Pick<FieldDTO, "type"> & { isPrimary?: boolean }): boolean {
  if (NON_PHYSICAL_EVEN_PRIMARY.has(field.type)) return false;
  if (field.isPrimary) return true;
  return !NON_PHYSICAL_TYPES.has(field.type);
}

/** 响应是否带 computedInMem 降级标记。 */
export function isComputedInMem(degraded: string[] | undefined | null): boolean {
  return !!degraded && degraded.includes(DEGRADED_COMPUTED_IN_MEM);
}

/**
 * 排序/分组是否受限：仅在服务端被迫内存精修超阈值（degraded 含 computedInMem）时，
 * 针对【不可物理下推】字段的排序/分组才置灰——这些正是把查询逼进宽口径内存路径的操作。
 * 普通物理字段（数字/日期/单选/短文本等）的排序分组仍可下推，不禁用。
 * 无 degraded 时一律返回 false（默认 off 态行为零变化）。
 */
export function isSortGroupRestricted(
  degraded: string[] | undefined | null,
  field: Pick<FieldDTO, "type"> & { isPrimary?: boolean },
): boolean {
  return isComputedInMem(degraded) && !isPhysicalField(field);
}

/**
 * 聚合是否受限：T3 宽口径下聚合在【内存精修后的受限集合】上计算，超阈值即不可信。
 * 与排序不同，聚合行是整表口径，无法按字段类型区分，只要 degraded 即标记。
 */
export function isAggregationRestricted(degraded: string[] | undefined | null): boolean {
  return isComputedInMem(degraded);
}

/**
 * 视图关键字搜索是否受限：服务端搜索（跨字段 contains）只能内存精修，
 * degraded 时搜索结果为受限口径。
 */
export function isSearchRestricted(degraded: string[] | undefined | null): boolean {
  return isComputedInMem(degraded);
}

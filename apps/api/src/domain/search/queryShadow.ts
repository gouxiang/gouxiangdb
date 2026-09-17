// M5/S7 shadow 对拍：新统一检索 vs 旧 /api/search 在可比集上的命中实体集合/顺序差异。
//
// 权威依据：M5-implementation-plan.md §6（shadow 纪律）。
//   - 仅在「两模式都用 FTS/LIKE（不引入向量差异）」时比对：新链路 mode=hybrid/vector 整路跳过
//     （向量是新增能力，用 S11 独立小样评测而非与旧 includes 对拍）；
//   - 旧检索是有界预览（ADR-0005，每表前 2000 条内存子串）+ 成员/知识库成员鉴权，新链路是
//     全量派生库召回 + M4 nav scope，两者在边界数据上本就可能不同，故 shadow 只观测、记脱敏
//     日志/metric，绝不改变响应；GX_M5_SHADOW_STRICT=on 时 drift 非 0 才让请求失败（对拍闸门）。
//
// 纯 compareSearchShadow 可表单测；registry 供进程内计数/最近样本与 HTTP 路由观测。

import { createHash } from "node:crypto";
import type { EffectiveMode } from "./queryTypes.js";
import type { UnifiedSearchItem } from "./queryTypes.js";
import type { LegacySearchResult } from "./legacySearch.js";

export type ShadowDriftKind = "SHADOW_OVERDENY" | "SHADOW_OVERALLOW" | "SHADOW_ORDER";

export interface EntityKey {
  type: "record" | "doc" | "canvas";
  id: string;
}

export interface ShadowReport {
  /** 是否在可比集上（keyword 两模式）；false 时不计数、不严格失败。 */
  comparable: boolean;
  /** 不可比原因（向量路/空等）。 */
  reason?: "vector_route" | "empty_query";
  oldCount: number;
  newCount: number;
  /** 旧有新无（新链路更严/漏召回）。 */
  overDeny: EntityKey[];
  /** 新有旧无（新链路更宽，或全量召回越过旧有界预览窗）。 */
  overAllow: EntityKey[];
  /** 共有实体在两序列中的相对顺序不一致。 */
  orderDiffer: boolean;
  /**
   * 集合漂移总数（= overDeny + overAllow）——**strict 闸门的唯一判据**。
   * 硬门只对"漏召回/多召回"这类真正的错误失败；ORDER 是 RRF/boost 的设计内排序改进，不计入失败。
   */
  get setDriftCount(): number;
  /**
   * 可观测总漂移（= setDriftCount + (orderDiffer ? 1 : 0)）——仅用于日志/registry 观测，别当失败判据。
   */
  get driftCount(): number;
}

function key(type: EntityKey["type"], id: string): string {
  return `${type}:${id}`;
}

function legacyKeys(result: LegacySearchResult): EntityKey[] {
  if (!("records" in result)) return [];
  const recs = (result.records ?? []).map((r): EntityKey => ({ type: "record", id: r.recordId }));
  const docs = (result.docs ?? []).map((d): EntityKey => ({ type: d.type, id: d.docId }));
  // 旧响应顺序：records 数组在前、docs 在后（对齐旧 JSON 物理顺序）。
  return [...recs, ...docs];
}

function itemKeys(items: readonly UnifiedSearchItem[]): EntityKey[] {
  return items.map((i) => ({ type: i.type, id: i.entityId }));
}

/**
 * 纯对拍：
 * @param newMode 新链路实际执行 mode；hybrid/vector -> 不可比（向量新增能力）。
 * @param hadQuery 本次是否非空 q；空 q 两者都空，记一次可比的零漂移（或直接跳过计数）。
 */
export function compareSearchShadow(
  newMode: EffectiveMode,
  items: readonly UnifiedSearchItem[],
  legacy: LegacySearchResult,
  hadQuery: boolean,
): ShadowReport {
  const base = {
    comparable: false,
    oldCount: 0,
    newCount: 0,
    overDeny: [] as EntityKey[],
    overAllow: [] as EntityKey[],
    orderDiffer: false,
  };
  if (!hadQuery) {
    return { ...base, reason: "empty_query", get setDriftCount() { return 0; }, get driftCount() { return 0; } };
  }
  if (newMode === "hybrid" || newMode === "vector") {
    return { ...base, reason: "vector_route", get setDriftCount() { return 0; }, get driftCount() { return 0; } };
  }

  const oldKeys = legacyKeys(legacy);
  const newKeys = itemKeys(items);
  const oldSet = new Set(oldKeys.map((k) => key(k.type, k.id)));
  const newSet = new Set(newKeys.map((k) => key(k.type, k.id)));

  const overDeny = oldKeys.filter((k) => !newSet.has(key(k.type, k.id)));
  const overAllow = newKeys.filter((k) => !oldSet.has(key(k.type, k.id)));

  // 顺序：只比较两序列【共有】实体的相对先后（任一独有实体不参与顺序判定）。
  const oldCommon = oldKeys.filter((k) => newSet.has(key(k.type, k.id))).map((k) => key(k.type, k.id));
  const newCommon = newKeys.filter((k) => oldSet.has(key(k.type, k.id))).map((k) => key(k.type, k.id));
  const orderDiffer = oldCommon.join("|") !== newCommon.join("|");

  const report: ShadowReport = {
    comparable: true,
    oldCount: oldKeys.length,
    newCount: newKeys.length,
    overDeny,
    overAllow,
    orderDiffer,
    // strict 唯一判据：集合漂移（漏召回/多召回）。
    get setDriftCount() {
      return this.overDeny.length + this.overAllow.length;
    },
    // 可观测总量（日志/registry）：集合漂移 + ORDER 设计内重排。
    get driftCount() {
      return this.setDriftCount + (this.orderDiffer ? 1 : 0);
    },
  };
  return report;
}

export interface ShadowSnapshot {
  compared: number;
  skipped: number;
  drift: number;
  overDeny: number;
  overAllow: number;
  order: number;
  recent: Array<{ ts: string; userHash: string; kinds: ShadowDriftKind[]; detail: string }>;
}

/** 进程内计数 + 最近样本环形缓冲（不落盘、不含响应体/q 明文）。 */
class SearchShadowRegistry {
  private counts = { compared: 0, skipped: 0, drift: 0, overDeny: 0, overAllow: 0, order: 0 };
  private ring: ShadowSnapshot["recent"] = [];
  private cap = 200;

  noteSkipped(): void {
    this.counts.skipped += 1;
  }

  record(report: ShadowReport, userId: string, now: Date = new Date()): void {
    if (!report.comparable) {
      this.counts.skipped += 1;
      return;
    }
    this.counts.compared += 1;
    // 观测口径用【总漂移】（含 ORDER）：ORDER-only 漂移也照常计数并 warn，只是不再让 strict 失败。
    if (report.driftCount === 0) return;
    const kinds: ShadowDriftKind[] = [];
    if (report.overDeny.length) { kinds.push("SHADOW_OVERDENY"); this.counts.overDeny += report.overDeny.length; }
    if (report.overAllow.length) { kinds.push("SHADOW_OVERALLOW"); this.counts.overAllow += report.overAllow.length; }
    if (report.orderDiffer) { kinds.push("SHADOW_ORDER"); this.counts.order += 1; }
    this.counts.drift += 1;
    const detail = `old=${report.oldCount} new=${report.newCount} ` +
      `overDeny=${report.overDeny.length} overAllow=${report.overAllow.length} order=${report.orderDiffer}`;
    this.ring.push({ ts: now.toISOString(), userHash: hashUser(userId), kinds, detail });
    if (this.ring.length > this.cap) this.ring.shift();
    // 脱敏结构化日志：仅用户 id 哈希 + 计数，不打 q/标题/实体业务值。
    console.warn(`[m5-search-shadow] drift ${kinds.join(",")} user=${hashUser(userId)} ${detail}`);
  }

  snapshot(): ShadowSnapshot {
    return { ...this.counts, recent: this.ring.slice() };
  }

  reset(): void {
    this.counts = { compared: 0, skipped: 0, drift: 0, overDeny: 0, overAllow: 0, order: 0 };
    this.ring = [];
  }
}

export function hashUser(userId: string): string {
  return createHash("sha256").update(`m5search:${userId}`).digest("hex").slice(0, 12);
}

export const searchShadowRegistry = new SearchShadowRegistry();

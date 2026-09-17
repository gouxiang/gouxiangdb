// M5 搜索数据适配层（纯函数，无 IO）：把 v1 统一检索响应与旧 /api/search 响应归一为
// 单一 UI 模型，组件只消费归一结果、不感知 flag/回退分支；并把 mode/degraded 实现细节
// 翻译成用户可读的中性文案（绝不出现向量/embedding/.so/端点等实现词）。
import type {
  GlobalDocHit,
  GlobalRecordHit,
} from "../../api/client";
import type {
  V1EffectiveMode,
  V1SearchDegradedReason,
  V1SearchItem,
  V1SearchResponse,
} from "@gx/shared-types";

/** UI 统一的命中类型（与旧对话框分组一致：record / doc / canvas）。 */
export type UnifiedHitType = "record" | "doc" | "canvas";

/** 归一后的单条命中（record 与 doc/canvas 的定位上下文都为可选字段）。 */
export interface UnifiedHit {
  key: string;
  type: UnifiedHitType;
  /** 跳转所需实体 id：record=记录 id；doc/canvas=文档 id。 */
  entityId: string;
  title: string;
  snippet: string;
  matchedField: string | null;
  // record 定位
  baseId?: string;
  baseName?: string;
  tableId?: string;
  tableName?: string;
  // doc/canvas 定位
  kbId?: string;
  kbName?: string;
  docId?: string;
}

/** 交给 SearchDialog 的单一 UI 模型。 */
export interface UnifiedSearchResult {
  hits: UnifiedHit[];
  /** 本次结果是否来自新统一检索（false=旧 /api/search 兜底形态）。 */
  fromV1: boolean;
  /** 状态条文案（无内容时为 null，组件不渲染）。 */
  notice: string | null;
}

/** 命中 → 路由路径（沿用 SearchDialog 既有跳转，不新造路由）。 */
export function hitHref(hit: UnifiedHit): string {
  if (hit.type === "record") {
    return `/base/${hit.baseId}/table/${hit.tableId}?record=${hit.entityId}`;
  }
  return `/kb/${hit.kbId}/${hit.type}/${hit.docId}`;
}

function normalizeV1Item(item: V1SearchItem): UnifiedHit {
  const isRecord = item.type === "record";
  return {
    key: `${item.type}-${item.entityId}`,
    type: item.type,
    entityId: item.entityId,
    title: item.title,
    snippet: item.snippet,
    matchedField: item.matchedField,
    ...(isRecord
      ? {
          baseId: item.baseId,
          baseName: item.baseName,
          tableId: item.tableId,
          tableName: item.tableName,
        }
      : {
          kbId: item.kbId,
          kbName: item.kbName,
          docId: item.docId ?? item.entityId,
        }),
  };
}

function legacyRecord(r: GlobalRecordHit): UnifiedHit {
  return {
    key: `record-${r.recordId}`,
    type: "record",
    entityId: r.recordId,
    title: r.title,
    snippet: r.snippet,
    matchedField: r.matchedField,
    baseId: r.baseId,
    baseName: r.baseName,
    tableId: r.tableId,
    tableName: r.tableName,
  };
}

function legacyDoc(d: GlobalDocHit): UnifiedHit {
  return {
    key: `${d.type}-${d.docId}`,
    type: d.type === "canvas" ? "canvas" : "doc",
    entityId: d.docId,
    title: d.title,
    snippet: d.snippet,
    matchedField: null,
    kbId: d.kbId,
    kbName: d.kbName,
    docId: d.docId,
  };
}

/** 旧 /api/search 形状 → 归一模型（无状态条，等同旧体验）。 */
export function normalizeLegacy(records: GlobalRecordHit[], docs: GlobalDocHit[]): UnifiedSearchResult {
  return {
    hits: [...docs.map(legacyDoc), ...records.map(legacyRecord)],
    fromV1: false,
    notice: null,
  };
}

/**
 * mode/degraded → 中性状态文案。
 * 不向用户暴露向量/嵌入/扩展等实现：只描述「结果范围/匹配方式」层面的可理解事实。
 */
export function v1Notice(mode: V1EffectiveMode, degraded: readonly V1SearchDegradedReason[], scopeTruncated: boolean): string | null {
  const parts: string[] = [];
  if (scopeTruncated) parts.push("结果范围较大，已按可访问内容截断，可能不完整");
  if (degraded.length > 0) {
    // 任一降级都意味着语义匹配不可用，统一以「关键词匹配」中性表达，不区分内部原因码。
    parts.push("当前按关键词匹配给出结果");
  } else if (mode === "like" || mode === "fts") {
    // 纯关键词路（无降级标记时也不打扰），仅在与截断同时才有必要提示，故这里不加文案。
  }
  return parts.length > 0 ? parts.join("；") : null;
}

/** v1 形状 → 归一模型。 */
export function normalizeV1(res: V1SearchResponse): UnifiedSearchResult {
  return {
    hits: res.items.map(normalizeV1Item),
    fromV1: true,
    notice: v1Notice(res.mode, res.degraded, res.scopeTruncated),
  };
}

/** 判断错误是否为「v1 未挂载」（flag off 时 v1 自身 404），据此回退旧链。 */
export function isV1NotFound(status: number, code?: unknown): boolean {
  if (status !== 404) return false;
  // 后端 v1 未挂载返 {code:"NOT_FOUND"}；也兼容无 code 的 404（整个 /api/v1 未挂时的兜底 404）。
  return code === undefined || code === "NOT_FOUND";
}

// apps/api/src/routes/searchBounds.ts
// M1/S11 全局/库内搜索的「有界预览」口径（ADR-0005）。
//
// 现状搜索是把每张表【最多】SEARCH_PREVIEW_LIMIT 条活记录拉进内存做 JS 子串匹配，
// 不是全量召回：单表活记录超过该上限时，更老的记录不会出现在结果里。
// M1 刻意不扩成全表扫、也不在主库建 FTS 虚表（见 ADR-0005）；统一全文检索
// （独立可重建检索派生库 + trigram/短词 LIKE 回退）在 M5 落地后替换本口径。
// 两个搜索端点（/api/records/search、/api/search 的记录支路）共用此上限与响应标记，
// 避免一处改了另一处漂移。

/** 每张表纳入内存子串匹配的活记录上限（按 createdAt 升序取最近之前的前 N 条）。 */
export const SEARCH_PREVIEW_LIMIT = 2000;

/** 挂在搜索响应上的有界预览标记（additive，前端可据此提示"结果为预览"）。 */
interface BoundedPreviewMarker {
  /** 恒定 true：M1 搜索始终是有界预览而非全量检索。 */
  boundedPreview: true;
  /** 每表扫描的活记录上限；超过该上限的记录不在召回范围。 */
  previewLimit: number;
}

export function boundedPreviewMarker(): BoundedPreviewMarker {
  return { boundedPreview: true, previewLimit: SEARCH_PREVIEW_LIMIT };
}

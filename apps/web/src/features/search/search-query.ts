// M5 统一检索取数器（无 React、无 IO 依赖，便于单测注入）：
// v1 优先；v1 自身 404（flag off 端点未挂载）回退旧 /api/search；其它错误透传。
// 带图片（以图搜图）时走 POST /api/v1/search（GET 装不下 dataURL）。
import { ApiError, SearchApi, SearchV1Api } from "../../api/client";
import { isV1NotFound, normalizeLegacy, normalizeV1, type UnifiedSearchResult } from "./search-adapter";

export interface SearchFetchers {
  searchV1: typeof SearchV1Api.search;
  searchByImage: typeof SearchV1Api.searchByImage;
  searchLegacy: typeof SearchApi.global;
}

const DEFAULT_FETCHERS: SearchFetchers = {
  searchV1: SearchV1Api.search,
  searchByImage: SearchV1Api.searchByImage,
  searchLegacy: SearchApi.global,
};

/**
 * 取一次统一检索并归一。
 * @param images 以图搜图图片（data:image/...）；非空即走 POST 多模态。
 * @param fetchers 仅测试注入；生产用默认真实 API。
 */
export async function fetchUnifiedSearch(
  q: string,
  images: readonly string[] = [],
  fetchers: SearchFetchers = DEFAULT_FETCHERS,
): Promise<UnifiedSearchResult> {
  // 以图搜图：POST。v1 off（404）无法回退旧链（旧链只收文本），直接透传错误。
  if (images.length > 0) {
    const v1 = await fetchers.searchByImage({ q, type: "all", mode: "auto", limit: 20, images: [...images] });
    return normalizeV1(v1);
  }
  try {
    const v1 = await fetchers.searchV1({ q, type: "all", mode: "auto", limit: 20 });
    return normalizeV1(v1);
  } catch (e) {
    if (e instanceof ApiError && isV1NotFound(e.status, readCode(e))) {
      const legacy = await fetchers.searchLegacy(q);
      return normalizeLegacy(legacy.records, legacy.docs);
    }
    throw e;
  }
}

/** 取错误信封 code（后端顶层 {code}；兼容经 details 透传的形态）。 */
function readCode(e: ApiError): unknown {
  const body = e.body as { code?: unknown; details?: { code?: unknown } };
  return body?.code ?? body?.details?.code;
}

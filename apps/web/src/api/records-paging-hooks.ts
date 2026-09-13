// S8 列表数据 hooks：keyset 游标无限翻页、有界全量预览、关联候选限量搜索。
// 纯判定逻辑全部在 ./records-paging，本文件只负责 React Query 编排与 400 回首页。
//
// 回退保证：服务端默认 GX_M1_KEYSET=off 时首页响应不含 hasMore，supportsKeyset 为 false，
// getNextPageParam 恒返回 undefined —— 网格退化为「只有首页（默认 200）」的单页查询，
// 与旧版 useRecords 行为一致；有界视图则只渲染默认单页且不出现任何预览提示。
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { FieldDTO, GroupBucketDTO, RecordDTO } from "@gx/shared-types";
import { Records, ApiError } from "./client";
import { QK } from "./hooks";
import { toast } from "../components/ui";
import {
  BOUNDED_PAGE_SIZE,
  GRID_PAGE_SIZE,
  GX_GROUP_BOUND,
  LINK_CANDIDATE_LIMIT,
  computeBounded,
  isPagingClientError,
  mergePages,
  pageHasMore,
  supportsKeyset,
} from "./records-paging";

/** 一页列表响应（与 client.ts 同源，避免重复声明漂移）。 */
type RecordsPage = Awaited<ReturnType<typeof Records.list>>;

/** 游标/深翻 400 的前端标记错误：触发「丢弃游标回第一页」，不参与重试。 */
class CursorExpiredError extends Error {
  constructor() {
    super("cursor expired or offset out of window");
    this.name = "CursorExpiredError";
  }
}

/** 把分页 400 转成 CursorExpiredError；其余错误原样抛出。 */
function mapPagingError(e: unknown): unknown {
  if (e instanceof ApiError && isPagingClientError(e.status)) return new CursorExpiredError();
  return e;
}

/**
 * 游标失效统一处理：重置该查询（回第一页）并提示一次。
 * handledRef 保证 React StrictMode 双调用 effect 时只 toast 一次。
 */
function useResetOnCursorExpired(expired: boolean, queryKey: readonly unknown[]): void {
  const qc = useQueryClient();
  const handledRef = useRef(false);
  useEffect(() => {
    if (expired && !handledRef.current) {
      handledRef.current = true;
      // resetQueries 会清空分页缓存并自动重拉活跃查询（首页无 cursor，不会再 400）。
      void qc.resetQueries({ queryKey, exact: true });
      toast("分页位置已失效，已回到最新的第一页", "info");
    }
    if (!expired) handledRef.current = false;
  }, [expired, queryKey, qc]);
}

function pageListParams(tableId: string, viewId: string | undefined, cursor: string | null, pageLimit: number) {
  return {
    tableId,
    viewId,
    // 首页不传 limit/cursor：与旧版默认页（服务端默认 200）逐字节一致。
    ...(cursor ? { cursor, limit: pageLimit } : {}),
  };
}

export interface RecordsInfiniteResult {
  records: RecordDTO[];
  keysetEnabled: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
  total: number;
  filteredTotal: number;
  fields: FieldDTO[];
  allFields: FieldDTO[];
  groups: GroupBucketDTO[] | null;
  aggregations: Record<string, number | null> | null;
  degraded: string[];
  isLoading: boolean;
}

/** 网格主数据：首页 + 「加载更多」游标续翻；off 态退化为单页。 */
export function useRecordsInfinite(params: { tableId: string; viewId?: string }): RecordsInfiniteResult {
  const { tableId, viewId } = params;
  const queryKey = [...QK.records(tableId, viewId), "infinite"] as const;

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async (ctx) => {
      try {
        return await Records.list(pageListParams(tableId, viewId, ctx.pageParam, GRID_PAGE_SIZE));
      } catch (e) {
        throw mapPagingError(e);
      }
    },
    getNextPageParam: (lastPage) =>
      supportsKeyset(lastPage) && pageHasMore(lastPage) ? lastPage.nextCursor : undefined,
    // CursorExpiredError 立即交给重置 effect，不重试；其它错误沿用默认重试。
    retry: (failureCount, error) => (error instanceof CursorExpiredError ? false : failureCount < 3),
  });

  useResetOnCursorExpired(query.error instanceof CursorExpiredError, queryKey);

  const pages: RecordsPage[] = useMemo(() => query.data?.pages ?? [], [query.data?.pages]);
  const first = pages[0];
  const records = useMemo(() => mergePages(pages.map((p) => ({ records: p.records }))), [pages]);

  return {
    records,
    keysetEnabled: supportsKeyset(first),
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    total: first?.total ?? records.length,
    filteredTotal: first?.filteredTotal ?? records.length,
    fields: first?.fields ?? [],
    allFields: first?.allFields ?? [],
    groups: first?.groups ?? null,
    aggregations: first?.aggregations ?? null,
    degraded: first?.degraded ?? [],
    isLoading: query.isLoading,
  };
}

export interface RecordsBoundedResult {
  records: RecordDTO[];
  fields: FieldDTO[];
  /** 是否为受限预览（游标档触顶 GROUP_BOUND 或仍有未取页）。off 态恒 false。 */
  bounded: boolean;
  declaredTotal: number;
  bound: number;
  isLoading: boolean;
  degraded: string[];
}

/**
 * 看板/月历等排布型视图：游标档自动逐页续翻到 GX_GROUP_BOUND 即停；
 * off 态只有默认单页且 bounded=false，维持现状不崩也不谎报全量。
 */
export function useRecordsBounded(params: { tableId: string; viewId?: string }): RecordsBoundedResult {
  const { tableId, viewId } = params;
  const queryKey = [...QK.records(tableId, viewId), "bounded"] as const;

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async (ctx) => {
      try {
        return await Records.list(pageListParams(tableId, viewId, ctx.pageParam, BOUNDED_PAGE_SIZE));
      } catch (e) {
        throw mapPagingError(e);
      }
    },
    getNextPageParam: (lastPage, allPages) => {
      if (!supportsKeyset(lastPage)) return undefined;
      const loaded = allPages.reduce((s, p) => s + p.records.length, 0);
      if (loaded >= GX_GROUP_BOUND) return undefined;
      return pageHasMore(lastPage) ? lastPage.nextCursor : undefined;
    },
    retry: (failureCount, error) => (error instanceof CursorExpiredError ? false : failureCount < 3),
  });

  useResetOnCursorExpired(query.error instanceof CursorExpiredError, queryKey);

  const pages: RecordsPage[] = useMemo(() => query.data?.pages ?? [], [query.data?.pages]);
  const first = pages[0];
  const keysetEnabled = supportsKeyset(first);

  // 游标档：自动续翻直到取满上限或无更多页（有界，绝不无界拉全表）。
  useEffect(() => {
    if (!keysetEnabled) return;
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysetEnabled, query.hasNextPage, query.isFetchingNextPage]);

  const state = useMemo(
    () => computeBounded(pages.map((p) => ({ records: p.records })), query.hasNextPage, GX_GROUP_BOUND),
    [pages, query.hasNextPage],
  );

  return {
    records: state.records as RecordDTO[],
    fields: first?.fields ?? [],
    bounded: state.bounded,
    declaredTotal: first?.filteredTotal ?? state.loadedCount,
    bound: GX_GROUP_BOUND,
    // 自动续翻未停时也视为 loading，避免视图在只拿到首页时就按全量定格。
    isLoading: query.isLoading || (keysetEnabled && query.isFetchingNextPage && state.loadedCount < GX_GROUP_BOUND),
    degraded: first?.degraded ?? [],
  };
}

/** 输入防抖：关联选择器「输入即查」，避免每键一次请求。 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export interface LinkCandidatesResult {
  records: RecordDTO[];
  fields: FieldDTO[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  /** 已满页：候选可能未列全，提示输入关键字缩小范围（两种后端形态都适用）。 */
  needNarrow: boolean;
}

/**
 * 关联记录选择器候选：小页（LINK_CANDIDATE_LIMIT）+ 服务端关键字搜索 + 游标续翻。
 * 绝不一次拉全表；off 态只有首个小页，靠搜索定位目标记录。
 */
export function useLinkCandidates(params: { tableId: string | null; search: string }): LinkCandidatesResult {
  const { tableId } = params;
  const search = useDebouncedValue(params.search, 250);
  const queryKey = ["linkCandidates", tableId ?? "", search.trim()] as const;

  const query = useInfiniteQuery({
    queryKey,
    enabled: !!tableId,
    initialPageParam: null as string | null,
    queryFn: async (ctx) =>
      await Records.list({
        tableId: tableId!,
        limit: LINK_CANDIDATE_LIMIT,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(ctx.pageParam ? { cursor: ctx.pageParam } : {}),
      }),
    getNextPageParam: (lastPage) =>
      supportsKeyset(lastPage) && pageHasMore(lastPage) ? lastPage.nextCursor : undefined,
  });

  const pages: RecordsPage[] = useMemo(() => query.data?.pages ?? [], [query.data?.pages]);
  const first = pages[0];
  const records = useMemo(() => mergePages(pages.map((p) => ({ records: p.records }))), [pages]);
  const fullPage = records.length >= LINK_CANDIDATE_LIMIT;

  return {
    records,
    fields: first?.fields ?? [],
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    // 游标档以 hasMore 为准；off 态满页即可能不全，提示缩小范围。
    needNarrow: supportsKeyset(first) ? query.hasNextPage : fullPage,
  };
}

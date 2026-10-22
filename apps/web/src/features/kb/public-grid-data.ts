// apps/web/src/features/kb/public-grid-data.ts
// 公开数据表网格的独立取数层（与文档嵌入表预览解耦：不绑宿主文档、纯只读、无任何写入）。
//
// 两种匿名访问方式（后端同构返回 PublicTableShareDTO）：
//   - 直连表 token：GET /s/:tableToken          （structure + 首屏记录）
//                  GET /s/:tableToken/records   （翻页）
//   - 库分享作用域：GET /s/:baseToken/t/:tableId        （structure + 首屏记录）
//                  GET /s/:baseToken/t/:tableId/records（翻页）
//
// 只读：本模块不暴露任何写方法；权限恒按 viewer 渲染（后端也只开放只读）。

import { useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";
import {
  PublicApi,
  type PublicTableShareDTO,
  type PublicRecordsShareDTO,
} from "../../api/client";
import { shareTableColumns, pagerModel, type SharePagerModel } from "./public-share-model";

/** 公开网格访问方式：直连表 token 或库分享作用域内的表。 */
export type PublicGridAccess =
  | { kind: "token"; tableToken: string }
  | { kind: "base"; baseToken: string; tableId: string };

const PAGE_SIZE = 50;

export interface PublicGridData {
  title: string;
  baseName: string;
  viewName: string | null;
  columns: FieldDTO[];
  records: RecordDTO[];
  canEdit: boolean;
  degraded: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  pager: SharePagerModel;
  pageSize: number;
  offset: number;
  prevPage: () => void;
  nextPage: () => void;
  /** 正在加载翻页记录（首屏用 isLoading） */
  paging: boolean;
}

function useStruct(access: PublicGridAccess): UseQueryResult<PublicTableShareDTO> {
  return useQuery({
    queryKey: ["kb", "public", "table-struct", access.kind === "token" ? access.tableToken : `${access.baseToken}/${access.tableId}`],
    queryFn: () =>
      access.kind === "token"
        ? // 直连表 token：根分发端点按 kind:"table" 返回同构的 PublicTableShareDTO
          (PublicApi.getPublicShareAny(access.tableToken) as Promise<PublicTableShareDTO>)
        : PublicApi.getPublicBaseTable(access.baseToken, access.tableId, {
            limit: PAGE_SIZE,
            offset: 0,
          }),
    retry: false,
  });
}

function usePage(
  access: PublicGridAccess,
  offset: number,
  enabled: boolean,
): UseQueryResult<PublicRecordsShareDTO> {
  return useQuery({
    queryKey: [
      "kb",
      "public",
      "table-page",
      access.kind === "token" ? access.tableToken : `${access.baseToken}/${access.tableId}`,
      offset,
    ],
    queryFn: () => {
      const page = { limit: PAGE_SIZE, offset };
      return access.kind === "token"
        ? PublicApi.getPublicTableRecords(access.tableToken, page)
        : PublicApi.getPublicBaseTableRecords(access.baseToken, access.tableId, page);
    },
    enabled,
    retry: false,
  });
}

export function usePublicGridData(access: PublicGridAccess): PublicGridData {
  const [offset, setOffset] = useState(0);
  const struct = useStruct(access);
  // offset=0 直接用首屏结构响应里的记录，避免重复请求；翻到后续页才单独拉记录。
  const pageQ = usePage(access, offset, !struct.isError && offset > 0);

  const d = struct.data;
  const columns = useMemo(() => (d ? shareTableColumns(d) : []), [d]);

  // 首屏（offset=0）记录来自结构响应；后续页来自翻页响应。
  const records: RecordDTO[] = useMemo(() => {
    if (!d) return [];
    if (offset === 0) return (d.records ?? []) as RecordDTO[];
    return ((pageQ.data?.records ?? []) as RecordDTO[]);
  }, [d, offset, pageQ.data]);

  const pager = pagerModel(
    offset,
    PAGE_SIZE,
    offset === 0 ? d?.filteredTotal : pageQ.data?.filteredTotal,
    offset === 0 ? d?.total : pageQ.data?.total,
  );

  return {
    title: d?.table?.name ?? "",
    baseName: d?.table?.baseName ?? "",
    viewName: d?.view?.name ?? null,
    columns,
    records,
    // 库/表公开分享对外都是只读；即使后端异常回了 canEdit=true，外部网格也不提供任何编辑入口。
    canEdit: false,
    degraded: !!d?.degraded,
    isLoading: struct.isLoading,
    isError: struct.isError || (offset > 0 && pageQ.isError),
    error: struct.error ?? pageQ.error,
    pager,
    pageSize: PAGE_SIZE,
    offset,
    paging: offset > 0 && pageQ.isFetching,
    prevPage: () => setOffset((o) => Math.max(0, o - PAGE_SIZE)),
    nextPage: () => setOffset((o) => o + PAGE_SIZE),
  };
}

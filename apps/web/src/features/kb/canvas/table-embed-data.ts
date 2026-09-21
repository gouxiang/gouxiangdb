// apps/web/src/features/kb/canvas/table-embed-data.ts
// 嵌入数据表预览的取数层：登录态与分享态两条通道，归一成同一份视图模型。
//
//   - 登录态：GET /api/records?tableId=&viewId=&limit=&offset=（已按当前用户库权限过滤）
//   - 分享态：GET /api/public/s/:token/embed/:tableId?viewId=（宿主文档/画布的档位决定读写）
//
// 契约真源 packages/shared-types/src/share.ts 的 EmbeddedTablePayload。
// 两条通道的响应形状一致（records/total/filteredTotal/fields/visibleFields），
// 差异只在登录态 records 接口不返回 canEdit（写权限由调用方按画布/编辑器状态裁决）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicApi, Records } from "../../../api/client";
import type { CellValue, FieldDTO, RecordDTO } from "@gx/shared-types";

/** 嵌入预览单页条数：卡片尺寸有限，不做无限滚动。 */
export const EMBED_PAGE_LIMIT = 50;

export interface EmbedTableData {
  /** 表名（分享态由后端给；登录态缺失时回落 undefined） */
  title?: string;
  /** 视图名（未指定视图时为 null） */
  viewName: string | null;
  /** 视图可见字段（渲染列） */
  fields: FieldDTO[];
  /** 全量字段（编辑器需要，如关联筛选的匹配字段） */
  allFields: FieldDTO[];
  records: RecordDTO[];
  total: number;
  filteredTotal: number;
  /** 后端裁决的写权限；登录态无此信息 → null（由调用方裁决） */
  serverCanEdit: boolean | null;
  /** 分享链接申请了 edit 但被降级为只读 */
  degraded: boolean;
  isLoading: boolean;
  isError: boolean;
}

const EMPTY: EmbedTableData = {
  viewName: null,
  fields: [],
  allFields: [],
  records: [],
  total: 0,
  filteredTotal: 0,
  serverCanEdit: null,
  degraded: false,
  isLoading: false,
  isError: false,
};

export interface UseEmbedTableOpts {
  tableId: string;
  viewId?: string | null;
  /** 有值 = 分享态（匿名通道）；无值 = 登录态 */
  publicToken?: string;
}

export function useEmbedTable(opts: UseEmbedTableOpts): EmbedTableData {
  const { tableId, viewId, publicToken } = opts;
  const isPublic = !!publicToken;

  const share = useQuery({
    queryKey: ["kb", "public", publicToken, "embed", tableId, viewId ?? ""],
    queryFn: () => PublicApi.getEmbed(publicToken!, tableId, { viewId: viewId ?? null, limit: EMBED_PAGE_LIMIT }),
    enabled: isPublic && !!tableId,
    retry: false,
  });

  const internal = useQuery({
    queryKey: ["kb", "embed", tableId, viewId ?? ""],
    queryFn: () =>
      Records.list({ tableId, viewId: viewId ?? undefined, limit: EMBED_PAGE_LIMIT, offset: 0 }),
    enabled: !isPublic && !!tableId,
    retry: false,
  });

  if (isPublic) {
    const d = share.data;
    if (!d) return { ...EMPTY, isLoading: share.isLoading, isError: share.isError };
    const visible = (d.visibleFields ?? d.fields ?? []) as FieldDTO[];
    return {
      title: d.table?.name,
      viewName: d.view?.name ?? null,
      fields: visible,
      allFields: (d.fields ?? visible) as FieldDTO[],
      records: (d.records ?? []) as RecordDTO[],
      total: d.total ?? 0,
      filteredTotal: d.filteredTotal ?? 0,
      serverCanEdit: d.canEdit,
      degraded: !!d.degraded,
      isLoading: false,
      isError: false,
    };
  }

  const d = internal.data;
  if (!d) return { ...EMPTY, isLoading: internal.isLoading, isError: internal.isError };
  return {
    viewName: null,
    fields: (d.fields ?? []) as FieldDTO[],
    allFields: (d.allFields ?? d.fields ?? []) as FieldDTO[],
    records: (d.records ?? []) as RecordDTO[],
    total: d.total ?? 0,
    filteredTotal: d.filteredTotal ?? 0,
    // 登录态 records 接口不返回 canEdit：交给调用方（画布/编辑器的可编辑态）裁决。
    serverCanEdit: null,
    degraded: false,
    isLoading: false,
    isError: false,
  };
}

/** 写入通道：登录态走 /api/records，分享态走 /api/public/s/:token/embed/:tableId/records。 */
export interface EmbedWriteApi {
  create: (fields: Record<string, unknown>) => Promise<unknown>;
  update: (recordId: string, fields: Record<string, unknown>) => Promise<unknown>;
  remove: (recordId: string) => Promise<unknown>;
}

export function useEmbedWrites(opts: UseEmbedTableOpts): EmbedWriteApi {
  const { tableId, viewId, publicToken } = opts;
  const isPublic = !!publicToken;
  const qc = useQueryClient();
  const invalidate = () =>
    isPublic
      ? qc.invalidateQueries({ queryKey: ["kb", "public", publicToken, "embed", tableId] })
      : qc.invalidateQueries({ queryKey: ["kb", "embed", tableId] });

  // 说明：这里刻意用三个独立 mutation 而非一个泛型工厂——每个动作的失效范围一致，
  // 但入参形状不同，拆开后调用点无需再判分支。
  const create = useMutation({
    mutationFn: async (fields: Record<string, unknown>) =>
      isPublic
        ? PublicApi.createEmbedRecord(publicToken!, tableId, fields)
        : Records.create(tableId, { fields }),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: async (args: { recordId: string; fields: Record<string, unknown> }) =>
      isPublic
        ? PublicApi.updateEmbedRecord(publicToken!, tableId, args.recordId, args.fields)
        : Records.update(args.recordId, { fields: args.fields }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (recordId: string) =>
      isPublic ? PublicApi.deleteEmbedRecord(publicToken!, tableId, recordId) : Records.remove(recordId),
    onSuccess: invalidate,
  });

  void viewId;
  return {
    create: (fields) => create.mutateAsync(fields),
    update: (recordId, fields) => update.mutateAsync({ recordId, fields }),
    remove: (recordId) => remove.mutateAsync(recordId),
  };
}

/** 单元格空值判定以外的轻量取值：CellRenderer 自己会 format，这里只透传原始值。 */
export function cellValueOf(record: RecordDTO, fieldId: string): CellValue {
  return (record.fields?.[fieldId] ?? null) as CellValue;
}

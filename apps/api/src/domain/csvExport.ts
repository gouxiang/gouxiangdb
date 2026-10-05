// apps/api/src/domain/csvExport.ts
// M1/S5 CSV 导出分批编排：走 S2 只读 raw 网关 keyset 拉取 + 批量化 hydrate，
// 避免旧 queryRecords(noPaging) 把全表 RawRecord + 全表 HydratedRecord 一次性压进堆。
//
// 逐值一致性（只改取数编排，不改导出值）：
//   - keyset 排序固定 (createdAt ASC,id ASC)，与旧 queryRecords 的 orderBy 完全相同；
//   - 无视图后处理（无 filters/sorts/search）：每批 hydrate 后立即转成转义文本再释放对象，
//     驻留堆里的只有最终 CSV 文本（返回本就需要），不再同时持有全表 hydrated 记录；
//   - 有视图后处理：只累积【筛选/排序所需】的 hydrated 记录（无筛选时即全表，但这是视图显式
//     要求排序/搜索的少数路径），末了复用与列表同一 applyViewQuery，筛选/排序/搜索口径零漂移；
//   - RC-04 公式注入防护仍在 escapeCell（csv.ts）拼串层，本文件不触碰。

import { getRawReader, type RawReader, type RawRecordRow } from "../db/rawRead.js";
import { hydrateRecords, type HydrateDeps } from "./hydrate.js";
import { prismaDeps } from "./prismaDeps.js";
import { loadTableFields, parseViewConfig, applyViewQuery } from "./recordService.js";
import { recordToRow, rowsToCSVBody, csvHeaderLine } from "./csv.js";
import type { RawRecord, FieldMeta } from "./types.js";
import type { ViewConfig } from "@gx/shared-types";

/** 每批 keyset 拉取 + hydrate 的行数（500-1000 区间取 500，单批 hydrated 驻留受控）。 */
const EXPORT_BATCH = 500;

/**
 * M4/S6 导出掩码上下文（中性结构，csvExport 不 import authz；off/shadow 调用方不传）：
 *   visibleFields：仅这些列入 CSV 表头与数据列；
 *   sanitizeConfig：抹掉隐藏字段的 filter/sort（导出条件不能借隐藏列偷偷过滤）；
 *   hydrateDeps：携带跨表字段可见性钩子的 hydration 依赖（LinkRef 两档/公式 mask-null）。
 */
interface CsvMaskContext {
  visibleFields: FieldMeta[];
  sanitizeConfig: (config: ViewConfig) => ViewConfig;
  hydrateDeps: HydrateDeps;
}

/** raw 网关 epoch-ms 行 → domain RawRecord（ISO 时间串，与 toRawRecord 同形）。 */
function rawRowToRecord(r: RawRecordRow): RawRecord {
  return {
    id: r.id,
    tableId: r.tableId,
    fields: r.fields,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
  };
}

/** 该视图导出是否需要在全部 hydrate 后做内存筛选/搜索/排序（决定能否逐批落文本）。 */
function needsPostProcessing(config: ViewConfig, search: string): boolean {
  return Boolean(
    (config.filters !== null && config.filters !== undefined) ||
      (config.sorts && config.sorts.length > 0) ||
      search.trim() !== "",
  );
}

interface CsvExportResult {
  csv: string;
  /** 实际导出的数据行数（筛选后口径），便于调用方/测试核对。 */
  rowCount: number;
  /** 分批批数（每批 ≤ EXPORT_BATCH 行），作为分批证据。 */
  batches: number;
}

/**
 * 分批导出整表为 CSV。
 * @param viewConfigRaw 视图 config JSON 串（可空）；与旧端点同口径解析。
 * @param search 端点级搜索覆盖（一般省略，用 config.search）。
 */
export async function exportTableCsv(
  tableId: string,
  viewConfigRaw?: string | null,
  searchOverride?: string,
  reader?: RawReader,
  mask?: CsvMaskContext | null,
  currentUserId?: string | null,
): Promise<CsvExportResult> {
  const allFields = await loadTableFields(tableId);
  // M4/S6：on 态仅导出可见列（表头/数据/hydrate 入参同源）；off/shadow 全字段。
  const fields = mask ? mask.visibleFields : allFields;
  const parsedConfig = parseViewConfig(viewConfigRaw ?? null);
  const config = mask ? mask.sanitizeConfig(parsedConfig) : parsedConfig;
  const hydrateDeps = mask?.hydrateDeps ?? prismaDeps;
  const search = (searchOverride ?? config.search ?? "").trim();
  const post = needsPostProcessing(config, search);

  const r = reader ?? getRawReader();
  const header = csvHeaderLine(fields);

  let batches = 0;
  let rowCount = 0;

  if (!post) {
    // 直通路径：逐批 hydrate → 转义文本 → 释放；仅累积文本块，不全量驻留 hydrated 对象。
    const bodyChunks: string[] = [];
    let cursor = null as Parameters<typeof r.keysetPage>[0]["cursor"];
    for (;;) {
      const page = r.keysetPage({ tableId, cursor, limit: EXPORT_BATCH, order: "asc" });
      if (page.rows.length === 0) break;
      batches += 1;
      const rawRows = page.rows.map(rawRowToRecord);
      const hydrated = await hydrateRecords(rawRows, fields, hydrateDeps);
      rowCount += hydrated.length;
      bodyChunks.push(rowsToCSVBody(hydrated.map((x) => recordToRow(x, fields))));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const csv = [header, ...bodyChunks.filter((s) => s !== "")].join("\r\n");
    return { csv, rowCount, batches };
  }

  // 后处理路径：累积 hydrate 结果（视图显式要求筛选/排序/搜索），末了统一套用与列表相同的后处理。
  const accumulated: Awaited<ReturnType<typeof hydrateRecords>> = [];
  let cursor = null as Parameters<typeof r.keysetPage>[0]["cursor"];
  for (;;) {
    const page = r.keysetPage({ tableId, cursor, limit: EXPORT_BATCH, order: "asc" });
    if (page.rows.length === 0) break;
    batches += 1;
    const rawRows = page.rows.map(rawRowToRecord);
    accumulated.push(...(await hydrateRecords(rawRows, fields, hydrateDeps)));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const finalRows = applyViewQuery(accumulated, fields, config, search, currentUserId ?? null);
  rowCount = finalRows.length;
  const body = rowsToCSVBody(finalRows.map((x) => recordToRow(x, fields)));
  const csv = body === "" ? header : [header, body].join("\r\n");
  return { csv, rowCount, batches };
}

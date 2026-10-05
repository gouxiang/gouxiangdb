// apps/api/src/domain/queryPlan/uniqueSidecar.ts
// M1/S6 assertUnique 走 sidecar 等值通道（写【事务内】调用，强一致：sidecar 由 syncRecordsTx
// 在同一事务维护，未提交的变更对本事务可见、对其它事务不可见，与全表校验看到的候选一致）。
//
// 语义必须与 records.ts assertUnique 的严格相等 stored[f.id] === v 完全一致。
// S6 只对【恒被索引且规范恒为字符串】的类型开 sidecar：
//  - singleLineText/email/url/phone/singleSelect/date/datetime → valueText 严格相等（日期存 ISO 串）；
//  - 数值五型、checkbox、autoNumber、多选、正文(非主)、计算/关联 → 不在此列（类型不可由派生列
//    精确区分 / 多行 / 未索引 / 非物理值），sidecarUniqueMatch 返回 null，调用方回退全表严格校验。
// 候选 = 同 tableId + 同 fieldId + 同值 + 记录未删（join records）+ 异 recordId（exclude）。
// 任何前置不满足（读 flag off / 写侧停 / tx 无 raw 能力 / 不支持类型 / 值为空）→ 调用方回退。

import type { FieldMeta } from "../types.js";

interface UniqueTx {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<Array<{ id: unknown }>>;
}

// 存储【规范恒为字符串】且 sidecar 单行 valueText 可严格匹配的物理标量类型。
// 刻意【不含】数值五型与 checkbox：写入侧不强制类型归一，库存可能存数字 123 或字符串 "123"，
// 二者 sidecar 行都是 (valueText "123", valueNum 123)，派生列无法区分原始 JSON 类型；
// 而 assertUnique 是严格 ===（数字 123 不应与字符串 "123" 冲突）。为零假阳性，S6 这些类型
// 一律回退全表严格校验（性能优化留给 ADR-0008/类型归一后再开）。
// longText/richText/json 默认不入 sidecar（除非主字段），交给 isIndexedField 语义由调用方保证；
// 这里给文本列匹配能力，是否真有索引行由查询结果决定（无行即无冲突，安全）。
const TEXT_EQ_TYPES = new Set([
  "singleLineText", "email", "url", "phone", "singleSelect", "date", "datetime",
]);

interface UniqueMatch {
  column: "valueText" | "valueNum";
  value: string | number;
}

/** 该 unique 字段 + 值能否走 sidecar 等值；返回匹配列与绑定值，不能则 null（调用方回退全表）。 */
export function sidecarUniqueMatch(f: FieldMeta, v: unknown): UniqueMatch | null {
  if (v === undefined || v === null || v === "") return null;
  // 仅字符串标量可严格文本匹配（这些类型规范写入恒为 string）。非字符串输入回退全表，
  // 由严格 === 判定（跨类型本就不冲突，绝不能用 String(v) 凑匹配造成假阳性）。
  if (TEXT_EQ_TYPES.has(f.type) && typeof v === "string") {
    return { column: "valueText", value: v };
  }
  return null;
}

function supportsRawTx(tx: unknown): tx is UniqueTx {
  return typeof tx === "object" && tx !== null &&
    typeof (tx as UniqueTx).$queryRawUnsafe === "function";
}

/**
 * 事务内查冲突记录 id（命中第一条即够 assertUnique 抛错）。
 * @returns 冲突 recordId；无冲突返回 null；前置不满足/不支持返回 undefined（调用方回退全表）。
 */
export async function findUniqueConflictTx(args: {
  tx: unknown;
  tableId: string;
  field: FieldMeta;
  value: unknown;
  exclude: ReadonlySet<string>;
  readEnabled: boolean;
  writeEnabled: boolean;
}): Promise<string | null | undefined> {
  const { tx, tableId, field, value, exclude, readEnabled, writeEnabled } = args;
  if (!readEnabled || !writeEnabled) return undefined;
  if (!supportsRawTx(tx)) return undefined; // 内存 fake prisma（路由 mock 单测）→ 回退
  const match = sidecarUniqueMatch(field, value);
  if (!match) return undefined;

  const excludeSql = exclude.size > 0
    ? ` AND r."id" NOT IN (${[...exclude].map(() => "?").join(",")})`
    : "";
  const sql =
    `SELECT r."id" AS id FROM record_field_index x ` +
    `JOIN records r ON r."id"=x."recordId" ` +
    `WHERE x."tableId"=? AND x."fieldId"=? AND x."isNull"=0 AND x."${match.column}"=? ` +
    `AND r."tableId"=? AND r."deletedAt" IS NULL${excludeSql} LIMIT 1`;
  const params: (string | number)[] = [tableId, field.id, match.value, tableId, ...exclude];
  const rows = await tx.$queryRawUnsafe(sql, ...params);
  const first = rows[0]?.id;
  return typeof first === "string" ? first : null;
}

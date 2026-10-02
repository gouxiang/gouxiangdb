// apps/api/src/domain/recordChanges/query.ts
// 记录变更历史的**读侧**：keyset 分页取数 + 字段权限两层掩码 + 出参可读化 + DTO 组装。
//
// 与写侧（store.ts）刻意分开：读端点绝不能走 withWriteTx/runWrite（写队列并发度恒 1，
// 会把读堵死），本模块全程只用 prisma 只读查询。
//
// 两条出口纪律：
//   1. **绝不吐 optionId / userId**：落库值是选项 id（fieldIndex/policy.ts 口径）与 userId，
//      直接吐给前端就是既有的「泄漏 optionId」缺陷。出参前统一换成选项名 / 成员名。
//   2. **被掩码的字段整条剔除，不是置空**：置空仍会泄漏「该字段被改过」这个事实。
//      一条记录的所有变更字段都被掩码时，该条目整体消失（delete/restore 本就恒空，豁免）。

import { prisma } from "../../db.js";
import { decodeCursor, encodeCursor, InvalidCursorError, type KeysetToken } from "../queryPlan/cursor.js";
import { indexSelectOptions, displaySelectValue } from "../../mcp/tools/selectFields.js";
import type { FieldMeta } from "../types.js";
import type { FieldChange, RecordChangeDTO, RecordChangeOp, RecordChangesPage } from "./types.js";
import { RECORD_CHANGE_OPS } from "./types.js";

export const RECORD_CHANGES_DEFAULT_LIMIT = 50;
export const RECORD_CHANGES_MAX_LIMIT = 200;

/** 读一次变更历史页。cursor 为 null 表示取首页。 */
export interface QueryRecordChangesInput {
  recordId: string;
  /** 该表字段定义全集（可读化用：选项名 / 成员名索引）。 */
  fields: readonly FieldMeta[];
  /**
   * 当前身份**不可见**的字段 id 集（fieldScopeOf.hiddenIds ∪ 掩码外字段）。
   * 空集 = 不做剔除，逐字节等价于没加本模块前的行为。
   */
  hiddenIds: ReadonlySet<string>;
  limit: number;
  cursor: KeysetToken | null;
}

/** 解析 limit：非法/缺失回落默认 50，上限 200（同 layoutVersions 的分页纪律）。 */
export function parseChangesLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RECORD_CHANGES_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), RECORD_CHANGES_MAX_LIMIT);
}

/** 解析游标：空 = 首页；非空但非法 = null 指针由调用方转 400（不猜、不回退全表）。 */
export function parseChangesCursor(raw: string | undefined): KeysetToken | null {
  if (raw === undefined || raw === "") return null;
  const tok = decodeCursor(raw);
  if (!tok) throw new InvalidCursorError();
  return tok;
}

/** 单条变更里的值换成人读形态（选项名 / 成员名；未命中一律原值透传，绝不臆造）。 */
function readableValue(
  value: unknown,
  fieldId: string,
  fieldType: string | undefined,
  selectIndex: ReturnType<typeof indexSelectOptions>,
  memberNames: ReadonlyMap<string, string>,
): unknown {
  if (value === null || value === undefined) return value;
  const byKey = selectIndex?.get(fieldId);
  if (byKey) return displaySelectValue(value, byKey);
  if (fieldType === "member") {
    if (Array.isArray(value)) return value.map((v) => memberNames.get(String(v)) ?? v);
    return memberNames.get(String(value)) ?? value;
  }
  return value;
}

/** 收集所有变更值里出现的 userId（成员字段可读化用，一次性批量查，避免 N+1）。 */
function collectMemberIds(
  changes: readonly FieldChange[],
  memberFieldIds: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  for (const c of changes) {
    if (!memberFieldIds.has(c.fieldId)) continue;
    for (const v of [c.before, c.after]) {
      if (typeof v === "string" && v !== "") ids.add(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x !== "") ids.add(x);
    }
  }
  return [...ids];
}

export async function queryRecordChanges(input: QueryRecordChangesInput): Promise<RecordChangesPage> {
  const { recordId, fields, hiddenIds, limit, cursor } = input;

  // 多取一条判 hasMore（不额外 COUNT：变更历史只做倒序翻页，COUNT 是白花的 IO）。
  const rows = await prisma.recordChange.findMany({
    where: {
      recordId,
      ...(cursor
        ? {
            OR: [
              { changedAt: { lt: new Date(cursor.c) } },
              { changedAt: new Date(cursor.c), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, op: true, actorId: true, actorName: true, changedAt: true, changes: true },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // 可读化索引（一次建好，逐条复用）：选择类字段 id → 候选 key → 选项名。
  const selectIndex = indexSelectOptions(fields);
  const typeById = new Map<string, string>();
  const memberFieldIds = new Set<string>();
  for (const f of fields) {
    typeById.set(f.id, f.type);
    if (f.type === "member") memberFieldIds.add(f.id);
  }

  // 先解析 JSON + 剔除被掩码字段，再统一批量查成员名（只对存活下来的条目查，省掉无用 IO）。
  const parsed = page.map((row) => {
    const raw = parseChanges(row.changes);
    const kept = hiddenIds.size > 0 ? raw.filter((c) => !hiddenIds.has(c.fieldId)) : raw;
    return { row, kept };
  });

  const memberIds = collectMemberIds(parsed.flatMap((p) => p.kept), memberFieldIds);
  const memberNames = new Map<string, string>();
  if (memberIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, displayName: true },
    });
    for (const u of users) memberNames.set(u.id, u.displayName);
  }

  const items: RecordChangeDTO[] = [];
  for (const { row, kept } of parsed) {
    const op = normalizeOp(row.op);
    // 过滤后为空 → 整条不返回（理由见文件头纪律 2）。delete/restore 的 changes 本就恒空，豁免。
    if (kept.length === 0 && op !== "delete" && op !== "restore") continue;
    items.push({
      id: row.id,
      op,
      actorId: row.actorId ?? null,
      actorName: row.actorName ?? null,
      changedAt: row.changedAt.toISOString(),
      changes: kept.map((c) => ({
        fieldId: c.fieldId,
        fieldName: c.fieldName,
        before: readableValue(c.before, c.fieldId, typeById.get(c.fieldId), selectIndex, memberNames),
        after: readableValue(c.after, c.fieldId, typeById.get(c.fieldId), selectIndex, memberNames),
      })),
    });
  }

  const last = page.length > 0 ? page[page.length - 1]! : null;
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ c: last.changedAt.getTime(), id: last.id }) : null,
    hasMore,
  };
}

/** 解析落库的 changes JSON 串：坏数据降级成空数组（不抛错、不让整条日志消失）。 */
function parseChanges(raw: string): FieldChange[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FieldChange[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const fieldId = typeof o.fieldId === "string" ? o.fieldId : "";
    if (fieldId === "") continue;
    out.push({
      fieldId,
      fieldName: typeof o.fieldName === "string" ? o.fieldName : fieldId,
      before: o.before ?? null,
      after: o.after ?? null,
    });
  }
  return out;
}

/** 落库 op 是字符串；未知值按 update 处理（不丢条目）。 */
function normalizeOp(raw: string): RecordChangeOp {
  return (RECORD_CHANGE_OPS as readonly string[]).includes(raw) ? (raw as RecordChangeOp) : "update";
}

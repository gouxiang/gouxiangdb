// apps/api/src/domain/viewUserPrefsStore.ts
// 视图「用户个性化」偏好存储串解析与加载（#561）。
//
// 纪律与 domain/viewAdminConfig.ts 对齐但语义不同：
//   · prefs 行承载的是该用户【自己的使用态】，不含安全强制语义。
//   · JSON.parse 失败或顶层非对象仍 fail-closed 上抛 —— 坏存储串说明数据已损坏，
//     静默回落到默认会把用户的自定义悄悄丢弃（沉默逻辑错误），故交由全局错误处理转 500。
//   · "形状纠偏"宽松：只挑取已知键，用 defaultViewUserPrefs 补齐缺失键；
//     数组键非数组回落 []，filters 非对象回落 null，aggregations 非对象回落 {}，
//     search 非字符串回落 ""，rowHeight 非三档回落 "medium"，
//     groupByFieldId 非字符串回落 null。

import {
  defaultViewUserPrefs,
  type ViewUserPrefs,
} from "@gx/shared-types";
import type { AggFunc, RowHeight } from "@gx/shared-types";
import type { DbTx } from "../db.js";

/** 最小结构化 client：prisma 与事务 client（DbTx）均满足。 */
export type ViewUserPrefClient = Pick<DbTx, "viewUserPref">;

const ARRAY_KEYS = ["sorts", "collapsedGroupKeys"] as const;

const ROW_HEIGHTS: readonly RowHeight[] = ["short", "medium", "tall"];

const AGG_FUNCS: ReadonlySet<string> = new Set<AggFunc>([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "countEmpty",
  "countFilled",
  "percentEmpty",
  "percentFilled",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 纠偏 aggregations：值必须是合法 AggFunc 或 null；其余形状一律回落 null，
 * 避免坏枚举流入视图渲染。
 */
function normalizeAggregations(value: unknown): ViewUserPrefs["aggregations"] {
  if (!isPlainObject(value)) return {};
  const out: ViewUserPrefs["aggregations"] = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = raw === null || (typeof raw === "string" && AGG_FUNCS.has(raw))
      ? (raw as AggFunc | null)
      : null;
  }
  return out;
}

/**
 * 解析 view_user_prefs.prefs 存储串。
 * @throws 当 raw 的 JSON.parse 失败或顶层不是对象时抛错（fail-closed，见文件头）。
 */
export function parseViewUserPrefs(raw: string): ViewUserPrefs {
  // 坏 JSON / 非对象：刻意不 catch —— 见文件头 fail-closed 说明。
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("view user prefs must be a JSON object");
  }

  const picked: Partial<ViewUserPrefs> = { version: 1 };
  // sorts 元素为 SortSpec 对象、collapsedGroupKeys 元素为字符串：存储层只守"是数组"，
  // 元素形状由渲染侧消费时的结构决定（规格：数组键非数组回落 []）。
  for (const key of ARRAY_KEYS) {
    if (key in parsed) picked[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
  }
  if ("filters" in parsed) {
    picked.filters = isPlainObject(parsed.filters)
      ? (parsed.filters as unknown as ViewUserPrefs["filters"])
      : null;
  }
  if ("search" in parsed) {
    picked.search = typeof parsed.search === "string" ? parsed.search : "";
  }
  if ("rowHeight" in parsed) {
    picked.rowHeight =
      typeof parsed.rowHeight === "string" && ROW_HEIGHTS.includes(parsed.rowHeight as RowHeight)
        ? (parsed.rowHeight as RowHeight)
        : "medium";
  }
  if ("groupByFieldId" in parsed) {
    picked.groupByFieldId =
      typeof parsed.groupByFieldId === "string" ? parsed.groupByFieldId : null;
  }
  if ("aggregations" in parsed) {
    picked.aggregations = normalizeAggregations(parsed.aggregations);
  }

  return defaultViewUserPrefs(picked);
}

/**
 * 加载某用户在某视图上的个性化偏好。
 * @returns 无 prefs 行（未自定义）时返回 null，调用方应让该用户跟随视图默认。
 */
export async function loadUserPrefs(
  client: ViewUserPrefClient,
  viewId: string,
  userId: string,
): Promise<ViewUserPrefs | null> {
  const row = await client.viewUserPref.findUnique({
    where: { viewId_userId: { viewId, userId } },
    select: { prefs: true },
  });
  return row ? parseViewUserPrefs(row.prefs) : null;
}

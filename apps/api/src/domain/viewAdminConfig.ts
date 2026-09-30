// apps/api/src/domain/viewAdminConfig.ts
// 视图「管理员配置层」存储串解析（#560）。
//
// 纪律：与 domain/authz/repository.ts 的 parseRowConditionsForPolicy 相同 ——
// 管理员层承载【强制隐藏字段 / 强制筛选】这类安全语义，坏数据绝不能被静默当成
// "无管理员配置"放宽掉（否则一次写坏就会把管理员强制隐藏/筛选全部解除）。
// 因此 JSON.parse 失败或解析结果非对象时，让异常自然向上抛（fail-closed），由全局
// 错误处理转 500，而不是回落 null。调用方不得吞此异常。
//
// 与 fail-closed 相对，"形状纠偏"是宽松的：只挑取已知键，数组键非数组回落 []，
// filters 非对象回落 null，coverFieldId 非字符串回落 null，再用
// defaultViewAdminConfig 兜底补齐缺失键。

import {
  defaultViewAdminConfig,
  type ViewAdminConfig,
  type FilterNode,
} from "@gx/shared-types";

const STRING_ARRAY_KEYS = [
  "fieldOrder",
  "hiddenFieldIds",
  "cardFieldIds",
  "detailFieldIds",
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 views.adminConfig 存储串。
 * @returns null 表示无管理员配置（raw 为 null / 空白）；否则返回形状完整的 ViewAdminConfig。
 * @throws 当 raw 非空但 JSON.parse 失败或顶层不是对象时抛错（fail-closed）。
 */
export function parseViewAdminConfig(raw: string | null): ViewAdminConfig | null {
  if (raw === null || raw.trim() === "") return null;

  // 坏 JSON / 非对象：刻意不 catch —— 见文件头 fail-closed 说明。
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("view admin config must be a JSON object");
  }

  const picked: Partial<ViewAdminConfig> = { version: 1 };
  for (const key of STRING_ARRAY_KEYS) {
    if (key in parsed) picked[key] = isStringArray(parsed[key]) ? parsed[key] : [];
  }
  if ("filters" in parsed) {
    picked.filters = isPlainObject(parsed.filters)
      ? (parsed.filters as unknown as FilterNode)
      : null;
  }
  if ("coverFieldId" in parsed) {
    picked.coverFieldId =
      typeof parsed.coverFieldId === "string" ? parsed.coverFieldId : null;
  }

  // 兜底补齐任何遗漏键，保证返回对象形状完整。
  return defaultViewAdminConfig(picked);
}

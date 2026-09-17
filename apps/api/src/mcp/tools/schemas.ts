// M6/S2 工具 JSON Schema 唯一真源（**全仓唯一允许 import zod4 的文件**，见计划 §4.2 zod4 隔离纪律）。
//
// zod4 来源：@modelcontextprotocol/sdk@1.30.0 的 peer `zod ^3.25 || ^4.0` 由仓内 zod 3.25.76 满足，
// 其 `zod/v4` 子路径即 zod4 实现（SDK 自身 15 处 `from 'zod/v4'`）。业务层继续用 zod3（`from "zod"`），
// 两者不得混用；S2 起由 `__tests__/zod4-isolation.test.ts` 与 CI grep 守卫「zod/v4 未扩散出本文件」。
//
// 上限常量（§3-8 配额契约）亦单点定义，供工具与 openapi 对拍复用。

import { z } from "zod/v4";

/** 配额常量（§3-8）：读 limit ≤200、写批量 op ≤100、批文本 ≤100KB、文档/画布 10MB。 */
export const MCP_LIMITS = {
  READ_LIMIT_MAX: 200,
  WRITE_OPS_MAX: 100,
  WRITE_TEXT_MAX_BYTES: 100 * 1024,
  DOC_CANVAS_MAX_BYTES: 10 * 1024 * 1024,
} as const;

/** 连接性自检工具 ping_echo 入参。 */
export const pingEchoShape = {
  text: z.string().max(200).describe("回显文本（≤200 字符）"),
};

/** table.list_bases：无入参。 */
export const listBasesShape = {};

/** 读工具共用的 limit（§3-8 配额：≤200；超限由 SDK 入参校验直接返 -32602）。 */
const LIMIT_MAX = MCP_LIMITS.READ_LIMIT_MAX;

/** 受控 filter 算子白名单（§4.5：禁任意 SQL/公式；非法算子由 zod4 enum 拦为 -32602）。 */
export const FILTER_OPS = [
  "is", "isNot", "contains", "notContains", "isEmpty", "isNotEmpty",
  "gte", "lte", "gt", "lt", "isAnyOf", "checked", "notChecked",
] as const;

const filterNode = z.object({
  fieldId: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

export const getSchemaShape = {
  baseId: z.string().min(1).describe("基础库 id（须在该令牌可见集内）"),
};

export const listRecordsShape = {
  tableId: z.string().min(1),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
  search: z.string().max(200).optional(),
};

export const queryRecordsShape = {
  tableId: z.string().min(1),
  filter: z.array(filterNode).max(20).optional(),
  sortFieldId: z.string().min(1).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
};

export const recordSearchShape = {
  q: z.string().min(1).max(200),
  // 与 M5 实际 RequestedMode 对齐（计划写 "like" 已过期；M5 为 auto|fts|vector）
  mode: z.enum(["auto", "fts", "vector"]).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
};

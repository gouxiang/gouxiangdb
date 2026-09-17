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

/** S2 冒烟工具 ping_echo 入参（S3 起换为按权限动态注册的真实工具族）。 */
export const pingEchoShape = {
  text: z.string().max(200).describe("回显文本（≤200 字符）"),
};

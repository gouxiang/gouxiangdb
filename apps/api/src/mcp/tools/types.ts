// M6/S3 工具层共享类型（不入协议层 zod4，只描述 handler 契约）。

import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { McpAction, McpPermissionPort, McpSubject, ResourceFamily } from "../permissions/types.js";
import type { PatScope } from "../pat/tokens.js";

/** handler 运行上下文：主体 + 已绑定 scope 缓存的权限端口（可能为 null=未接入引擎的骨架态）。 */
export interface ToolCtx {
  subject: McpSubject;
  port: McpPermissionPort | null;
}

export interface ToolResult {
  // SDK 的 CallToolResult 形参带字符串索引签名，故此处保留（结构兼容协议返回）。
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 工具元数据（闸门一/二与 openapi 对拍的真源）。 */
export interface ToolMeta extends Record<string, unknown> {
  name: string;
  title: string;
  description: string;
  /**
   * 历史字段：这件工具属于哪个 PAT scope（P3 起**不参与判定**，仅作目录可读性与老数据兼容）。
   * 工具是否入册由运行期可用性门 + 族可见集（按签发者用户）决定。
   */
  scopes: PatScope[];
  /** 资源族；null=不涉资源（连通性工具），不做闸门一。 */
  family: ResourceFamily | null;
  /** 该工具需要的 M4 动作集（闸门一口径；缺省 ["r"]）。 */
  actions?: McpAction[];
  readOnly: boolean;
  /**
   * 可选可用性门（如 record.search 仅在总门目标态非 off 时注册——db 覆盖优先于 env）。
   * 允许异步（判定要读 app_settings）；缺省恒可用。
   */
  available?: () => boolean | Promise<boolean>;
  /**
   * 可选注册期显式门（family=null 的实例级工具，如 base.create_base / kb.create_kb）。
   * 接收本请求的权限端口；返回 false 则不入册。族门（family）与本门互斥：family 非空走族可见集，
   * family 为 null 且 gate 存在时走 gate。
   */
  gate?: (port: ToolCtx["port"]) => boolean | Promise<boolean>;
}

export interface ToolSpec {
  meta: ToolMeta;
  /** zod4 raw shape（唯一真源在 ./schemas.ts）；空对象=无入参。 */
  inputShape: ZodRawShapeCompat;
  run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<ToolResult>;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** 结构化拒绝（isError:true + 机器码；§6 错误码词汇）。 */
export function deny(code: "FORBIDDEN_RESOURCE" | "FORBIDDEN_FIELD" | "FORBIDDEN_GROUP" | "INVALID_PARAMS", message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ code, message }) }], isError: true };
}

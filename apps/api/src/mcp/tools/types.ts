// M6/S3 工具层共享类型（不入协议层 zod4，只描述 handler 契约）。

import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { McpPermissionPort, McpSubject, ResourceFamily } from "../permissions/types.js";
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
  /** 需要的 PAT scope（任一命中即可见；空数组=连接性工具，恒注册）。 */
  scopes: PatScope[];
  /** 资源族；null=不涉资源（连通性工具），不做闸门一。 */
  family: ResourceFamily | null;
  readOnly: boolean;
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

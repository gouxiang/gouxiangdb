// M6/S3 双闸门消费接口（M6 定义、M4 实现/适配；见 M6-implementation-plan §4.4）。
//
// 闸门一（注册期）：listAccessibleResources —— 族可见集非空才注册该族工具；
//   集为 budget 截断时 truncated=true，调用方须把 enum 参数**退化为自由字符串**（执行期再判）。
// 闸门二（执行期）：can —— service/handler 首行的单资源动作判定（M4 engine/scope 薄封装）。
// 字段面：fieldCapability —— schema 收窄 + 出参投影（AC-M6-2）。
//
// 与计划 §4.4 的差异（有意细化，便于 enum 收窄与截断提示）：
//   - listAccessibleResources 返回 { byKind, truncated } 而非 string[]（原签名无法表达截断与类型分流）；
//   - fieldCapability 返回纯数据快照（Set -> string[]），避免把 M4 内部结构泄漏进协议层。

import type { PatScope } from "../pat/tokens.js";

export interface McpSubject {
  userId: string;
  patId: string;
  scopes: PatScope[];
}

/** nav resourceType 的可见子集（与 M3 nav_nodes.kind 同域）。 */
export type McpResourceKind = "base" | "kb" | "table" | "view" | "doc" | "canvas" | "group";
export type McpAction = "r" | "c" | "u" | "d";
export type ResourceFamily = "table" | "doc" | "canvas";

export interface McpResource { kind: McpResourceKind; id: string }

export interface AccessibleResources {
  /** 各资源类型下的可见资源 id（resourceId），确定性排序。 */
  byKind: Partial<Record<McpResourceKind, string[]>>;
  /** 是否因预算截断（截断时 enum 必须退化为自由字符串）。 */
  truncated: boolean;
}

export interface McpFieldCapability {
  visible: boolean;
  visibleAll: boolean;
  /** 仅当所有读来源都裁剪时为白名单并集；存在宽来源时为 null（全可见）。 */
  visibleFields: string[] | null;
  writableAll: boolean;
}

export interface McpPermissionPort {
  /** 闸门一：本主体在该族的可见资源集（族为空 -> 不注册该族工具）。 */
  listAccessibleResources(family: ResourceFamily): Promise<AccessibleResources>;
  /** 闸门二：单资源动作判定。资源不存在或不可见都返回 false（不泄漏存在性）。 */
  can(action: McpAction, resource: McpResource): Promise<boolean>;
  /** 字段能力（schema 收窄 + 出参投影）；nodeId 非可见节点 -> visible:false。 */
  fieldCapability(tableNodeId: string): Promise<McpFieldCapability>;
}

/** 族 -> 该族工具可作用的资源类型（list_bases 取 base、get_schema 取 table…）。 */
export const FAMILY_KINDS: Readonly<Record<ResourceFamily, readonly McpResourceKind[]>> = {
  table: ["base", "table"],
  doc: ["kb", "doc"],
  canvas: ["canvas"],
};

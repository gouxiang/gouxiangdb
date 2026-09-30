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
  /**
   * 令牌自带的 scopes（P3 起**仅作老数据兼容**）：保留在库与协议里，不参与任何授权判定。
   * 能力一律按 userId（签发者）经本文件的端口实时计算。
   */
  scopes: PatScope[];
}

/** nav resourceType 的可见子集（与 M3 nav_nodes.kind 同域）。 */
export type McpResourceKind = "base" | "kb" | "table" | "view" | "doc" | "canvas" | "group";
/**
 * MCP 侧动作词汇。前四枚是数据读写（对应 shared-types 的 r/c/u/d）；后两枚是搭建类动作——
 * 与 shared-types `ResourceAction` 的 manage_schema/manage_table 同域，直接透传给 M4 判定：
 *   - manage_schema：建表（base 节点）、字段增删改（table 节点）、结构设计；
 *   - manage_table：表改名/删表等表级元数据管理（经 table → base 祖先链命中）。
 */
export type McpAction =
  | "r" | "c" | "u" | "d"
  | "manage_schema" | "manage_table";
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

/**
 * 按写动作（c/u）取的【纯写字段能力】（P1-B）：不要求主体有 r 来源（只写身份可用）。
 * - matched：该资源是否命中至少一条承载该写动作的策略（闸门二 can(action) 已先判，这里供纵深）。
 * - writableAll=true：任一写来源不裁剪（mask=null）-> 全字段可写（宽 c/u 授权）。
 * - 否则 writableFields=各窄写来源「在该源可见且非只读」字段之并；payload 键必须落在此集。
 */
export interface McpWriteFieldCapability {
  matched: boolean;
  writableAll: boolean;
  /** writableAll=false 时的可写物理字段并集（已排除各来源 readOnlyFields）；空集=无可写字段。 */
  writableFields: string[];
}

export interface McpPermissionPort {
  /**
   * 闸门一：本主体在该族、**按给定动作集**（缺省 ["r"]）的可见资源集。
   * 动作敏感（team-lead 裁决 b）：读工具传 ["r"]、写工具传其所需动作（c/u/d）；
   * 集合为空 -> 该工具不注册。**"注册出的工具集 == 主体有效动作集"，不多不少**。
   */
  listAccessibleResources(family: ResourceFamily, actions?: McpAction[]): Promise<AccessibleResources>;
  /** 闸门二：单资源动作判定。资源不存在或不可见都返回 false（不泄漏存在性）。 */
  can(action: McpAction, resource: McpResource): Promise<boolean>;
  /** 字段能力（schema 收窄 + 出参投影）；nodeId 非可见节点 -> visible:false。 */
  fieldCapability(tableNodeId: string): Promise<McpFieldCapability>;
  /** 同上，但按**资源**（kind+id）定位 nav 节点——工具层只有资源 id，无 nav 节点 id。 */
  fieldCapabilityOf(resource: McpResource): Promise<McpFieldCapability>;
  /**
   * 按写动作（c/u）取【纯写字段能力】（P1-B），按**资源**（kind+id）定位节点。
   * 用 writeSources 语义而非拿 r-capability 顶替：只写身份（无 r 来源）也能得到正确的
   * 字段写白名单；creator/owner 与 REST maskSession 同口径追加不裁剪宽来源。
   */
  writeFieldCapabilityOf(resource: McpResource, action: "c" | "u"): Promise<McpWriteFieldCapability>;
}

/** 族 -> 该族工具可作用的资源类型（list_bases 取 base、get_schema 取 table…）。 */
export const FAMILY_KINDS: Readonly<Record<ResourceFamily, readonly McpResourceKind[]>> = {
  table: ["base", "table"],
  doc: ["kb", "doc"],
  canvas: ["canvas"],
};

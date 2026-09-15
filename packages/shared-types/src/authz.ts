// packages/shared-types/src/authz.ts
// M4 统一权限引擎：资源动作词汇 + 旧角色映射 + 动作串规范化 + FieldMask（唯一真源，只增）。
//
// 边界（M4 计划 §4.1/§4.4，总监裁决纯 allow）：
//   - 资源动作全集 7 枚，auth_policies.actions 存放【字典序去重】的逗号分隔串；
//   - resourceActionsForLegacyRole 是回填 SQL 与引擎的共同映射，禁止两处各写一份；
//   - FieldMask 是命中 allow 之上的能力裁剪（收窄清单，不是 deny/授权清单）：
//     缺省=不裁剪；多来源并集取最宽（见 fieldMask.ts）。

/** 资源动作（auth_policies.actions 全集）。 */
export type ResourceAction =
  | "r"
  | "c"
  | "u"
  | "d"
  | "comment"
  | "manage_share"
  | "manage_schema";

/** ResourceAction 封闭枚举（白名单校验/穷举用），字典序即规范串序。 */
export const RESOURCE_ACTIONS: readonly ResourceAction[] = [
  "r",
  "c",
  "u",
  "d",
  "comment",
  "manage_share",
  "manage_schema",
];

/** 旧角色三族（members=base 五档 / kb_members=kb 四档 / kb_doc_acls=doc 三档）。 */
export type LegacyRoleFamily = "base" | "kb" | "doc";

/** doc ACL 三档（editor/commenter/viewer）。 */
export type DocLegacyRole = "editor" | "commenter" | "viewer";
/** kb 成员四档。 */
export type KbLegacyRole = "owner" | "editor" | "commenter" | "viewer";
/** base 成员五档。 */
export type BaseLegacyRole = "owner" | "creator" | "editor" | "commenter" | "viewer";

// 各档动作映射（M4 计划 §4.1 表；manage_share/manage_schema 随祖先链继承，不做裁剪）。
const BASE_ROLE_ACTIONS: Record<BaseLegacyRole, readonly ResourceAction[]> = {
  owner: ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"],
  creator: ["r", "c", "u", "d", "comment", "manage_schema"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const KB_ROLE_ACTIONS: Record<KbLegacyRole, readonly ResourceAction[]> = {
  owner: ["r", "c", "u", "d", "comment", "manage_share"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const DOC_ROLE_ACTIONS: Record<DocLegacyRole, readonly ResourceAction[]> = {
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};

/**
 * 旧资源角色 -> 标准资源动作集（回填与引擎共用）。
 * 未知名/空角色一律收敛为空集（纯 allow：无动作即无授权），不抛异常以便批量回填安全。
 */
export function resourceActionsForLegacyRole(
  family: LegacyRoleFamily,
  role: string | null | undefined,
): ResourceAction[] {
  if (!role) return [];
  const table =
    family === "base" ? BASE_ROLE_ACTIONS : family === "kb" ? KB_ROLE_ACTIONS : DOC_ROLE_ACTIONS;
  const found = (table as Record<string, readonly ResourceAction[]>)[role];
  return found ? [...found] : [];
}

/** 动作串规范化：白名单过滤非法值 + 去重 + 字典序排序（存放前统一调用）。 */
export function normalizeActions(raw: readonly string[] | null | undefined): ResourceAction[] {
  if (!raw) return [];
  const allow = new Set<string>(RESOURCE_ACTIONS);
  const valid = raw.filter((a): a is ResourceAction => typeof a === "string" && allow.has(a));
  return [...new Set(valid)].sort();
}

/** 解析存储串（逗号分隔）为规范动作数组。 */
export function parseActionString(stored: string | null | undefined): ResourceAction[] {
  if (!stored) return [];
  return normalizeActions(stored.split(",").map((s) => s.trim()).filter(Boolean));
}

/** 动作数组 -> 规范存储串（字典序逗号分隔；空集为空串）。 */
export function toActionString(actions: readonly string[]): string {
  return normalizeActions(actions).join(",");
}

/** 规范判定：动作集是否含某动作。 */
export function hasAction(actions: readonly string[], action: ResourceAction): boolean {
  return actions.includes(action);
}

/**
 * fieldMask JSON 形状（挂在 table 节点的策略行 fieldMask 列；M3 裁决 3：不建 field 节点）。
 * 缺省字段=不裁剪；allowFields 是收窄可见清单，readOnlyFields 是该来源下只读清单。
 */
export interface FieldMask {
  allowFields?: string[];
  readOnlyFields?: string[];
}

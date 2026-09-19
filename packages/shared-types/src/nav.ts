// packages/shared-types/src/nav.ts
// M3 统一导航资源树 /api/v1/workspaces/current/tree|menu 前后端契约（唯一真源；只增导出）。
//
// 边界（M3 计划 §4.5/§5.4，总监裁决 1/5/6）：
//   - M3 零剪枝：tree/menu 对所有登录用户返回同一份数据，state 三态同值，不做资源权限判断；
//     M4 引擎落地后翻转点已登记（计划 §10）。
//   - 成功响应沿用现网信封：资源本体/平铺条目数组；错误 {error,code}，不切 {code,data,message}。
//   - 图标白名单 NAV_ICONS 是 apps/web components/icons.tsx IconName 的菜单用途镜像：
//     每个名称必须在 icons.tsx 真实存在；只增不删，icons.tsx 追加图标后在此同步。

/** 节点类别七类（实体六类 + 管理员分组）。 */
export type NavKind = "base" | "kb" | "table" | "view" | "doc" | "canvas" | "group";

/** NavKind 封闭枚举（参数校验/穷举用）。 */
export const NAV_KINDS: readonly NavKind[] = [
  "base",
  "kb",
  "table",
  "view",
  "doc",
  "canvas",
  "group",
];

/** shortcut 悬挂三态（ADR-0029）。 */
export type ShortcutState = "alive" | "soft_dangling" | "broken";

/** 菜单项类型。 */
export type MenuItemType = "container" | "shortcut";

/**
 * 菜单编排允许使用的图标白名单（菜单 iconName 与 shortcut 覆盖图标的后端校验集）。
 * 全部为 icons.tsx 中已存在的名称；folder/folderOpen 待 icons.tsx 追加后再只增。
 */
export const NAV_ICONS: readonly string[] = [
  "database",
  "book",
  "table",
  "doc",
  "canvas",
  "group",
];

// ============ 实体自定义图标白名单（与 NAV_ICONS 完全独立） ============
//
// 边界（总监裁决，勿混淆两套白名单）：
//   - NAV_ICONS 服务于【导航编排】：menu_items.iconName / nav_nodes.iconName 的后端校验集，
//     由 domain/nav/menu.ts assertIcon 消费。实体图标改动【不涉及】它，也【不进 nav_nodes】。
//   - ENTITY_ICONS 服务于【五类实体自身展示】：Base / KnowledgeBase / Table /
//     KbDoc(kind=doc) / KbDoc(kind=canvas) 的 icon 字段取值白名单，由四个 PATCH 端点校验。
//   - 两者同名条目（database/book/table/doc/canvas/group）语义相同但集合互不依赖：
//     NAV_ICONS 只增不删的历史约束不适用于本集合的裁剪，反之亦然。
//   - 每个名称必须在 apps/web components/icons.tsx 的 IconName 中真实存在（前端按名渲染）。
//   - 未自定义 = icon 字段为 null，前端按实体类型渲染默认图标与默认色，DB 不落默认色。

/** 实体自定义图标白名单（五类实体 icon 字段允许的取值；与导航编排 NAV_ICONS 独立）。 */
export const ENTITY_ICONS = [
  // 实体本征
  "database",
  "book",
  "table",
  "doc",
  "canvas",
  "grid",
  "group",
  "folder",
  "folderOpen",
  "file",
  "layers",
  "image",
  // 语义标记
  "star",
  "home",
  "checkSquare",
  "users",
  "user",
  "building",
  "shield",
  "sitemap",
  "keyRound",
  "link",
  "sparkles",
  // 通用补充
  "clock",
  "calendar",
  "tags",
  "hash",
  "globe",
  "bell",
  "eye",
] as const;

/** 实体图标名联合类型（由 ENTITY_ICONS 推导，新增图标只需改数组）。 */
export type EntityIcon = (typeof ENTITY_ICONS)[number];

/** 实体图标颜色格式：#RRGGBB 六位十六进制（大小写均可）。 */
export const ENTITY_ICON_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 实体图标名的运行时类型守卫（后端 zod refine / 前端渲染兜底共用）。 */
export function isEntityIcon(v: unknown): v is EntityIcon {
  return typeof v === "string" && (ENTITY_ICONS as readonly string[]).includes(v);
}

/** 实体图标颜色校验：null 表示清除回默认；非 null 必须匹配 #RRGGBB。 */
export function isEntityIconColor(v: unknown): boolean {
  return typeof v === "string" && ENTITY_ICON_COLOR_RE.test(v);
}

// ============ tree（权威实体树，平铺 + parentId，前端组树） ============

export interface NavNodeDTO {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: NavKind;
  /** group 为 null；资源节点同 kind。 */
  resourceType: string | null;
  resourceId: string | null;
  name: string;
  ord: number;
  /** 物化路径："/<id>/.../<id>/"。 */
  path: string;
  depth: number;
  isSystem: boolean;
  /** null = 前端按 kind 取默认图标。 */
  iconName: string | null;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
  /**
   * M4/S7 仅 on 态剪枝响应可能出现：空容器（group）对管理能力者保留时置 true（前端标灰）。
   * off/shadow 响应不含本键（与 M3 金标准逐字节一致）；资源节点恒不出现本键。
   */
  dimmed?: boolean;
}

export interface NavTreeDTO {
  workspaceId: string;
  navVersion: number;
  /** 平铺节点（含 parentId），前端自行组树。 */
  items: NavNodeDTO[];
  /** all=1 管理视图下可能为 true（本次响应受参数界截断而非全量）；当前恒 false。 */
  truncated: boolean;
}

// ============ menu（引用编排层） ============

/** shortcut 解析后的节点摘要（计划 §4.5：id/kind/name/iconName/resourceType/resourceId/state）。 */
export interface MenuNodeSummaryDTO {
  id: string;
  /** broken（节点行物理消失）时为 null。 */
  kind: NavKind | null;
  /** 节点真名（别名见 MenuItemDTO.label，不覆盖本字段）。 */
  name: string;
  iconName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  state: ShortcutState;
}

export interface MenuItemDTO {
  id: string;
  parentId: string | null;
  type: MenuItemType;
  /** shortcut 指向 nav_nodes.id（不唯一，可多处挂载）；container 为 null。 */
  nodeId: string | null;
  /** 别名；null = 展示节点真名。 */
  label: string | null;
  iconName: string | null;
  ord: number;
  /** shortcut 才有节点摘要；container/null nodeId 时为 null。 */
  node: MenuNodeSummaryDTO | null;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface MenuTreeDTO {
  workspaceId: string;
  menuVersion: number;
  /** 平铺菜单项（含 parentId），前端自行组树。 */
  items: MenuItemDTO[];
}

// ============ tree 查询参数（前端 -> 后端） ============

export interface NavTreeQuery {
  parentId?: string;
  maxDepth?: number;
  kind?: NavKind;
  /** 管理全量开关：仅组织管理员可用，绕过 10 万节点保护并返回含软删的全量节点。 */
  all?: boolean;
}

// ============ S6 菜单写（PATCH /workspaces/current/menu 批量 diff） ============

/**
 * 菜单编排操作（整单单事务，全成功或 4xx 全拒）：
 *  - insert：新建 container 或 shortcut（shortcut 必须带活节点 nodeId）；
 *  - update：改别名 label（null 清除）/图标 iconName（null 清除）；
 *  - reorder：同父排序或跨容器拖拽（parentId 可选，换容器时与 ord 同改）；
 *  - delete：软删菜单项（容器删除级联软删其全部后代）。
 */
export type MenuOp =
  | { op: "insert"; id?: string; type: MenuItemType; parentId?: string | null; nodeId?: string; label?: string | null; iconName?: string | null; ord?: number }
  | { op: "update"; id: string; label?: string | null; iconName?: string | null }
  | { op: "reorder"; id: string; ord: number; parentId?: string | null }
  | { op: "delete"; id: string };

export interface MenuChangeResult {
  menuVersion: number;
  applied: number;
  /** 各 insert 若由客户端带 id 回显，供前端对齐本地态。 */
  itemIds: string[];
}

// ============ S6 分组与移动 ============

export interface CreateGroupInput {
  name: string;
  /** 父只能是活 group 或 null（L0）；挂实体节点下一律 400。 */
  parentId?: string | null;
  ord?: number;
  iconName?: string | null;
}

export type GroupDeleteStrategy = "move" | "retain";

/**
 * N6 移动影响预览。
 * M3 口径 = 旧 members/kb_members 去重成员数、hint 恒 false；
 * M4/S7 升级 = 三源（direct/dept/role）引擎可见集对称差，hint 给 restricted 边界真值。
 */
export interface MoveImpactDTO {
  nodeId: string;
  newParentId: string;
  /** 子树内 table/doc/canvas 内容数（不含 view/group）。 */
  subtreeItemCount: number;
  /** 移动前后对子树内容的 r 可见集发生变化的去重 ACTIVE 用户数（三源展开，不含行级谓词 A-7）。 */
  affectedUserCount: number;
  /** 指向子树节点的活 shortcut 数。 */
  shortcutCount: number;
  /** 移动是否跨越 inheritAncestors=0 边界（子树某内容节点最近的 restricted 祖先移动前后不同）。 */
  willBreakInheritanceHint: boolean;
}

// ============ S7 中断继承影响预览 / 面包屑（A-6 配套） ============

/** 影响方向：关继承=losing（失访），重开=gaining（恢复）。 */
export type InheritanceDeltaKind = "losing" | "gaining";

/** 受影响单个用户（items 分页元素）。 */
export interface InheritanceImpactItemDTO {
  userId: string;
  name: string | null;
  /** 该用户在 cutoff 链上的主要来源类型。 */
  via: "direct" | "dept" | "role";
  /** 命中来源明细（如 direct:<nodeId>、dept:<deptId>、role:<roleId>）。 */
  sources: string[];
}

/** 豁免项：开关前后都不失访的兜底主体（creator / workspace owner）。 */
export interface InheritanceExemptItemDTO {
  userId: string;
  name: string | null;
  reason: "creator" | "workspace_owner";
}

/** GET /nodes/:id/inheritance/impact 响应。 */
export interface InheritanceImpactDTO {
  nodeId: string;
  /** 当前 inheritAncestors 是否开启。 */
  from: boolean;
  /** 预览目标值。 */
  to: boolean;
  delta: InheritanceDeltaKind;
  /** 精确失访/恢复人数（COUNT DISTINCT，全量计算，不受分页影响）。 */
  count: number;
  /** 分页元素（按 userId 排序）。 */
  items: InheritanceImpactItemDTO[];
  limit: number;
  offset: number;
  /** creator/workspace owner：不计入 count，仅展示。 */
  exempt: InheritanceExemptItemDTO[];
}

/** PATCH /nodes/:id/inheritance 结果。 */
export interface InheritanceChangeResultDTO {
  nodeId: string;
  inheritAncestors: boolean;
  navVersion: number;
  policyVersion: number;
  impact: InheritanceImpactDTO;
}

/** 面包屑链上的节点摘要（仅渲染所需字段，不含 ord/icon/时间戳）。 */
export interface BreadcrumbNodeDTO {
  id: string;
  parentId: string | null;
  kind: NavKind;
  resourceType: string | null;
  resourceId: string | null;
  name: string;
  path: string;
  depth: number;
}

/**
 * GET /nodes/:id/breadcrumb 响应（A-6 面包屑防泄漏）。
 * chain 只含从该用户【有权的最高祖先】到自身的连续可见段（根->自身序）；
 * 之上存在无权祖先段时 truncatedAbove=true，响应不含无权节点的 id/name/path。
 */
export interface NodeBreadcrumbDTO {
  nodeId: string;
  chain: BreadcrumbNodeDTO[];
  /** 链起点之上是否被中性截断（存在不输出的无权/越界祖先段）。 */
  truncatedAbove: boolean;
}


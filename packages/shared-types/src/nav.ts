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

/** N6 移动影响预览（M3 旧成员口径；hint 恒 false，M4 才有继承语义）。 */
export interface MoveImpactDTO {
  nodeId: string;
  newParentId: string;
  /** 子树内 table/doc/canvas 内容数（不含 view/group）。 */
  subtreeItemCount: number;
  /** 按旧 members/kb_members 口径去重的受影响成员数。 */
  affectedUserCount: number;
  /** 指向子树节点的活 shortcut 数。 */
  shortcutCount: number;
  willBreakInheritanceHint: false;
}


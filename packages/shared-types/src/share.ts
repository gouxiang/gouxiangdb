// packages/shared-types/src/share.ts
// 分享链接 + 可关联对象的 HTTP 契约（前后端唯一真源）。
//
// 边界：
//   - 分享链接的【可见范围】由被分享对象所在库的两级开关决定（库级 shareEnabled + 表级
//     shareEnabled），不是由链接自身携带的权限位决定——链接只带「档位」不带「权限」。
//   - 「可编辑」是【链接级】能力，不是系统内角色权限：外部访问者没有身份，写权限只在这一条
//     链接上生效，且每次访问按分享人当前的库权限重新计算（分享人被降权则自动回落只读）。
//   - 因此本文件不含任何角色名/权限位字段，避免前端把「可编辑」误当成一种角色。

/** 分享链接指向的对象族。base=整个数据表库；table=某张表（可带视图）；kb_doc=文档/画布。 */
export type ShareObjectType = "base" | "table" | "kb_doc";

/** 分享档位：只读 / 可编辑。仅两档，不设"评论"等中间档。 */
export type ShareMode = "view" | "edit";

export const SHARE_MODES: readonly ShareMode[] = ["view", "edit"];

/** 外部写入动作（审计 detail.action 取值，封闭集合）。 */
export type ShareWriteAction = "create" | "update" | "delete";

export interface ObjectShareLinkDTO {
  id: string;
  token: string;
  objectType: ShareObjectType;
  /** table=tableId；kb_doc=docId；base=null。 */
  objectId: string | null;
  /** table 分享所在库；base 分享即自身；kb_doc 分享为 null。 */
  baseId: string | null;
  /** 指定视图（仅 objectType=table 且创建时传了 viewId）。 */
  viewId: string | null;
  /** 创建时申请的档位。 */
  mode: ShareMode;
  /** 本次访问实际生效的档位：分享人被降权时这里是 view。前端一律以它为准。 */
  effectiveMode: ShareMode;
  /** mode=edit 但 effectiveMode=view —— 分享人已失去编辑权，链接自动降级。 */
  degraded: boolean;
  canEdit: boolean;
  createdBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  url: string;
}

/** 公开访问一个「表 + 视图」分享的响应体（够前端渲染表格/看板/画廊/日历）。 */
export interface PublicTablePayload {
  kind: "table";
  token: string;
  mode: ShareMode;
  requestedMode: ShareMode;
  degraded: boolean;
  canEdit: boolean;
  table: {
    id: string;
    name: string;
    icon: string | null;
    iconColor: string | null;
    primaryFieldId: string;
    baseId: string;
    baseName: string;
  };
  /** 未指定 viewId 时为 null，前端按第一个视图回落。 */
  view: {
    id: string;
    name: string;
    type: string;
    lockMode: string;
    config: unknown;
  } | null;
  /** 已按分享人的字段权限裁剪（隐藏字段不出现）。 */
  fields: unknown[];
  /** 视图可见字段子集（同 /api/records 的 fields 口径）。 */
  visibleFields: unknown[];
  records: unknown[];
  total: number;
  filteredTotal: number;
  page: { limit: number; offset: number };
}

/** 公开读记录分页（与 PublicTablePayload 的 records 段同构，供翻页单独调用）。 */
export interface PublicRecordsPayload {
  canEdit: boolean;
  mode: ShareMode;
  degraded: boolean;
  records: unknown[];
  total: number;
  filteredTotal: number;
  page: { limit: number; offset: number };
}

/** 文档/画布中嵌入的数据表预览（登录态与分享态共用同一份形状）。 */
export interface EmbeddedTablePayload {
  tableId: string;
  viewId: string | null;
  /** 登录态恒按当前用户权限；分享态由宿主分享链接的档位决定。 */
  canEdit: boolean;
  mode: ShareMode;
  degraded: boolean;
  /** 分享态为宿主文档的分享 token；登录态为 null。 */
  viaToken: string | null;
  table: PublicTablePayload["table"] | null;
  view: PublicTablePayload["view"];
  fields: unknown[];
  visibleFields: unknown[];
  records: unknown[];
  total: number;
  filteredTotal: number;
  page: { limit: number; offset: number };
}

// ---------------------------------------------------------------------------
// 可关联对象（关联插入选择器）
// ---------------------------------------------------------------------------

/** 可关联对象的种类。与 ShareObjectType 不是同一套东西，不要混用。 */
export type LinkableType = "base" | "kb" | "table" | "doc" | "canvas";

export const LINKABLE_TYPES: readonly LinkableType[] = ["base", "kb", "table", "doc", "canvas"];

export interface LinkableItem {
  id: string;
  type: LinkableType;
  title: string;
  /** 所在库 id（base/kb 自身为 null）。 */
  libraryId: string | null;
  libraryName: string | null;
  libraryKind: "base" | "kb" | null;
  icon: string | null;
  iconColor: string | null;
  /** 面包屑用的父级路径（文档树），顶层为空数组。 */
  path: string[];
  updatedAt: string | null;
}

export interface LinkableResponse {
  items: LinkableItem[];
  /** 后端已按 libraryPolicy 过滤；这里回传是否全量可见，供前端展示"还有更多"。 */
  truncated: boolean;
}

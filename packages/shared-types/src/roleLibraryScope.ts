// packages/shared-types/src/roleLibraryScope.ts
// 权限核心模型（二）：「角色 × 库」的库权限段。
//
// 与A 段（通讯录/组织，走 roles.permissions 字符串数组）分开存放的原因：
// 库权限是二维的——同一个角色对不同库有不同开关，同一张表的不同字段又有不同读写档位，
// 塞进一维字符串数组会让"某个库某张表某个字段"变成无法寻址的字符串黑魔法。
//
// 存储形状（apps/api 侧 role_library_scope 表）：每行 = 一个角色对一个库的一条视野授权。
//   canManage = 1  → 该角色在这个库里持管理权（含改结构、改数据、开关分享；不含删库）
//   visible   = 1  → 该角色能进这个库
//   config    → JSON.stringify(LibraryScopeConfig)，逐表/逐字段的细粒度勾选
//
// 三条硬规则不在 config 里表达（见 apps/api/src/domain/authz/libraryPolicy.ts）：
//   删库只有超级管理员；建库只有超级管理员和管理员；分享链接进来的外部人恒只读。
// 硬规则不落存储是为了不给"配置能绕过硬规则"留口子——配了也不认。

/** 库的类型：数据表库 Base 与知识库 KnowledgeBase 共用一套授权模型。 */
export type LibraryKind = "base" | "kb";

/** 字段对人（而非对系统）的三档权限。 */
export type FieldAccess =
  /** 可编辑（默认档）。 */
  | "editable"
  /** 仅可见：人改不了，但公式/自动关联等系统自动计算照常写它。 */
  | "visible"
  /** 隐藏：读不到也改不了。 */
  | "hidden";

/** 一张表（知识库里是"文档与画布"这一个对象族）的四枚数据动作。 */
export interface TableAccess {
  /** 查 */
  read: boolean;
  /** 增 */
  create: boolean;
  /** 改 */
  update: boolean;
  /** 删 */
  delete: boolean;
}

/** 字段权限的宽松序：合并多角色时取最大者。 */
export const FIELD_ACCESS_RANK: Record<FieldAccess, number> = {
  hidden: 0,
  visible: 1,
  editable: 2,
};

export const EMPTY_TABLE_ACCESS: TableAccess = {
  read: false,
  create: false,
  update: false,
  delete: false,
};

/** 只勾了库没做逐表设置时的默认视图：全部表只读可见。 */
export const READONLY_TABLE_ACCESS: TableAccess = {
  read: true,
  create: false,
  update: false,
  delete: false,
};

export const FULL_TABLE_ACCESS: TableAccess = {
  read: true,
  create: true,
  update: true,
  delete: true,
};

/**
 * 一条角色视野里真正被"配置"出来的部分。存进去时是稀疏的（没勾的表/字段不出现），
 * 读出来时由后端按治理规则补全（见 libraryPolicy.ts）。
 */
export interface LibraryScopeConfig {
  /** tableId -> 该表的四枚数据动作（缺省视为未勾选 → 走库级默认）。 */
  tables: Record<string, Partial<TableAccess>>;
  /** tableId -> fieldId -> 该字段对人的三档权限（缺省视为 editable）。 */
  fields: Record<string, Record<string, FieldAccess>>;
}

export const EMPTY_LIBRARY_SCOPE_CONFIG: LibraryScopeConfig = { tables: {}, fields: {} };

// ============ 契约 DTO ============

/** GET/PUT 单个角色的库视野。tables/fields 是补全后的全量视图，便于前端直接渲染。 */
export interface RoleLibraryScopeDTO {
  id: string;
  roleId: string;
  libraryKind: LibraryKind;
  libraryId: string;
  /** 库名冗余，省前端一次批量查询。 */
  libraryName: string;
  canManage: boolean;
  visible: boolean;
  /** 能不能把这个库的内容分享出去。独立于 canManage：canManage 为真时后端仍隐式给分享权。 */
  canShare: boolean;
  tables: Record<string, TableAccess>;
  fields: Record<string, Record<string, FieldAccess>>;
  updatedAt: string;
}

/** PUT /api/v1/org/roles/:id/library-scopes 的入参条目。 */
export interface PutLibraryScopeInput {
  libraryKind: LibraryKind;
  libraryId: string;
  canManage: boolean;
  visible: boolean;
  /** 缺省 false：整份替换语义下没带这一位 = 显式不给分享权。 */
  canShare?: boolean;
  config?: LibraryScopeConfig;
}

/**
 * 某个用户在某个库上的最终裁决结果（多个角色的库视野取并集 + 硬规则之后的成品）。
 * 后端鉴权的唯一输出形态：路由只读它，不许再自己拼一套判断。
 */
export interface LibraryAccessDTO {
  /** 能不能进这个库。 */
  visible: boolean;
  /** 能不能管（改结构、删改数据、配视图、开分享）。不含删库。 */
  canManage: boolean;
  /** 能不能删库——只有超级管理员。 */
  canDeleteLibrary: boolean;
  /**
   * 库级「允许分享」总闸的开关权 = canManage（硬规则 C，另加超级管理员/管理员）。
   * 只管「这个库允不允许被外发」这一刀，不代表能建链接——建/管链接看 canShare。
   */
  canToggleShare: boolean;
  /**
   * 总闸开着时，能不能建/管这个库的分享链接 = canManage ∪ 角色的 canShare 位。
   * 与 canToggleShare 已分家：被单独授予 canShare 的人能发链接，但动不了总闸。
   */
  canShare: boolean;
  /** 库藏命中的原因，供排障与「为什么我看不到」的自助排查。 */
  source: LibraryAccessSource;
  /** tableId -> 四枚数据动作（知识库里恒用单一 key "content" 表示文档/画布）。 */
  tables: Record<string, TableAccess>;
  /** tableId -> fieldId -> 三档字段权限。 */
  fields: Record<string, Record<string, FieldAccess>>;
}

export type LibraryAccessSource =
  /** 超级管理员：全权，与配置无关。 */
  | "super_admin"
  /** 管理员：能进所有库，管理权仍来自库视野配置。 */
  | "admin"
  /** 由角色的库视野配置算出。 */
  | "role_scope"
  /** 没有任何来源：受限成员或零授权用户。 */
  | "none";

/** 知识库没有"表"，它的增删改查对象是文档与画布，统一用这个 key 表达。 */
export const KB_CONTENT_KEY = "content";

// ============ 逐库成员接口（只读） ============

/**
 * 某个库的「谁能进来」只读视图。
 * 取代旧的逐库逐人成员名册：名单不再是授权入口，改成"这个库被哪些角色、哪些人覆盖到"。
 */
export interface LibraryRoleVisibilityDTO {
  roleId: string;
  roleName: string;
  systemKey: string | null;
  canManage: boolean;
  visible: boolean;
  /**
   * 独立于 canManage 的分享授予位：只勾「可分享」不勾「可管理」的角色也能建/管这个库的
   * 分享链接（判据 canManage || canShare，与后端 LibraryAccessDTO.canShare 同口径）。
   * 少了这一位，被单独授予「可分享」在界面上就是个勾了不生效的假承诺。
   * 注意：这一位【不等于】库级总闸开关权——动总闸要看 canToggleShare（硬规则 C）。
   */
  canShare: boolean;
  /** 经该角色（含部门继承）落到这个库上的在岗成员数。 */
  memberCount: number;
}

export interface LibraryVisibilityResponse {
  libraryKind: LibraryKind;
  libraryId: string;
  /** 能管/能看的角色清单（不含超级管理员与管理员的隐含全量视野，另行标注）。 */
  roles: LibraryRoleVisibilityDTO[];
  /** 超级管理员、管理员不配也能进（见 DTO.source=admin/super_admin），此处给人数。 */
  implicitAdminCount: number;
  implicitSuperAdminCount: number;
  /** 该库是否整体允许分享。 */
  shareEnabled: boolean;
}

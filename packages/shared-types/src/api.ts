// packages/shared-types/src/api.ts
// 前后端 API 契约（唯一真源：前端 hooks 与后端路由都必须遵守）
//
// v2 关键简化决策：
//   API 返回的 RecordDTO.fields 是「已 hydration 的合并视图」——
//   物理字段值 + 计算字段值（links/lookup/rollup/count/formula/系统字段）统一平铺，
//   前端渲染无需区分二者。v1 是 fields + computed 两份，v2 合并为一份，
//   语义等价（计算字段的 key 同样是 fieldId）。

import type { ViewConfig, ViewType, LockMode } from "./views.js";
import type { Role, PermissionSet } from "./permissions.js";
import type { FieldType, TabConfig } from "./fields.js";
import type { TableIdT, BaseIdT, FieldIdT, RecordIdT, ViewIdT } from "./ids.js";
import type { FilterNode } from "./filters.js";
import type { DefaultConfig, NumberRule } from "./defaults.js";

// ============ 通用 ============

export interface ApiError {
  error: string;
  message?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

// ============ Auth ============

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface AuthResponse {
  token: string;
  user: UserDTO;
}

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  updatedAt: string | null;
}

// ============ Base ============

export interface BaseDTO {
  id: BaseIdT;
  name: string;
  iconColor: string;
  createdAt: string;
  createdBy: string;
  role: Role; // 当前用户在此 Base 的角色
  permissions: PermissionSet;
  tableCount: number;
}

export interface CreateBaseRequest {
  name: string;
  iconColor?: string;
}

export interface UpdateBaseRequest {
  name?: string;
  iconColor?: string;
}

// ============ Table ============

export interface TableDTO {
  id: TableIdT;
  baseId: BaseIdT;
  name: string;
  primaryFieldId: FieldIdT;
  createdAt: string;
  createdBy: string;
  recordCount: number;
}

export interface CreateTableRequest {
  name: string;
  // 可选：一次性带字段（CSV 导入 / 模板建表用）
  fields?: CreateFieldRequest[];
  seeds?: Record<string, unknown>[];
}

export interface UpdateTableRequest {
  name?: string;
  primaryFieldId?: FieldIdT;
}

// ============ Field ============

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface FieldDTO {
  id: FieldIdT;
  tableId: TableIdT;
  name: string;
  type: FieldType;
  description: string;
  order: number;
  required: boolean;
  unique: boolean;

  options: SelectOption[] | null;
  precision: number | null;

  // links
  linkFieldId: FieldIdT | null;
  relatedTableId: TableIdT | null;
  relationKind: "mm" | "hm" | "bt" | null;
  isReverse: boolean;
  reverseFieldId: FieldIdT | null;
  linkDisplayFieldId: FieldIdT | null;

  // lookup / rollup
  lookupFieldId: FieldIdT | null;
  rollupFunction: "sum" | "avg" | "min" | "max" | "count" | null;

  // 子集筛选（rollup / lookup / count 生效）
  recordFilter: FilterNode | null;

  // formula
  formula: string | null;

  // tabs 字段分组容器（仅 type=tabs 有意义）
  tabsConfig: TabConfig[] | null;

  // subtable 显示字段列表（仅 type=subtable 有意义）：子表格内嵌表格展示的列
  displayedFieldIds: FieldIdT[] | null;

  // subtable「选择数据」弹窗可见字段列表（仅 type=subtable 有意义）；
  // 与 displayedFieldIds 独立；公式引用不受二者限制。
  visibleFieldIds: FieldIdT[] | null;

  // 字段默认内容配置（static/lookup/formula 三态）；null = 无默认内容
  defaultConfig: DefaultConfig | null;

  // 自动编号规则（仅 type=autoNumber）；null = 保持序号现算
  numberRule: NumberRule | null;
}

export interface CreateFieldRequest {
  name: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  options?: SelectOption[];
  precision?: number;
  maxLength?: number | null;
  defaultNow?: boolean;

  relatedTableId?: TableIdT;
  relationKind?: "mm" | "hm" | "bt";
  linkDisplayFieldId?: FieldIdT;

  lookupFieldId?: FieldIdT;
  linkFieldId?: FieldIdT;
  rollupFunction?: "sum" | "avg" | "min" | "max" | "count";

  formula?: string;

  // tabs 配置（仅 type=tabs）
  tabsConfig?: TabConfig[];
  // subtable 配置（仅 type=subtable；复用 relatedTableId/relationKind/linkDisplayFieldId/linkFieldId）
  displayedFieldIds?: FieldIdT[];
  // subtable「选择数据」弹窗可见字段（与 displayedFieldIds 独立）
  visibleFieldIds?: FieldIdT[];

  // 字段默认内容配置（static/lookup/formula）
  defaultConfig?: DefaultConfig | null;

  // 自动编号规则（仅 type=autoNumber）
  numberRule?: NumberRule | null;
}

export interface UpdateFieldRequest extends Partial<CreateFieldRequest> {
  order?: number;
}

// ============ Record ============

export type CellValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | LinkRefDTO[]
  | AttachmentDTO[]
  | Record<string, unknown>;

export interface LinkRefDTO {
  tableId: TableIdT;
  recordId: RecordIdT;
  title: string;
}

export interface AttachmentDTO {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}

export interface RecordDTO {
  id: RecordIdT;
  tableId: TableIdT;
  /** 已 hydration：物理字段 + 计算字段 平铺，key = fieldId */
  fields: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface ListRecordsQuery {
  viewId?: ViewIdT;
  limit?: number;
  /**
   * 老客户端偏移量。keyset 灰度（GX_M1_KEYSET=on）启用后，服务端仅接受
   * offset < limit × 兼容窗口（默认 5 页）；超窗返回 400，请改用 cursor。
   */
  offset?: number;
  search?: string;
  /**
   * S7 keyset 不透明游标（base64url）。首页不传；翻页传上一页响应的 nextCursor。
   * 仅在服务端 keyset 灰度开启时被识别；未开启时忽略，行为与旧版一致。
   * 游标非法/过期（边界行已删除等）返回 400，客户端应丢弃游标回到首页。
   */
  cursor?: string;
}

export interface ListRecordsResponse {
  records: RecordDTO[];
  total: number;
  fields: FieldDTO[];
  groups: GroupBucketDTO[] | null;
  aggregations: Record<string, number | null> | null;
  /**
   * S7 additive：下一页游标；无下一页为 null。仅在服务端 keyset 灰度开启时出现，
   * 未开启（默认）时响应不含该字段——老客户端与旧快照不受影响。
   */
  nextCursor?: string | null;
  /** S7 additive：是否还有下一页（与 nextCursor !== null 等价，便于前端直用）。 */
  hasMore?: boolean;
  /**
   * S7 additive：降级原因码。空数组=完整口径；M1 仅可能出现
   * "computedInMem"（宽口径内存精修超阈值，结果为受限/降级口径，前端 S8 据此提示）。
   */
  degraded?: string[];
}

export interface GroupBucketDTO {
  key: string;
  label: string;
  color: string | null;
  recordIds: string[];
  aggregations: Record<string, number | null>;
}

export interface CreateRecordRequest {
  fields?: Record<string, CellValue>;
}

export interface UpdateRecordRequest {
  fields: Record<string, CellValue>;
}

export interface BulkDeleteRequest {
  ids: RecordIdT[];
}

export interface BulkUpdateRequest {
  ids: RecordIdT[];
  fields: Record<string, CellValue>;
}

// ============ View ============

export interface ViewDTO {
  id: ViewIdT;
  tableId: TableIdT;
  name: string;
  type: ViewType;
  lockMode: LockMode;
  order: number;
  config: ViewConfig;
  createdAt: string;
}

export interface CreateViewRequest {
  name: string;
  type: ViewType;
  config?: Partial<ViewConfig>;
}

export interface UpdateViewRequest {
  name?: string;
  lockMode?: LockMode;
  order?: number;
  config?: Partial<ViewConfig>;
}

// ============ Member / 权限 ============

export interface MemberDTO {
  id: string;
  baseId: BaseIdT;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
}

export interface InviteMemberRequest {
  email: string;
  role: Role;
}

export interface UpdateMemberRequest {
  role: Role;
}

// ============ Comment ============

export interface CommentDTO {
  id: string;
  recordId: RecordIdT;
  userId: string;
  displayName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommentRequest {
  body: string;
}

// ============ CSV ============

export interface CSVImportRequest {
  csv: string;
  // 首行是否为表头
  hasHeader: boolean;
  // 列名 -> 已存在字段 id；未提供表示新建字段
  mapping: Record<string, FieldIdT | null>;
}

export interface CSVImportResult {
  createdFields: number;
  createdRecords: number;
  errors: string[];
}

export interface CSVExportRequest {
  tableId: TableIdT;
  viewId?: ViewIdT;
  fieldIds?: FieldIdT[];
}

// ============ Trash ============

export interface TrashItemDTO {
  kind: "record" | "table" | "field";
  id: string;
  name: string;
  deletedAt: string;
  parentName?: string;
}

// ============ Share ============

export interface ShareLinkDTO {
  id: string;
  baseId: BaseIdT;
  token: string;
  role: Exclude<Role, "owner">;
  createdAt: string;
  expiresAt: string | null;
  url: string;
}

export interface CreateShareLinkRequest {
  role: Exclude<Role, "owner">;
  expiresAt?: string | null;
}

// ============ 统计 ============

export interface BaseStatsDTO {
  tableCount: number;
  recordCount: number;
  fieldCount: number;
  memberCount: number;
}

// packages/shared-types/src/api.ts
// 前后端 API 契约（唯一真源：前端 hooks 与后端路由都必须遵守）
//
// v2 关键简化决策：
//   API 返回的 RecordDTO.fields 是「已 hydration 的合并视图」——
//   物理字段值 + 计算字段值（links/lookup/rollup/count/formula/系统字段）统一平铺，
//   前端渲染无需区分二者。v1 是 fields + computed 两份，v2 合并为一份，
//   语义等价（计算字段的 key 同样是 fieldId）。

import type { ViewConfig, ViewType, LockMode } from "./views.js";
import type { ViewAdminConfig } from "./viewAdmin.js";
import type { ViewUserPrefs } from "./viewUserPrefs.js";
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
  // 首次部署超级管理员为 true（可选：旧后端/存量响应不带该键，前端按 falsy 处理）。
  mustChangePassword?: boolean;
}

// ============ Base ============

export interface BaseDTO {
  id: BaseIdT;
  name: string;
  iconColor: string;
  /** 自定义图标名（ENTITY_ICONS 之一）；null = 未自定义，前端渲染默认图标。 */
  icon: string | null;
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
  /** 自定义图标名（ENTITY_ICONS 之一）；null = 未自定义，前端渲染默认图标。 */
  icon: string | null;
  /** 自定义图标颜色 #RRGGBB；null = 未自定义，前端取默认色。 */
  iconColor: string | null;
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
  /** 管理员配置层（无管理员配置时为 null）。 */
  adminConfig: ViewAdminConfig | null;
  /** 当前登录用户在该视图上的个性化偏好（未自定义为 null）。 */
  userPrefs: ViewUserPrefs | null;
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

/** 管理员配置层写请求（仅表结构管理者可用，走独立端点，不与用户 config 混通道）。 */
export interface UpdateViewAdminRequest {
  adminConfig: Partial<Omit<ViewAdminConfig, "version">>;
}

/** 用户个性化偏好写请求（#561，覆盖该用户使用态键）。 */
export interface UpdateViewUserPrefsRequest {
  prefs: Partial<Omit<ViewUserPrefs, "version">>;
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

// ============ M5 统一检索 /api/v1/*（S9 冻结契约；只增不改既有导出） ============
// 依据：docs/api/openapi.yaml 的 SearchApiKeyStatus/EmbeddingConfig/SearchStatus 等 schema
// 与 routes/v1/search.ts 的 UnifiedSearchResponse。后端仅在 GX_M5_SEARCH=on|shadow 挂载，
// off 时 /api/v1/search 与 /api/v1/admin/* 落 v1 自身 404，前端据此回退旧链。

/** v1 统一检索命中实体类别（与后端 SearchEntityType 对齐）。 */
export type V1SearchEntityType = "record" | "doc" | "canvas";
/** 请求侧类型过滤。 */
export type V1SearchTypeFilter = "all" | V1SearchEntityType;
/** 请求侧检索方式（auto=后端按配置自行路由）。 */
export type V1RequestedMode = "auto" | "vector" | "fts";
/** 实际执行路由（响应侧），含降级后的 like 关键词兜底。 */
export type V1EffectiveMode = "hybrid" | "vector" | "fts" | "like";
/** 降级原因码（实现细节，UI 必须翻译成中性文案，不直接展示）。 */
export type V1SearchDegradedReason =
  | "vec_unavailable"
  | "embedding_unhealthy"
  | "dim_mismatch"
  | "search_store_recovering";

/** 单条 v1 检索命中（record/doc/canvas 共用，定位上下文按类型可选挂字段）。 */
export interface V1SearchItem {
  type: V1SearchEntityType;
  entityId: string;
  /** 实体挂载的 nav 节点 id（record=table 节点；doc/canvas=自身节点）。 */
  nodeId: string;
  title: string;
  snippet: string;
  // record 定位上下文
  baseId?: string;
  baseName?: string;
  tableId?: string;
  tableName?: string;
  // doc/canvas 定位上下文
  kbId?: string;
  kbName?: string;
  docId?: string;
  score: number;
  /** 实体命中的召回路（仅 fts|vec；like 路不入此标，由 mode 表达）。 */
  matchedVia: Array<"fts" | "vec">;
  /** doc/canvas 最佳命中块序号；record 为 null。 */
  chunkSeq: number | null;
  /** 命中字段名；无字段命中为 null。 */
  matchedField: string | null;
}

/** GET /api/v1/search 响应。 */
export interface V1SearchResponse {
  items: V1SearchItem[];
  total: number;
  limit: number;
  mode: V1EffectiveMode;
  degraded: V1SearchDegradedReason[];
  scopeTruncated: boolean;
  policyVersion: number;
}

export interface V1SearchQuery {
  q: string;
  type?: V1SearchTypeFilter;
  mode?: V1RequestedMode;
  limit?: number;
}

/** GET /admin/embedding/config.apiKey 存在性形状（绝不回明文）。 */
export interface EmbeddingApiKeyStatus {
  configured: boolean;
  source: "env" | "db" | "none";
  /** 仅末 4 位；无 key 为 null。 */
  maskedLast4: string | null;
}

export type EmbeddingMode = "off" | "cloud";

/**
 * 远端嵌入服务形态（本次新增）。旧数据没有该字段时一律按 "cloud" 处理（向后兼容），
 * 绝不因字段缺失读不出配置。
 *   cloud             = 官方云端嵌入服务，维度由 model 元数据决定；
 *   openai-compatible = 任何 OpenAI /v1/embeddings 兼容端点，维度可手填；
 *   self-hosted       = 自建服务，维度可手填。
 */
export type EmbeddingProviderKind = "cloud" | "openai-compatible" | "self-hosted";

/** 服务形态预设：baseURL 占位与"维度能否手填"的前后端单一真源。 */
export interface EmbeddingProviderPreset {
  id: EmbeddingProviderKind;
  label: string;
  defaultBaseURL: string;
  /** 该形态是否允许手动指定维度（cloud 由 model 元数据决定，手填会写坏索引）。 */
  dimEditable: boolean;
  hint: string;
}

export const EMBEDDING_PROVIDER_PRESETS: readonly EmbeddingProviderPreset[] = [
  {
    id: "cloud",
    label: "云端服务",
    defaultBaseURL: "https://api.openai.com/v1",
    dimEditable: false,
    hint: "维度由所选模型决定，不可手填；填错维度会写坏索引。",
  },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容端点",
    defaultBaseURL: "https://your-gateway.example.com/v1",
    dimEditable: true,
    hint: "任何实现 /v1/embeddings 的网关；维度须与服务端实际输出一致。",
  },
  {
    id: "self-hosted",
    label: "自建服务",
    defaultBaseURL: "http://127.0.0.1:11434/v1",
    dimEditable: true,
    hint: "自建推理服务；维度须与服务端实际输出一致。",
  },
];

/** 该服务形态是否允许手动指定维度（后端据同一真源放行，前端据它决定输入框是否可编辑）。 */
export function providerAllowsManualDim(p: EmbeddingProviderKind): boolean {
  return EMBEDDING_PROVIDER_PRESETS.find((x) => x.id === p)?.dimEditable === true;
}

/**
 * 检索总门在 app_settings 的覆盖值。
 * 权威顺序：显式 on/off > 环境变量 GX_M5_SEARCH > 默认 off；inherit=跟随环境变量。
 * 即后台显式设置后，env=off 也压不住它（只有 inherit 才回落 env）。
 */
export type SearchEnabledOverride = "on" | "off" | "inherit";

/** 检索总门三态（与服务端 GX_M5_SEARCH 同款取值）。 */
export type SearchGateFlag = "off" | "shadow" | "on";

/** 检索总门状态（GET /admin/embedding/config 附带，供前端如实标注生效方式，不做假开关）。 */
export interface SearchGateDTO {
  /** 进程启动时由环境变量解析出的总门——决定路由是否挂载，运行期不可改。 */
  envValue: SearchGateFlag;
  /** app_settings 覆盖值（search.enabled）。 */
  override: SearchEnabledOverride;
  /** 覆盖后解析出的目标态。 */
  effective: SearchGateFlag;
  /** 检索接口当前是否真的对外可用（目标态非 off；接口恒挂载，故与 env 是否 off 无关）。 */
  queryAvailable: boolean;
  /** env=off：只是未显式设置时的默认态；后台覆盖值置 on 即可打开，不必改环境变量。 */
  envGateOff: boolean;
  /** 索引 worker 在启动期决定是否起，覆盖值需重启 API 服务才对它生效。 */
  workerNeedsRestart: boolean;
}

/** GET /admin/embedding/config。 */
export interface EmbeddingConfigDTO {
  mode: EmbeddingMode;
  /** 远端服务形态；旧库无该键时回 "cloud"。 */
  provider: EmbeddingProviderKind;
  baseURL: string;
  model: string;
  /** 现役向量维度（只读，来自 search.db 索引元数据）。 */
  dim: number;
  /** 手动指定的维度（0=未指定，沿用 model 元数据）；仅自建/兼容档可写。 */
  dimOverride: number;
  /** 当前服务形态是否允许手动指定维度。 */
  dimEditable: boolean;
  batchSize: number;
  timeoutMs: number;
  fieldChunkCap: number;
  /** 单个重建批次内在飞的远端请求数上限（真的喂给 provider 信号量）。 */
  concurrency: number;
  /** 单次远端请求的最大尝试次数（首次 + 重试）。 */
  retryMaxAttempts: number;
  /** 重试指数退避基数（毫秒）。 */
  retryBaseMs: number;
  apiKey: EmbeddingApiKeyStatus;
  /** 检索总门（环境变量基础态 + db 覆盖 + 是否需重启）。 */
  searchGate: SearchGateDTO;
}

/** PATCH /admin/embedding/config 请求体（reindex 出现即 400；dim 仅自建/兼容档接受）。 */
export interface EmbeddingConfigPatch {
  mode?: EmbeddingMode;
  provider?: EmbeddingProviderKind;
  baseURL?: string;
  model?: string;
  /** 仅 openai-compatible / self-hosted 接受；cloud 档出现即 400。 */
  dim?: number;
  batchSize?: number;
  timeoutMs?: number;
  fieldChunkCap?: number;
  concurrency?: number;
  retryMaxAttempts?: number;
  retryBaseMs?: number;
  /** 检索总门 db 覆盖；写入 app_settings，索引 worker 需重启生效。 */
  searchEnabled?: SearchEnabledOverride;
  /** off->cloud 必须显式 true，否则 409 NEED_CLOUD_CONFIRM。 */
  confirmCloud?: boolean;
  /** 字符串=覆盖落库；字段缺省=保持；显式 null=清 db key。 */
  apiKey?: string | null;
}

/** POST /admin/embedding/test-connection 结果：只探活，不落库、不回凭据。 */
export interface EmbeddingConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** 探测到的向量维度；未成功为 null。 */
  dim: number | null;
  /** 中性结论（含失败类别的中文说明，绝不回显密钥）。 */
  detail: string;
  /** 失败类别：auth/server/timeout/network/client/config；成功为 null。 */
  errorKind: string | null;
}

/** PATCH 成功响应：配置 + 是否需要显式重建。 */
export interface EmbeddingConfigPatchResult extends EmbeddingConfigDTO {
  reindexRequired: boolean;
}

/** POST /admin/embedding/api-key/rotate 请求体。 */
export interface ApiKeyRotateRequest {
  apiKey: string;
}

/** POST /admin/reindex 请求体（省略 type/entityId=全量）。 */
export interface ReindexRequest {
  type?: "record" | "doc" | "canvas";
  entityId?: string;
}

/** POST /admin/reindex 202 响应。 */
export interface ReindexStarted {
  job: "reindex";
  status: "started";
}

/** 覆盖度六项（A-F），UI 翻译为可读标签，不暴露表名/SQL。 */
export interface SearchCoverage {
  /** 活实体无 chunk（漏索引）。 */
  a: number;
  /** chunk 实体不存在/已删（脏行）。 */
  b: number;
  /** nodeId 悬空（可自愈警告）。 */
  c: number;
  /** cloud 下 chunk 缺 vec（向量欠账；off 不适用）。 */
  d: number;
  /** chunk 缺 fts 行。 */
  e: number;
  /** field chunk 缺 field_grant（授权漏登）。 */
  f: number;
}

export interface SearchIndexChunks {
  records: number;
  docs: number;
  canvas: number;
  total: number;
  fieldChunks: number;
  /** 超 fieldChunkCap 被截断的记录数。 */
  fieldChunksCapped: number;
  fieldChunkCap: number;
}

export interface SearchIndexBacklog {
  /** pending+processing。 */
  pending: number;
  failed: number;
  dead: number;
}

export interface SearchIndexStatus {
  schemaVersion: number;
  indexedAt: string | null;
  chunks: SearchIndexChunks;
  backlog: SearchIndexBacklog;
  coverage: SearchCoverage;
  rebuilding: boolean;
}

/** GET /admin/search/status。 */
export interface SearchStatusDTO {
  vec: {
    loaded: boolean;
    version: string | null;
    extPathKind: "builtin" | "env-override" | "platform";
  };
  embedding: {
    mode: EmbeddingMode;
    model: string;
    dim: number;
    healthy: boolean;
    /** 技术态中性细节，不含凭据。 */
    detail?: string;
    reindexRequired: boolean;
  };
  /** search.db 尚未建库为 null（UI 显示"尚未建立索引"空态，不是全 0）。 */
  index: SearchIndexStatus | null;
}

/** M5 管理面错误码全集（{error,code} 信封的 code）。 */
export type M5AdminErrorCode =
  | "EMBEDDING_CONFIG_INVALID"
  | "NEED_CLOUD_CONFIRM"
  | "REINDEX_IN_PROGRESS"
  | "SEARCH_UNAVAILABLE"
  | "REINDEX_FAILED";

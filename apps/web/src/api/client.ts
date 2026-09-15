// apps/web/src/api/client.ts
// API 客户端：fetch wrapper + JWT 注入 + 完整类型化
//
// 所有路径与 apps/api/src/routes/* 严格一一对应，改动任一侧都要同步这里。

import { useAuthStore } from "../store/auth";
import type {
  Role,
  UserDTO,
  BaseDTO,
  TableDTO,
  FieldDTO,
  RecordDTO,
  GroupBucketDTO,
  CommentDTO,
  MemberDTO,
  ShareLinkDTO,
  ViewDTO,
  ViewConfig,
  ViewType,
  LockMode,
  CellValue,
  LinkRefDTO,
  AttachmentDTO,
  CSVImportResult,
  TrashItemDTO,
} from "@gx/shared-types";
import type {
  DeptDTO,
  OrgRoleDTO,
  RoleAssignmentDTO,
  AssignmentSubjectInput,
  OrgMemberDTO,
  PaginatedMembers,
  EffectiveRolesResponse,
  OrgAction,
  UserAccountStatus,
  DeptMembershipDTO,
} from "@gx/shared-types";
import type {
  NavNodeDTO,
  NavTreeDTO,
  NavTreeQuery,
  MenuItemDTO,
  MenuTreeDTO,
  MenuOp,
  MenuChangeResult,
  CreateGroupInput,
  MoveImpactDTO,
  GroupDeleteStrategy,
} from "@gx/shared-types";
import { resolveApiBase, withBase as joinBase } from "../lib/base";

// API 同源前缀解析：
//  - 显式 VITE_API_URL（非空）→ 绝对来源，去尾斜杠（保留跨域/独立域名能力）
//  - 否则取部署 base（import.meta.env.BASE_URL："/" 或 "/app/gouxiangdb/"），
//    使请求与页面同源并在网关子路径下打到 /app/gouxiangdb/api/...
const BASE_URL = resolveApiBase(
  (import.meta.env.VITE_API_URL as string | undefined) ?? undefined,
  import.meta.env.BASE_URL as string | undefined,
);

/** 供 sendBeacon / keepalive 等无法复用 apiFetch 的场景拼接绝对地址 */
export const API_BASE_URL = BASE_URL;

/**
 * 把同源绝对路径（如 /uploads/... 静态资源、/login 硬导航）拼到当前部署 base 下。
 * 根部署（BASE_URL=""）原样返回；子路径部署补 /app/gouxiangdb 前缀。
 * 注意：仅适用于由同一后端/网关在 base 下提供的同源资源。
 */
export const withBase = (path: string): string => joinBase(BASE_URL, path);

/** 登录页硬导航目标（401 拦截用），子路径下为 /app/gouxiangdb/login。 */
const LOGIN_PATH = withBase("/login");

export type {
  UserDTO,
  BaseDTO,
  TableDTO,
  FieldDTO,
  SelectOption,
  RecordDTO,
  CellValue,
  LinkRefDTO,
  AttachmentDTO,
  ViewDTO,
  ViewConfig,
  ViewType,
  LockMode,
  FilterNode,
  FilterCondition,
  FilterGroup,
  FilterNot,
  FilterOp,
  SortSpec,
  SortDirection,
  GroupBucketDTO,
  AggFunc,
  RowHeight,
  RowColorConfig,
  MemberDTO,
  CommentDTO,
  ShareLinkDTO,
  Role,
  PermissionSet,
  FieldType,
  CSVImportResult,
  TrashItemDTO,
} from "@gx/shared-types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; message?: string; details?: unknown },
  ) {
    super(`API ${status}: ${body?.error ?? "未知错误"}`);
  }
}

/**
 * 这些接口本身会用 401 表达「凭据错误」（正常业务分支），
 * 不能触发全局登出，否则用户输入错密码就被踢出登录态。
 */
const AUTH_SELF_401_PATHS = /^\/api\/auth\/(login|signup|register)$/;

/** 并发请求可能同时 401，只处理一次，避免重复跳转 */
let unauthorizedHandled = false;

function handleUnauthorized(): void {
  if (unauthorizedHandled) return;
  unauthorizedHandled = true;
  useAuthStore.getState().logout();
  // 子路径部署时 pathname 形如 /app/gouxiangdb/...，用带 base 的 LOGIN_PATH 比较与跳转。
  if (typeof window !== "undefined" && !window.location.pathname.endsWith("/login")) {
    window.location.assign(LOGIN_PATH);
  }
  // 若干秒内不再重复触发（回跳后重新登录会重置）
  setTimeout(() => {
    unauthorizedHandled = false;
  }, 3000);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // 登录态失效（token 过期 / 被移除 / 服务端重启换密钥）：清理本地凭据并回登录页
    if (res.status === 401 && !AUTH_SELF_401_PATHS.test(path)) handleUnauthorized();
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ============ Auth ============

export const Auth = {
  signup: (data: { email: string; password: string; displayName: string }) =>
    apiFetch<{ token: string; user: UserDTO }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  login: (data: { email: string; password: string }) =>
    apiFetch<{ token: string; user: UserDTO }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  me: () => apiFetch<{ user: UserDTO }>("/api/auth/me"),
  updateMe: (data: Partial<Pick<UserDTO, "displayName" | "username" | "phone" | "bio">>) =>
    apiFetch<{ user: UserDTO }>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiFetch<{ ok: true }>("/api/auth/me/change-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  uploadAvatar: async (file: File) => {
    const token = useAuthStore.getState().token;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE_URL}/api/auth/me/avatar`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body);
    }
    return (await res.json()) as { user: UserDTO };
  },
  removeAvatar: () =>
    apiFetch<{ user: UserDTO }>("/api/auth/me/avatar", { method: "DELETE" }),
  deleteMe: (data: { confirm: true; password: string }) =>
    apiFetch<{ ok: true }>("/api/auth/me", {
      method: "DELETE",
      body: JSON.stringify(data),
    }),
};


// ============ Bases ============

export const Bases = {
  list: () => apiFetch<{ bases: BaseDTO[] }>("/api/bases"),
  create: (data: { name: string; iconColor?: string }) =>
    apiFetch<{ base: BaseDTO }>("/api/bases", { method: "POST", body: JSON.stringify(data) }),
  get: (baseId: string) => apiFetch<{ base: BaseDTO }>(`/api/bases/${baseId}`),
  update: (baseId: string, data: { name?: string; iconColor?: string }) =>
    apiFetch<{ base: BaseDTO }>(`/api/bases/${baseId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (baseId: string) => apiFetch<{ ok: true }>(`/api/bases/${baseId}`, { method: "DELETE" }),
  stats: (baseId: string) =>
    apiFetch<{ stats: { tableCount: number; recordCount: number; fieldCount: number; memberCount: number } }>(
      `/api/bases/${baseId}/stats`,
    ),
  /** ERD 关系图数据：表 + 跨表关联边（一次拉取，避免前端 N×useFields 的 hooks 爆炸） */
  erd: (baseId: string) =>
    apiFetch<{
      tables: { id: string; name: string; fieldCount: number; outDegree: number }[];
      edges: {
        fromTableId: string;
        toTableId: string;
        fromFieldId: string;
        fromFieldName: string;
        fieldType: string;
        relationKind: string | null;
      }[];
    }>(`/api/bases/${baseId}/erd`),

  members: (baseId: string) => apiFetch<{ members: MemberDTO[] }>(`/api/bases/${baseId}/members`),
  invite: (baseId: string, data: { email: string; role: Role }) =>
    apiFetch<{ member: MemberDTO }>(`/api/bases/${baseId}/members`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateMember: (baseId: string, memberId: string, data: { role: Role }) =>
    apiFetch<{ member: MemberDTO }>(`/api/bases/${baseId}/members/${memberId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  removeMember: (baseId: string, memberId: string) =>
    apiFetch<{ ok: true }>(`/api/bases/${baseId}/members/${memberId}`, { method: "DELETE" }),

  shareLinks: (baseId: string) => apiFetch<{ links: ShareLinkDTO[] }>(`/api/bases/${baseId}/share`),
  createShareLink: (baseId: string, data: { role: "editor" | "commenter" | "viewer"; expiresAt?: string | null }) =>
    apiFetch<{ link: ShareLinkDTO }>(`/api/bases/${baseId}/share`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  removeShareLink: (baseId: string, linkId: string) =>
    apiFetch<{ ok: true }>(`/api/bases/${baseId}/share/${linkId}`, { method: "DELETE" }),
  joinByToken: (token: string) =>
    apiFetch<{ baseId: string; role: Role; alreadyMember: boolean }>(`/api/bases/join/${token}`, {
      method: "POST",
    }),
};

// ============ Tables ============

export const Tables = {
  list: (baseId: string) => apiFetch<{ tables: TableDTO[] }>(`/api/tables${qs({ baseId })}`),
  create: (baseId: string, data: { name: string; withDefaults?: boolean }) =>
    apiFetch<{ table: TableDTO }>(`/api/tables${qs({ baseId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  get: (tableId: string) => apiFetch<{ table: TableDTO }>(`/api/tables/${tableId}`),
  update: (tableId: string, data: { name?: string; primaryFieldId?: string }) =>
    apiFetch<{ table: TableDTO }>(`/api/tables/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (tableId: string) => apiFetch<{ ok: true }>(`/api/tables/${tableId}`, { method: "DELETE" }),
  duplicate: (tableId: string, data: { name?: string; withData?: boolean }) =>
    apiFetch<{ table: TableDTO }>(`/api/tables/${tableId}/duplicate`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  clear: (tableId: string) =>
    apiFetch<{ ok: true }>(`/api/tables/${tableId}/clear`, { method: "POST" }),
  exportUrl: (tableId: string, viewId?: string) =>
    `${BASE_URL}/api/tables/${tableId}/export.csv${qs({ viewId })}`,
};

// ============ Fields ============

export const Fields = {
  list: (tableId: string) => apiFetch<{ fields: FieldDTO[] }>(`/api/fields${qs({ tableId })}`),
  create: (tableId: string, data: Record<string, unknown>) =>
    apiFetch<{ field: FieldDTO; reverseField?: FieldDTO }>(`/api/fields${qs({ tableId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (fieldId: string, data: Record<string, unknown>) =>
    apiFetch<{ field: FieldDTO }>(`/api/fields/${fieldId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (fieldId: string) => apiFetch<{ ok: true; deleted: string[] }>(`/api/fields/${fieldId}`, { method: "DELETE" }),
  move: (fieldId: string, toIndex: number) =>
    apiFetch<{ fields: FieldDTO[] }>(`/api/fields/${fieldId}/move`, {
      method: "POST",
      body: JSON.stringify({ toIndex }),
    }),
  lookupTargets: (linkFieldId: string) =>
    apiFetch<{ fields: FieldDTO[] }>(`/api/fields/lookup-targets${qs({ linkFieldId })}`),
  relationTypes: () =>
    apiFetch<{ relationTypes: { id: string; name: string; isMultiple: boolean; reverse: string }[] }>(
      "/api/fields/relation-types",
    ),
};

// ============ Records ============

/**
 * 子表/关联记录变更后，后端反向重算所影响到的父表父记录。
 * 前端据此失效父表查询（公式字段实时 hydrate，需重新拉取才能看到新值）。
 */
export interface AffectedParent {
  tableId: string;
  recordId: string;
}

export const Records = {
  list: (params: {
    tableId: string;
    viewId?: string;
    limit?: number;
    offset?: number;
    search?: string;
    /** S7 keyset 游标：首页不传，翻页传上一页 nextCursor；服务端未开启时被忽略。 */
    cursor?: string;
  }) =>
    apiFetch<{
      records: RecordDTO[];
      total: number;
      filteredTotal: number;
      fields: FieldDTO[];
      allFields: FieldDTO[];
      groups: GroupBucketDTO[] | null;
      aggregations: Record<string, number | null> | null;
      // S7 additive：仅服务端 keyset 灰度开启时出现，默认（off）响应不含这三个键。
      // 前端据此做特性探测：有游标→无限滚动；无游标→维持单页行为。
      nextCursor?: string | null;
      hasMore?: boolean;
      degraded?: string[];
    }>(`/api/records${qs({ ...params })}`),

  create: (
    tableId: string,
    data: { fields?: Record<string, unknown>; draft?: boolean },
  ) =>
    apiFetch<{ record: RecordDTO; affectedParents?: AffectedParent[] }>(`/api/records${qs({ tableId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  get: (recordId: string) => apiFetch<{ record: RecordDTO; fields: FieldDTO[] }>(`/api/records/${recordId}`),
  update: (recordId: string, data: { fields: Record<string, unknown> }) =>
    apiFetch<{ record: RecordDTO | null; affectedParents?: AffectedParent[] }>(`/api/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (recordId: string) =>
    apiFetch<{ ok: true; affectedParents?: AffectedParent[] }>(`/api/records/${recordId}`, { method: "DELETE" }),

  bulkDelete: (ids: string[]) =>
    apiFetch<{ ok: true; count: number }>("/api/records/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  bulkUpdate: (ids: string[], fields: Record<string, unknown>) =>
    apiFetch<{ ok: true; count: number }>("/api/records/bulk-update", {
      method: "POST",
      body: JSON.stringify({ ids, fields }),
    }),
  csvImport: (tableId: string, data: { csv: string; hasHeader: boolean; mapping?: Record<string, string | null> }) =>
    apiFetch<{ result: CSVImportResult }>(`/api/records/csv-import${qs({ tableId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  comments: (recordId: string) => apiFetch<{ comments: CommentDTO[] }>(`/api/records/${recordId}/comments`),
  addComment: (recordId: string, body: string) =>
    apiFetch<{ comment: CommentDTO }>(`/api/records/${recordId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  removeComment: (commentId: string) =>
    apiFetch<{ ok: true }>(`/api/records/comments/${commentId}`, { method: "DELETE" }),

  trash: (baseId: string) => apiFetch<{ items: TrashItemDTO[] }>(`/api/records/trash${qs({ baseId })}`),
  restore: (id: string, kind: "record" | "table" | "field") =>
    apiFetch<{ ok: true }>(`/api/records/trash/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  purge: (id: string, kind: "record" | "table" | "field") =>
    apiFetch<{ ok: true }>(`/api/records/trash/${id}${qs({ kind })}`, { method: "DELETE" }),

  search: (baseId: string, q: string) =>
    apiFetch<{
      results: {
        recordId: string;
        tableId: string;
        tableName: string;
        title: string;
        matchedField: string;
        snippet: string;
      }[];
    }>(`/api/records/search${qs({ baseId, q })}`),
};

// ============ 全局统一搜索（表格记录 + 知识库文档/画布） ============

export interface GlobalRecordHit {
  type: "record";
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  recordId: string;
  title: string;
  snippet: string;
  matchedField: string;
}
export interface GlobalDocHit {
  type: "doc" | "canvas";
  kbId: string;
  kbName: string;
  docId: string;
  title: string;
  snippet: string;
}

export const SearchApi = {
  global: (q: string) =>
    apiFetch<{ records: GlobalRecordHit[]; docs: GlobalDocHit[] }>(`/api/search${qs({ q })}`),
};

// ============ Views ============

export const Views = {
  list: (tableId: string) => apiFetch<{ views: ViewDTO[] }>(`/api/views${qs({ tableId })}`),
  create: (tableId: string, data: { name: string; type: ViewType; config?: Partial<ViewConfig> }) =>
    apiFetch<{ view: ViewDTO }>(`/api/views${qs({ tableId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  get: (viewId: string) => apiFetch<{ view: ViewDTO }>(`/api/views/${viewId}`),
  update: (
    viewId: string,
    data: { name?: string; lockMode?: LockMode; order?: number; config?: Partial<ViewConfig> },
  ) =>
    apiFetch<{ view: ViewDTO }>(`/api/views/${viewId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (viewId: string) => apiFetch<{ ok: true }>(`/api/views/${viewId}`, { method: "DELETE" }),
  duplicate: (viewId: string) => apiFetch<{ view: ViewDTO }>(`/api/views/${viewId}/duplicate`, { method: "POST" }),
};

// ============ 知识库（Knowledge Base，与数据表完全独立） ============

export interface KbDTO {
  id: string;
  name: string;
  iconColor: string;
  role?: string;
  docCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type KbDocKind = "doc" | "canvas";

export interface KbDocDTO {
  id: string;
  kbId?: string;
  kind: KbDocKind;
  title: string;
  content?: string;
  parentId?: string | null;
  /** 乐观锁版本号：保存时回传 baseVersion，409 表示他人已修改 */
  contentVersion?: number;
  myRole?: string;
  canEdit?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

export interface KbShareStateDTO {
  canManage?: boolean;
  shareEnabled: boolean;
  shareToken?: string | null;
  shareRole: "viewer" | "editor";
  shareIncludeChildren: boolean;
  shareUrl?: string | null;
}

export interface KbPublicDocDTO {
  id: string;
  kind: KbDocKind;
  title: string;
  content: string;
  parentId?: string | null;
  canEdit: boolean;
  updatedAt?: string;
}

export interface KbTreeItemDTO {
  id: string;
  kind: KbDocKind;
  title: string;
  parentId: string | null;
}

export interface KbDocVersionDTO {
  id: string;
  version: number;
  label: string | null;
  title: string;
  content?: string;
  createdBy: string;
  createdAt: string;
}

export interface KbMemberDTO {
  id?: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export const KbApi = {
  list: () => apiFetch<{ knowledgeBases: KbDTO[] }>("/api/kb"),
  get: (kbId: string) => apiFetch<{ knowledgeBase: KbDTO }>(`/api/kb/${kbId}`),
  create: (data: { name: string; iconColor?: string }) =>
    apiFetch<{ knowledgeBase: KbDTO }>("/api/kb", { method: "POST", body: JSON.stringify(data) }),
  update: (kbId: string, data: { name?: string; iconColor?: string }) =>
    apiFetch<{ knowledgeBase: KbDTO }>(`/api/kb/${kbId}`, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (kbId: string) => apiFetch<{ ok: true }>(`/api/kb/${kbId}`, { method: "DELETE" }),

  members: (kbId: string) => apiFetch<{ members: KbMemberDTO[] }>(`/api/kb/${kbId}/members`),
  addMember: (kbId: string, data: { email: string; role: Role }) =>
    apiFetch<{ member: { userId: string; role: string } }>(`/api/kb/${kbId}/members`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  removeMember: (kbId: string, userId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/${kbId}/members/${userId}`, { method: "DELETE" }),

  docs: (kbId: string, params?: { kind?: KbDocKind; q?: string }) =>
    apiFetch<{ docs: KbDocDTO[] }>(`/api/kb/${kbId}/docs${qs(params ?? {})}`),
  createDoc: (kbId: string, data: { kind: KbDocKind; title?: string; parentId?: string | null }) =>
    apiFetch<{ doc: KbDocDTO }>(`/api/kb/${kbId}/docs`, { method: "POST", body: JSON.stringify(data) }),

  doc: (docId: string) => apiFetch<{ doc: KbDocDTO }>(`/api/kb/docs/${docId}`),
  moveDoc: (docId: string, parentId: string | null) =>
    apiFetch<{ ok: true; parentId: string | null }>(`/api/kb/docs/${docId}/move`, {
      method: "POST",
      body: JSON.stringify({ parentId }),
    }),
  getShare: (docId: string) =>
    apiFetch<{ share: KbShareStateDTO; internal: { membersCanEdit: boolean; memberCount: number } }>(
      `/api/kb/docs/${docId}/share`,
    ),
  setShare: (
    docId: string,
    data: { shareEnabled: boolean; shareRole?: "viewer" | "editor"; shareIncludeChildren?: boolean },
  ) =>
    apiFetch<{ share: KbShareStateDTO }>(`/api/kb/docs/${docId}/share`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  setInternalShare: (docId: string, role: "viewer" | "editor") =>
    apiFetch<{ ok: true; role: string }>(`/api/kb/docs/${docId}/share/internal`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  renameDoc: (docId: string, title: string) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  saveContent: (docId: string, data: { content: string; title?: string; baseVersion?: number }) =>
    apiFetch<{ ok: true; snapshotted: boolean; savedAt: string; contentVersion: number | null }>(`/api/kb/docs/${docId}/content`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteDoc: (docId: string) => apiFetch<{ ok: true }>(`/api/kb/docs/${docId}`, { method: "DELETE" }),
  restoreDoc: (docId: string) => apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/restore`, { method: "POST" }),
  purgeDoc: (docId: string) => apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/permanent`, { method: "DELETE" }),

  trash: (kbId: string) => apiFetch<{ docs: KbDocDTO[] }>(`/api/kb/${kbId}/trash`),

  versions: (docId: string) => apiFetch<{ versions: KbDocVersionDTO[] }>(`/api/kb/docs/${docId}/versions`),
  version: (docId: string, versionRowId: string) =>
    apiFetch<{ version: KbDocVersionDTO }>(`/api/kb/docs/${docId}/versions/${versionRowId}`),
  createVersion: (docId: string, label: string) =>
    apiFetch<{ version: number }>(`/api/kb/docs/${docId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  rollback: (docId: string, versionRowId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/rollback/${versionRowId}`, { method: "POST" }),

  acl: (docId: string) =>
    apiFetch<{ acls: { userId: string; email: string; displayName: string; role: string }[] }>(
      `/api/kb/docs/${docId}/acl`,
    ),
  setAcl: (docId: string, data: { email: string; role: "editor" | "commenter" | "viewer" | null }) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/acl`, { method: "PUT", body: JSON.stringify(data) }),
};

// ============ 公开分享（匿名访问，不注入 JWT、不触发登录跳转） ============

async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export const PublicApi = {
  /** 分享根：内容 + 级联子树摘要 */
  getShare: (token: string) =>
    publicFetch<{
      rootToken: string;
      shareRole: "viewer" | "editor";
      canEdit: boolean;
      includeChildren: boolean;
      doc: KbPublicDocDTO;
      tree: KbTreeItemDTO[];
    }>(`/api/public/s/${token}`),
  /** 子树内某文档内容 */
  getDoc: (token: string, docId: string) =>
    publicFetch<{ doc: KbPublicDocDTO; canEdit: boolean; shareRole: "viewer" | "editor" }>(
      `/api/public/s/${token}/doc/${docId}`,
    ),
  /** 引用闭包内文档（画布 gxDocRef/gxLinkRef 指向的子树外文档，匿名只读） */
  getRef: (token: string, docId: string) =>
    publicFetch<{ doc: KbPublicDocDTO; canEdit: boolean; shareRole: "viewer" | "editor" }>(
      `/api/public/s/${token}/ref/${docId}`,
    ),
  /** 匿名编辑保存 */
  saveContent: (token: string, docId: string, content: string) =>
    publicFetch<{ ok: true; savedAt: string }>(`/api/public/s/${token}/doc/${docId}/content`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
};

// ============ M2 组织通讯录 /api/v1/org/*（冻结契约，只消费后端） ============
//
// 路由全部挂在 v1 前缀（/api/v1/org/...），要求登录 + ACTIVE + tv 匹配；
// 停用触发的 401 由 apiFetch 全局拦截自动登出，这里不做特殊处理。
// 成功返资源本体 / 分页对象；错误 {error,code} 经 ApiError 抛出（409 文案在 error 里）。

export type {
  DeptDTO,
  OrgRoleDTO,
  RoleAssignmentDTO,
  AssignmentSubjectInput,
  OrgMemberDTO,
  PaginatedMembers,
  EffectiveRolesResponse,
  OrgAction,
  UserAccountStatus,
  DeptMembershipDTO,
};

export interface MemberListParams {
  page?: number;
  limit?: number;
  q?: string;
  deptId?: string;
  status?: UserAccountStatus;
}

export interface InvitedUserResult {
  userId: string;
  email: string;
  status: string;
  /** 明文一次性激活码（64 hex），仅本次返回；库存只留 sha256 摘要。 */
  inviteToken: string;
}

export interface DeptAssignResult {
  userId: string;
  deptMemberships: DeptMembershipDTO[];
}

export interface LifecycleResult {
  id: string;
  status: string;
  disabledAt: string | null;
  tokenVersion: number;
}

/**
 * 由一次性激活码拼出可线下转发的激活链接（M2 不投递邮件）。
 * 走 withBase 以兼容子路径部署：根部署为 "/invite/<token>"，
 * 网关子路径下为 "/app/gouxiangdb/invite/<token>"（与 API 同源前缀一致）。
 */
export function buildInviteLink(inviteToken: string): string {
  return withBase(`/invite/${inviteToken}`);
}

export const OrgDepartments = {
  list: () => apiFetch<DeptDTO[]>("/api/v1/org/departments"),
  create: (data: { name: string; parentId?: string | null; ord?: number }) =>
    apiFetch<DeptDTO>("/api/v1/org/departments", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; ord?: number; parentId?: string | null }) =>
    apiFetch<DeptDTO>(`/api/v1/org/departments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (id: string) =>
    apiFetch<{ id: string; deleted: true }>(`/api/v1/org/departments/${id}`, { method: "DELETE" }),
};

export const OrgMembers = {
  list: (params: MemberListParams) =>
    apiFetch<PaginatedMembers>(`/api/v1/org/members${qs({ ...params })}`),
  get: (id: string) => apiFetch<OrgMemberDTO>(`/api/v1/org/members/${id}`),
  /** 当前登录者有效组织角色（直接授予 ∪ 活部门祖先闭包，附来源）。 */
  myEffectiveRoles: () =>
    apiFetch<EffectiveRolesResponse>("/api/v1/org/members/me/effective-roles"),
  /** 指定成员有效组织角色（直接授予 ∪ 活部门祖先闭包，附来源）。 */
  effectiveRoles: (id: string) =>
    apiFetch<EffectiveRolesResponse>(`/api/v1/org/members/${id}/effective-roles`),
  /** 邀请：建 INVITED 账号，一次性返回明文激活码。 */
  invite: (data: { email: string; displayName: string }) =>
    apiFetch<InvitedUserResult>("/api/v1/org/members/invite", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** 直接建 ACTIVE 账号（邮箱/姓名/初始密码）。 */
  create: (data: { email: string; displayName: string; password: string }) =>
    apiFetch<{ userId: string; email: string; status: string }>("/api/v1/org/members", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** 调岗/兼岗：add 加入兼岗、remove 移出、mainDeptId 设主部门。 */
  assignDepartments: (
    id: string,
    data: { add?: string[]; remove?: string[]; mainDeptId?: string | null },
  ) =>
    apiFetch<DeptAssignResult>(`/api/v1/org/members/${id}/departments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  disable: (id: string) =>
    apiFetch<LifecycleResult>(`/api/v1/org/members/${id}/disable`, { method: "POST" }),
  reactivate: (id: string) =>
    apiFetch<LifecycleResult>(`/api/v1/org/members/${id}/reactivate`, { method: "POST" }),
};

export const OrgRoles = {
  list: () => apiFetch<OrgRoleDTO[]>("/api/v1/org/roles"),
  create: (data: { name: string; description?: string; actions?: OrgAction[] }) =>
    apiFetch<OrgRoleDTO>("/api/v1/org/roles", { method: "POST", body: JSON.stringify(data) }),
  update: (
    id: string,
    data: { name?: string; description?: string; actions?: OrgAction[] },
  ) =>
    apiFetch<OrgRoleDTO>(`/api/v1/org/roles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  /** reassignTo：有悬挂授予时先迁移到目标角色再删。 */
  remove: (id: string, reassignTo?: string) =>
    apiFetch<{ id: string; deleted: true }>(
      `/api/v1/org/roles/${id}${qs({ reassignTo })}`,
      { method: "DELETE" },
    ),
  listAssignments: (id: string) =>
    apiFetch<RoleAssignmentDTO[]>(`/api/v1/org/roles/${id}/assignments`),
  /** 批量替换角色主体集（事务 diff）；主体可为 user 或 dept 节点。 */
  replaceAssignments: (id: string, subjects: AssignmentSubjectInput[]) =>
    apiFetch<{
      assignments: RoleAssignmentDTO[];
      added: Array<{ subjectType: string; subjectId: string }>;
      removed: Array<{ subjectType: string; subjectId: string }>;
    }>(`/api/v1/org/roles/${id}/assignments`, {
      method: "PUT",
      body: JSON.stringify({ subjects }),
    }),
};

/**
 * 接受邀请（公开，登录前调用）：一次性激活码兑换 ACTIVE 与 JWT。
 * 刻意不走 apiFetch（不带 JWT、且 401 不应触发登出跳转；本端点失败为 400/404/409）。
 */
export function acceptOrgInvite(data: {
  token: string;
  password: string;
  displayName?: string;
}): Promise<{ token: string; user: { id: string; email: string; displayName: string; status: string } }> {
  return publicFetch("/api/v1/auth/invite/accept", { method: "POST", body: JSON.stringify(data) });
}

// ============ M3 统一导航资源树 /api/v1/*（冻结契约，只消费后端） ============
//
// 这组端点仅在后端 GX_ENTERPRISE_NAV=on（默认）时挂载；off 时落入 v1 自身 404
// （{error:"接口不存在",code:"NOT_FOUND"}），前端据此回退旧双壳。tree/menu M3 零剪枝，
// 对所有登录用户返回同一份数据；悬挂三态 alive/soft_dangling/broken 见 openapi MenuNodeSummary。

export type {
  NavNodeDTO,
  NavTreeDTO,
  NavTreeQuery,
  MenuItemDTO,
  MenuTreeDTO,
  MenuOp,
  MenuChangeResult,
  CreateGroupInput,
  MoveImpactDTO,
  GroupDeleteStrategy,
};

export const NavApi = {
  /** 权威资源树（平铺 + parentId，前端组树）；登录可读。 */
  tree: (params?: NavTreeQuery) => {
    const q = qs({
      parentId: params?.parentId ?? undefined,
      maxDepth: params?.maxDepth,
      kind: params?.kind,
      all: params?.all ? "1" : undefined,
    });
    return apiFetch<NavTreeDTO>(`/api/v1/workspaces/current/tree${q}`);
  },
  /** 菜单引用树 + shortcut 节点摘要（state 三态）。 */
  menu: () => apiFetch<MenuTreeDTO>("/api/v1/workspaces/current/menu"),
  /** 菜单批量 diff 单事务（整单成功或全拒）；需 manage_menu。 */
  patchMenu: (operations: MenuOp[]) =>
    apiFetch<MenuChangeResult>("/api/v1/workspaces/current/menu", {
      method: "PATCH",
      body: JSON.stringify({ operations }),
    }),
  createGroup: (data: CreateGroupInput) =>
    apiFetch<{ id: string }>("/api/v1/nav/groups", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateGroup: (id: string, data: { name?: string; ord?: number }) =>
    apiFetch<{ id: string }>(`/api/v1/nav/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteGroup: (id: string, strategy: GroupDeleteStrategy, targetParentId?: string) =>
    apiFetch<{ id: string; moved: number }>(
      `/api/v1/nav/groups/${id}${qs({ strategy, targetParentId })}`,
      { method: "DELETE" },
    ),
  moveImpact: (id: string, newParentId: string) =>
    apiFetch<MoveImpactDTO>(
      `/api/v1/nodes/${id}/move-impact${qs({ newParentId: newParentId || "root" })}`,
    ),
  move: (id: string, newParentId: string, confirmed: boolean) =>
    apiFetch<{ id: string; newParentId: string | null }>(`/api/v1/nodes/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ newParentId, confirmed }),
    }),
};

/**
 * GX_ENTERPRISE_NAV flag 探活：GET menu 仅在 nav flag on 时挂载。
 *   200 → true；明确 NOT_FOUND（v1 off 或 /api/v1 未挂载）→ false；
 *   401 交由 apiFetch 全局登出；其它网络/服务端错误按 on 处理并由调用方自然显示错误态
 *   （后端默认 on，flag off 是唯一明确的旧壳回退信号，不应因 500 静默回退）。
 * 结果模块级缓存：flag 在单次部署内不变，全会话只探一次。
 */
let navFlagCache: boolean | null = null;

export async function probeNavV2(): Promise<boolean> {
  if (navFlagCache !== null) return navFlagCache;
  try {
    await NavApi.menu();
    navFlagCache = true;
  } catch (e) {
    // GET menu 成功路径恒返菜单树，不产生 404；404 唯一来源是子路由未挂载
    // （nav flag off 时 v1 自身 404 或整个 /api/v1 未挂载时 app 兜底 404）。
    if (e instanceof ApiError && e.status === 404) {
      navFlagCache = false;
    } else {
      throw e;
    }
  }
  return navFlagCache;
}


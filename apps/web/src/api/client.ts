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
  CreateCommentRequest,
  ShareLinkDTO,
  ViewDTO,
  ViewConfig,
  ViewAdminConfig,
  ViewUserPrefs,
  ViewType,
  LockMode,
  DetailLayout,
  TabConfig,
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
// 权限核心模型（二）：角色 × 库视野。契约真源 packages/shared-types/src/roleLibraryScope.ts，
// 端点真源 apps/api/src/routes/v1/org/roleLibraryScopes.ts。
import type {
  LibraryKind,
  RoleLibraryScopeDTO,
  PutLibraryScopeInput,
  LibraryVisibilityResponse,
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
import type {
  NodePoliciesViewDTO,
  PolicyWriteRequestDTO,
  PolicyWriteResultDTO,
  EffectiveViewDTO,
  VisibleScopeDTO,
  InheritanceImpactDTO,
  InheritanceChangeResultDTO,
  NodeBreadcrumbDTO,
} from "@gx/shared-types";
// 分享链接两档（只读 / 可编辑）+ 可关联对象。契约真源 packages/shared-types/src/share.ts，
// 端点真源 apps/api/src/routes/tableShares.ts 与 apps/api/src/routes/linkable.ts。
// 前端一律以 effectiveMode 为准渲染：mode 只是「创建时申请的档位」，分享人被降权后
// effectiveMode 会回落 view（degraded=true），此时链接实际上就是只读。
import type {
  ObjectShareLinkDTO,
  ShareMode,
  LinkableType,
  LinkableItem,
  LinkableResponse,
  /** 文档/画布中嵌入的数据表预览响应形状（GET /api/public/s/:token/embed/:tableId） */
  EmbeddedTablePayload,
} from "@gx/shared-types";
// 应用更新机制（DESIGN §5.2/§6.3）：DTO 真源在 shared-types，web 只消费不改形状。
import type { UpdatePrefetchDTO, UpdateStatusDTO } from "@gx/shared-types";
// 品牌外观（0.2.4-rc）：匿名读 + 管理员写。契约真源 packages/shared-types/src/branding.ts，
// 端点真源 apps/api/src/routes/branding.ts。
import type { BrandingConfigDTO, BrandingUpdateInput } from "@gx/shared-types";
import { resolveApiBase, withBase as joinBase } from "../lib/base";
import { saveSessionFrom } from "../lib/session-from";
// 节点模式 S2（DESIGN §6.1/§8.5 启动器）：API 主请求路径改读数据源解析器单例。
// 现状该单例恒为 local（buildActive=buildLocal），其 baseURL/headers 与下方既有 BASE_URL/
// authHeaders(<auth store token>) 逐字节同口径（见 node/datasource.test.ts golden），故本次接线
// 对浏览器/fnOS 现网零行为变化；S2+ 启动器经 setActive 放入远端后，主路径自动跟随，无需再改调用点。
import { dataSourceResolver } from "../node/datasource";
import { notifyRemoteUnauthorized } from "../node/unauthorizedBridge";

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
  ViewAdminConfig,
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
  CommentDTO,
  ShareLinkDTO,
  Role,
  PermissionSet,
  // 分享链接两档 + 可关联对象（packages/shared-types/src/share.ts）已在上方 import type 块
  // 引入成本地绑定，并由文件末尾的 export type 统一重导出——此处不再重复列名，
  // 否则同一模块内「import type X + export type { X } from」会触发 TS2300 Duplicate identifier。
  FieldType,
  CSVImportResult,
  TrashItemDTO,
} from "@gx/shared-types";
// M5 统一检索类型：本文件内部用于 apiFetch 泛型与请求体，必须 import 成本地绑定
// （不能只放在下面的 export type 重导出块——重导出不会在本模块产生绑定）。
import type {
  V1SearchResponse,
  V1SearchQuery,
  V1SearchPostBody,
  EmbeddingConfigDTO,
  EmbeddingConfigPatch,
  EmbeddingConfigPatchResult,
  EmbeddingApiKeyStatus,
  EmbeddingConnectionTestResult,
  ApiKeyRotateRequest,
  ReindexRequest,
  ReindexStarted,
  SearchStatusDTO,
} from "@gx/shared-types";
// 实时协同（三类内容共享底座）的两个 HTTP 端点。契约真源
// packages/shared-types/src/collab.ts（房间 / 票据 / presence），设计依据
// docs/design/2026-09-collab/DESIGN.md §4.2/§4.3。
// 这里必须写 import type：文件末尾的 export type { ... } from 只是重导出，
// 不会在本模块产生绑定，缺了它下面的 apiFetch 泛型会报「找不到名称」。
import type {
  CollabTicketResponse,
  CollabPresenceSnapshot,
} from "@gx/shared-types";

export class ApiError extends Error {
  constructor(
    public status: number,
    /**
     * 后端统一错误体（apps/api/src/guards.ts errorResponse）：
     *   { error: string; code: string }，500 在 dev 下额外带 message。
     * code 是稳定的机器可读枚举（BAD_REQUEST / NOT_FOUND / FORBIDDEN / CONFLICT / INTERNAL …），
     * 调用方要按 code 分支而不是按 error 文案分支——文案会变，code 不会。
     *
     * 公开分享页正文保存的 409（code=CONFLICT）额外带 `content` + `updatedAt`：
     * 库中最新正文与版本水位，供前端「就地刷新为最新」用（见 PublicApi.updateDocContent）。
     */
    public body: {
      error?: string;
      code?: string;
      message?: string;
      details?: unknown;
      /** 409 冲突：库中最新正文（仅公开分享正文保存路径带）。 */
      content?: string;
      /** 409 冲突：库中最新 updatedAt（仅公开分享正文保存路径带），刷新后作为新 baseUpdatedAt。 */
      updatedAt?: string;
    },
    /** 429 时后端给的 Retry-After 秒数（缺省 undefined）；M6 PAT 等敏感端点据此提示退避。 */
    public retryAfter?: number,
  ) {
    super(`API ${status}: ${body?.error ?? "未知错误"}`);
  }
}

/** 解析 Retry-After 响应头（整数秒）；非数字/负数/缺失返回 undefined（调用方给保守兜底）。 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * 这些接口本身会用 401 表达「凭据错误」（正常业务分支），
 * 不能触发全局登出，否则用户输入错密码就被踢出登录态。
 *
 * me/change-password：后端在"当前密码填错"时返回 401 { error:"当前密码错误" }
 * （apps/api/src/auth.ts:166），这是**密码输错**的正常业务分支，不是登录态失效。
 * 首登强制改密页（mustChangePassword 闸门）只有这一个出口且无跳过入口，若在此触发
 * 全局登出，超级管理员只要把 env 注入的长串初始密码输错一次就会被踢回登录页，
 * 等于把自己锁在系统外——故与 login/signup/register 同列白名单，401 只在页内提示。
 * 代价：本路径上真正过期的 token（auth.ts:157 同样返回 401）也不会跳转登录页，
 * 但用户下一步任何其它请求（如 /api/auth/me）仍会照常触发登出，不会卡死。
 * 注：正则锚定到行尾，/api/auth/me 之类的前缀不会被误纳入。
 */
const AUTH_SELF_401_PATHS = /^\/api\/auth\/(login|signup|register|me\/change-password)$/;

/**
 * 供 apiFetch 与单测共用：该路径的 401 属于「自身凭据错误」，不应触发全局登出。
 * 与 AUTH_SELF_401_PATHS 同源，避免判定逻辑散落两处。
 */
export function isSelfCredential401Path(path: string): boolean {
  return AUTH_SELF_401_PATHS.test(path);
}

/** 并发请求可能同时 401，只处理一次，避免重复跳转/重复通知 */
let unauthorizedHandled = false;

function handleUnauthorized(): void {
  if (unauthorizedHandled) return;
  unauthorizedHandled = true;
  // 节点模式 S2：按当前数据源分流。远端节点 401 只代表该远端会话失效——
  // 通知启动器清该节点会话/回连接界面，绝不清本地 gx-auth、不跳本地登录页。
  // （401 判定发生在 await fetch 之后，此处同步读当前活动数据源；local 分支逐字节保留旧行为。）
  const ds = dataSourceResolver.current();
  if (ds.kind === "remote") {
    notifyRemoteUnauthorized(ds.nodeId);
    setTimeout(() => {
      unauthorizedHandled = false;
    }, 3000);
    return;
  }
  // 记下当前页（含查询串），重新登录后回到原页（R-D-17）。失败不影响既有跳转。
  if (typeof window !== "undefined") {
    saveSessionFrom(window.location.pathname + window.location.search);
  }
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

/**
 * 阶段 4 · 请求超时（UI-SPEC v1.0 R-I-27）
 *
 *   网络超时（>15s）提示「请求超时，请重试」，**不自动重试写操作**（避免重复创建）。
 *
 * 口径（保守，不改变任何既有行为）：
 *   - `timeoutMs` 缺省 = 不设超时，与改造前完全一致（长任务 / 大响应不受影响）；
 *   - 只有显式传入 `timeoutMs` 的请求才挂 AbortController，超时抛 `ApiTimeoutError`；
 *   - 调用方拿到 `ApiTimeoutError` 后只提示、不重试（R-I-27 后半句）。
 */
export const WRITE_TIMEOUT_MS = 15_000;
/** 长任务（导入 / 导出 / 重建索引）单独放宽：它们本来就慢，超时只用于兜住"永久挂起"。 */
export const LONG_TASK_TIMEOUT_MS = 120_000;

/** 请求超时错误。message 固定「请求超时，请重试」，便于 UI 直接展示。 */
export class ApiTimeoutError extends Error {
  constructor(
    public path: string,
    public timeoutMs: number,
  ) {
    super("请求超时，请重试");
    this.name = "ApiTimeoutError";
  }
}

export interface ApiFetchInit extends RequestInit {
  /** R-I-27 超时毫秒数；不传 = 不超时（保持既有行为） */
  timeoutMs?: number;
}

export async function apiFetch<T>(path: string, init?: ApiFetchInit): Promise<T> {
  // S2：URL 与鉴权头都从「当前活动数据源」解析。恒 local 时 == 旧 `${BASE_URL}${path}` 与
  // authHeaders(<auth store token>)（path 恒以 "/" 开头，withBase 走 `${base}${path}` 分支，逐字节等价）。
  // baseFor/headers 在此同步段内各自读一次解析器、中间无 await，快照必然同源，不存在串源。
  const url = dataSourceResolver.baseFor(path);
  const timeoutMs = init?.timeoutMs;
  // 调用方显式给了 signal（可取消请求）时不抢它的控制器，直接透传
  const controller = timeoutMs != null && timeoutMs > 0 && !init?.signal ? new AbortController() : null;
  const timer =
    controller && typeof setTimeout === "function"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: {
        "Content-Type": "application/json",
        ...dataSourceResolver.headers(),
        ...init?.headers,
      },
    });
  } catch (e) {
    if (controller?.signal.aborted) throw new ApiTimeoutError(path, timeoutMs ?? 0);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // 登录态失效（token 过期 / 被移除 / 服务端重启换密钥）：清理本地凭据并回登录页
    if (res.status === 401 && !isSelfCredential401Path(path)) handleUnauthorized();
    throw new ApiError(res.status, body, parseRetryAfter(res.headers.get("Retry-After")));
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

// ============ Collab（多人实时协同 · 阶段 1 底座） ============

/**
 * 换一次性连接票据：60s 有效、**单次核销**（服务端accept后才失效）。
 *
 * 单次核销 —— y-websocket 内部的自动重连会复用同一个 URL，旧票在首次握手时已被核销，
 * 第二次必然被拒。故每次「建立 / 重建」WS 连接都必须重新取票，见
 * features/collab/collab-provider.ts。走 query 而非自定义头：浏览器 WebSocket 不支持
 * 自定义请求头（DESIGN.md §4.1 方案 C）。
 */
export function getCollabTicket(roomId: string): Promise<CollabTicketResponse> {
  // roomId 形如 "doc:<uuid>"，含 ':' —— 交给 qs/URLSearchParams 统一编码，不手工拼串。
  return apiFetch<CollabTicketResponse>(`/api/collab/ticket${qs({ roomId })}`);
}

/**
 * 在线名单快照：WS 尚未连通时的首屏兜底（DESIGN.md §4.3 第二行）。
 * 连通后一律以 awareness 为准，两者取同一份 CollabPresenceEntry 形状。
 */
export function getCollabPresence(roomId: string): Promise<CollabPresenceSnapshot> {
  return apiFetch<CollabPresenceSnapshot>(`/api/collab/presence${qs({ roomId })}`);
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
    // S2：跟当前数据源（local 逐字节等价）。保留 Bearer 头风格——此端点历史上走 Authorization，
    // 改 token 来源即可，不借 resolver.headers()（那恒为 X-GX-Token，会改变本端点 golden）。
    const token = dataSourceResolver.current().token;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(dataSourceResolver.baseFor("/api/auth/me/avatar"), {
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

/**
 * 系统初始化状态（免鉴权探针 GET /api/auth/bootstrap-status）。
 * initialized=false 表示空库：首个注册者由后端自举为 owner（超级管理员）。
 */
export interface BootstrapStatus {
  /** false = 库内还没有任何账号，登录页应进入「创建超级管理员」引导。 */
  initialized: boolean;
  /** 注册入口是否开放；false 时登录页隐藏注册 tab。 */
  signupOpen: boolean;
}

/**
 * 读初始化状态（免鉴权）。失败不在这里吞：由调用方降级为常规登录页并告警
 * （features/auth/login-bootstrap.ts），避免探针异常把用户卡在错误页。
 */
export function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  return apiFetch<BootstrapStatus>("/api/auth/bootstrap-status");
}


// ============ Bases ============

export const Bases = {
  list: () => apiFetch<{ bases: BaseDTO[] }>("/api/bases"),
  create: (data: { name: string; iconColor?: string; icon?: string | null }) =>
    apiFetch<{ base: BaseDTO }>("/api/bases", { method: "POST", body: JSON.stringify(data) }),
  get: (baseId: string) => apiFetch<{ base: BaseDTO }>(`/api/bases/${baseId}`),
  // icon 为 ENTITY_ICONS 白名单之一；null = 清除回默认图标。
  // update 的 iconColor 允许 null：语义「恢复默认色」。后端 Base.iconColor 列 NOT NULL，
  // 会把 null 映射回系统默认色 #378ADD（见 routes/bases.ts 三态映射）；undefined = 不改动。
  update: (baseId: string, data: { name?: string; iconColor?: string | null; icon?: string | null }) =>
    apiFetch<{ base: BaseDTO }>(`/api/bases/${baseId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (baseId: string) =>
    apiFetch<{ ok: true }>(`/api/bases/${baseId}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS }),
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

  // 权限核心模型后这里是**只读台账**：后端只回答「哪些角色覆盖到这个库、各多少人」，
  // 逐库逐人的成员名册与其三个写端点（POST/PATCH/DELETE）已下线（bases.ts 同款注释）。
  // 要改谁能进来：去通讯录改这个人的角色，或改角色的库视野。
  members: (baseId: string) =>
    apiFetch<LibraryVisibilityResponse>(`/api/bases/${baseId}/members`),

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
  // icon 为 ENTITY_ICONS 白名单之一；iconColor 为 #RRGGBB；两者传 null = 清除回默认。
  update: (tableId: string, data: { name?: string; primaryFieldId?: string; icon?: string | null; iconColor?: string | null }) =>
    apiFetch<{ table: TableDTO }>(`/api/tables/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  remove: (tableId: string) =>
    apiFetch<{ ok: true }>(`/api/tables/${tableId}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS }),
  duplicate: (tableId: string, data: { name?: string; withData?: boolean }) =>
    apiFetch<{ table: TableDTO }>(`/api/tables/${tableId}/duplicate`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  clear: (tableId: string) =>
    apiFetch<{ ok: true }>(`/api/tables/${tableId}/clear`, { method: "POST", timeoutMs: WRITE_TIMEOUT_MS }),
  exportUrl: (tableId: string, viewId?: string) =>
    `${BASE_URL}/api/tables/${tableId}/export.csv${qs({ viewId })}`,
  /**
   * 带凭据拉取 CSV 导出文本（表级导出，服务端 keyset 分批、按视图筛选排序导出全量）。
   *
   * 为什么不能 `window.open(exportUrl())`：服务端只认 `Authorization: Bearer` /
   * `X-GX-Token` 两个**请求头**（domain/org/authState.ts），而 window.open 发起的是
   * 无自定义头的浏览器导航 → 401。故统一走本方法取回文本，再在调用方本地落盘下载。
   */
  exportCsvText: async (tableId: string, viewId?: string): Promise<string> => {
    const path = `/api/tables/${tableId}/export.csv${qs({ viewId })}`;
    // S2：跟当前数据源（local 逐字节等价，X-GX-Token 头不变）。
    // R-I-27 长任务兜底超时：导出整表可能很慢（keyset 分批），故用 LONG_TASK 档而非写档。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LONG_TASK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(dataSourceResolver.baseFor(path), {
        headers: { ...dataSourceResolver.headers() },
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new ApiTimeoutError(path, LONG_TASK_TIMEOUT_MS);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401 && !isSelfCredential401Path(path)) handleUnauthorized();
      throw new ApiError(res.status, {}, parseRetryAfter(res.headers.get("Retry-After")));
    }
    return res.text();
  },
};

// ============ 数据表分享链接（挂载在 /api/tables 下） ============
//
//   GET    /api/tables/:tableId/share          本表当前全部分享链接（档位现算）
//   POST   /api/tables/:tableId/share          建链接 { mode: "view"|"edit", viewId?, expiresAt? }
//   DELETE /api/tables/:tableId/share/:linkId  吊销
//
// 两道前置门与「可编辑」的硬约束都在后端（routes/tableShares.ts），前端置灰只是提示：
// 后端拒绝时 body 形如 { error: "<可读文案>", code }，调用方要把 error 原样呈现
// （见 shareErrorMessage，不要换成自己的措辞，也不要用 ApiError.message——它带 "API 403: " 前缀）。
export const TableShares = {
  list: (tableId: string) =>
    apiFetch<{ links: ObjectShareLinkDTO[]; canGrantEdit: boolean }>(`/api/tables/${tableId}/share`),
  create: (
    tableId: string,
    data: { mode: ShareMode; viewId?: string; expiresAt?: string },
  ) =>
    apiFetch<{ link: ObjectShareLinkDTO }>(`/api/tables/${tableId}/share`, {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  remove: (tableId: string, linkId: string) =>
    apiFetch<{ ok: true }>(`/api/tables/${tableId}/share/${linkId}`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
};

// ============ 可关联对象（关联插入选择器） ============
//
// GET /api/linkable?q=&types=&limit= —— 后端已按 libraryPolicy 过滤，响应里不会出现任何
// 不可见对象的 id 或标题；truncated=true 表示还有更多（前端据此展示「还有更多」）。
export const LinkableApi = {
  search: (params: { q?: string; types?: readonly LinkableType[]; limit?: number } = {}) =>
    apiFetch<LinkableResponse>(
      `/api/linkable${qs({
        q: params.q,
        types: params.types?.length ? params.types.join(",") : undefined,
        limit: params.limit,
      })}`,
    ),
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
  remove: (fieldId: string) =>
    apiFetch<{ ok: true; deleted: string[] }>(`/api/fields/${fieldId}`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
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

/**
 * 回收站恢复的响应体。
 *
 * 后端回收站恢复（T-1）在恢复字段/表时会先查重名：同名活实体已存在则把恢复出来的这个
 * 改名为「原名（已恢复）」并递增序号，直到不冲突，因此 kind=field / kind=table **一律**
 * 带 `renamed` 与最终名字 `name`（未改名时是 `{ renamed: false, name: "原名" }`）。
 * kind=record 没有名字概念，仍是 `{ ok: true }`，不带这两个字段。
 */
export type TrashRestoreResult =
  | { ok: true }
  | { ok: true; renamed: boolean; name: string };

// ——— 记录变更日志（数据日志）———
//
// 端点：GET /api/records/:recordId/changes?limit=&cursor=（后端稍后落地）。
// 前端按下面的形状消费，并**一律先过 parseRecordChanges* 防御性解析**——端点尚未上线时
// 会返回 404（或字段不齐的旧形态），任何一处都不能让抽屉报错或白屏。

/**
 * 单条变更的操作类型。未知类型一律按 update 处理（不丢条目，也不崩）。
 * restore 与 delete 是两件事：删除=进回收站，恢复=从回收站捞回来，别合并。
 */
export type RecordChangeOp = "create" | "update" | "delete" | "restore";

/** 一次操作里某个字段的前后值。 */
export interface RecordChangeFieldDiff {
  fieldId: string;
  fieldName: string;
  before: unknown;
  after: unknown;
}

/** 一次操作（一条日志条目）。 */
export interface RecordChangeEntry {
  id: string;
  op: RecordChangeOp;
  /** 操作人 userId；系统/未知操作为 null。 */
  actorId: string | null;
  /** 后端顺带给的操作人名（可能为 null，前端再按成员名册兜底解析）。 */
  actorName: string | null;
  /** 操作时间（ISO 串）。 */
  changedAt: string;
  changes: RecordChangeFieldDiff[];
}

/**
 * 变更日志响应体（后端最终契约：分页形态）。
 *
 * 列表键**同时接受 items 与 changes**：items 是定稿形态，changes 是早期草稿形态，
 * 前端 `items ?? changes` 两版都能跑，避免前后端版本错配时整页判成非法。
 * 分页键（nextCursor / hasMore）一律可选：当前 UI 只取首页，缺了不影响条目解析。
 */
export interface RecordChangesResponse {
  items?: RecordChangeEntry[];
  /** 早期草稿形态的列表键，保留只为兼容，后端不再产出。 */
  changes?: RecordChangeEntry[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

const RECORD_CHANGE_OPS: readonly RecordChangeOp[] = ["create", "update", "delete", "restore"];

/** 只把「真对象」当成对象：数组 / null / 原始值一律 null，避免 Array 当字典读。 */
function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * 把后端返回的原始 body 归一为「条目 + 分页游标」（纯函数，便于 node 环境单测）。
 *
 * 防御点：body 非对象 / 列表键缺失或非数组 / 条目缺 id / op 是没见过的枚举 /
 * changedAt 缺失或非法 / 字段级 before|after 缺失 / 分页键类型不对 ——
 * 全部降级成安全值而不是抛错。缺 id 的条目用下标兜底 key，保证 React 列表 key 稳定且不重复。
 */
export function parseRecordChangesResponse(raw: unknown): {
  entries: RecordChangeEntry[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const root = asPlainObject(raw);
  // items 优先（定稿契约），changes 回退（草稿形态）；两者都不是数组 → 空列表
  const list = root && Array.isArray(root.items) ? root.items : Array.isArray(root?.changes) ? root.changes : [];
  const entries: RecordChangeEntry[] = [];
  list.forEach((item, i) => {
    const o = asPlainObject(item);
    if (!o) return;
    const rawOp = asNonEmptyString(o.op);
    const diffs = Array.isArray(o.changes) ? o.changes : [];
    entries.push({
      id: asNonEmptyString(o.id) ?? `record-change-${i}`,
      op: RECORD_CHANGE_OPS.includes(rawOp as RecordChangeOp) ? (rawOp as RecordChangeOp) : "update",
      actorId: asNonEmptyString(o.actorId),
      actorName: asNonEmptyString(o.actorName),
      changedAt: asNonEmptyString(o.changedAt) ?? "",
      changes: diffs.map((d, j) => {
        const dd = asPlainObject(d) ?? {};
        const fieldId = asNonEmptyString(dd.fieldId) ?? "";
        return {
          fieldId,
          fieldName: asNonEmptyString(dd.fieldName) ?? fieldId ?? `字段 ${j + 1}`,
          before: dd.before ?? null,
          after: dd.after ?? null,
        };
      }),
    });
  });
  return {
    entries: sortRecordChangesDesc(entries),
    // 分页键只做类型收敛：非字符串一律当「没有下一页」，绝不因为键的类型不对把整份响应判非法
    nextCursor: root ? asNonEmptyString(root.nextCursor) : null,
    hasMore: root?.hasMore === true,
  };
}

/**
 * 只要条目、不要游标的便捷入口（UI 目前只取首页）。
 * 行为与 parseRecordChangesResponse 完全一致，仅省掉解构。
 */
export function parseRecordChanges(raw: unknown): RecordChangeEntry[] {
  return parseRecordChangesResponse(raw).entries;
}

/**
 * 按操作时间倒序（新的在上）。
 * 解析不出时间（缺失 / 非法）的条目统一排到末尾，并保持原相对顺序——
 * 既不会因为 NaN 比较把列表打乱，也不会让坏数据混在正常条目中间。
 */
export function sortRecordChangesDesc(entries: RecordChangeEntry[]): RecordChangeEntry[] {
  return entries
    .map((entry, index) => {
      const t = Date.parse(entry.changedAt);
      return { entry, index, time: Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY };
    })
    .sort((a, b) => (a.time !== b.time ? b.time - a.time : a.index - b.index))
    .map((x) => x.entry);
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
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  get: (recordId: string) => apiFetch<{ record: RecordDTO; fields: FieldDTO[] }>(`/api/records/${recordId}`),
  update: (recordId: string, data: { fields: Record<string, unknown> }) =>
    apiFetch<{ record: RecordDTO | null; affectedParents?: AffectedParent[] }>(`/api/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  remove: (recordId: string) =>
    apiFetch<{ ok: true; affectedParents?: AffectedParent[] }>(`/api/records/${recordId}`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

  bulkDelete: (ids: string[]) =>
    apiFetch<{ ok: true; count: number }>("/api/records/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  bulkUpdate: (ids: string[], fields: Record<string, unknown>) =>
    apiFetch<{ ok: true; count: number }>("/api/records/bulk-update", {
      method: "POST",
      body: JSON.stringify({ ids, fields }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  csvImport: (tableId: string, data: { csv: string; hasHeader: boolean; mapping?: Record<string, string | null> }) =>
    apiFetch<{ result: CSVImportResult }>(`/api/records/csv-import${qs({ tableId })}`, {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: LONG_TASK_TIMEOUT_MS,
    }),

  comments: (recordId: string) => apiFetch<{ comments: CommentDTO[] }>(`/api/records/${recordId}/comments`),
  addComment: (recordId: string, data: CreateCommentRequest) =>
    apiFetch<{ comment: CommentDTO }>(`/api/records/${recordId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  removeComment: (commentId: string) =>
    apiFetch<{ ok: true }>(`/api/records/comments/${commentId}`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

  /**
   * 记录变更日志（数据日志）：GET /api/records/:recordId/changes?limit=&cursor=。
   * 只读、不挂超时（与 comments 同口径）；404 由调用方（hook）降级为空列表。
   * cursor 不传即首页；qs 会滤掉空值，首页不会多出 `cursor=`。
   */
  changes: (recordId: string, limit = 100, cursor?: string) =>
    apiFetch<RecordChangesResponse>(`/api/records/${recordId}/changes${qs({ limit, cursor })}`),

  trash: (baseId: string) => apiFetch<{ items: TrashItemDTO[] }>(`/api/records/trash${qs({ baseId })}`),
  restore: (id: string, kind: "record" | "table" | "field") =>
    apiFetch<TrashRestoreResult>(`/api/records/trash/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ kind }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  purge: (id: string, kind: "record" | "table" | "field") =>
    apiFetch<{ ok: true }>(`/api/records/trash/${id}${qs({ kind })}`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

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
  remove: (viewId: string) =>
    apiFetch<{ ok: true }>(`/api/views/${viewId}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS }),
  duplicate: (viewId: string) => apiFetch<{ view: ViewDTO }>(`/api/views/${viewId}/duplicate`, { method: "POST" }),
  /**
   * 详情布局「一次事务」保存：view.config.detailLayout + 所有选项卡容器的 tabsConfig
   * 在同一事务里写，写完由服务端触发自动留档。
   *
   * 为什么不能前端串行走 `PATCH /api/views/:id` + N 个 `PATCH /api/fields/:id`：
   * 中途失败会留下**半回滚**状态（布局回去了、选项卡没回去），比完全不保存更糟 ——
   * 用户看到的是一个"既不是旧版也不是新版"的表单。事务端点把这个窗口彻底关掉。
   */
  /**
   * 响应里的 `version` 是**本次保存顺带产出的版本号**；`null` 表示「内容与上一版相同，
   * 后端判重后没留新版本」—— 这是正常结果不是失败，调用方照常提示已保存，不要报错。
   */
  saveDetailLayout: (
    viewId: string,
    data: { detailLayout: DetailLayout | null; tabs: Record<string, TabConfig[]> },
  ) =>
    apiFetch<SaveDetailLayoutResult>(`/api/views/${encodeURIComponent(viewId)}/detail-layout`, {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  /**
   * 视图「管理员配置层」写入（#560）：仅表结构管理者可用（非管理者后端 403）。
   * 与普通用户 config 的 PATCH /api/views/:id 是两条独立通道，互不干扰。
   * 请求体只发变化键，后端按 UpdateViewAdminRequest 浅合并。
   */
  updateAdmin: (
    viewId: string,
    adminConfig: Partial<Omit<ViewAdminConfig, "version">>,
  ) =>
    apiFetch<{ view: ViewDTO }>(`/api/views/${encodeURIComponent(viewId)}/admin`, {
      method: "PATCH",
      body: JSON.stringify({ adminConfig }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  /**
   * 视图「用户个性化层」写入（#561）：任何成员都可写自己的偏好，不触碰共享 config。
   * 请求体只发变化键，后端按 UpdateViewUserPrefsRequest 浅合并。
   */
  savePrefs: (viewId: string, prefs: Partial<Omit<ViewUserPrefs, "version">>) =>
    apiFetch<{ userPrefs: ViewUserPrefs }>(`/api/views/${encodeURIComponent(viewId)}/prefs`, {
      method: "PUT",
      body: JSON.stringify({ prefs }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  /** 清除当前用户在该视图上的个性化覆盖，恢复为视图默认 config。 */
  resetPrefs: (viewId: string) =>
    apiFetch<{ ok: true }>(`/api/views/${encodeURIComponent(viewId)}/prefs`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
};

/** POST /api/views/:viewId/detail-layout 的响应 */
export interface SaveDetailLayoutResult {
  ok: true;
  /**
   * 本次保存顺带产出的版本号。`null` = 内容与上一版相同，后端判重后没留新版本 ——
   * 这是正常结果不是失败，调用方照常提示「已保存」，**不要**当成错误。
   */
  version: number | null;
  /**
   * 本次保存被剔除的已删字段 id：布局里引用了表里已经不存在的字段，服务端在落库前
   * 静默移除。**不能静默给用户** —— 调用方必须提示「有 N 个字段已不存在，已从布局中
   * 移除」，否则用户会以为字段还在，只是暂时没渲染出来。
   */
  removedFieldIds: string[];
  /** 本次真正写入 tabsConfig 的选项卡容器字段 id（UI 当前不展示，留作排查与后续埋点） */
  tabsUpdated: string[];
  /**
   * **发了但没写进去**的容器键（键找不到对应的 tabs 字段 / 环境缺 tabsConfig 列）。
   * 这是另一处静默 no-op：请求 200、布局存了、只有这几个容器没生效，不提示用户永远不知道。
   * 契约上**恒存在**（没跳过时是 `[]`），调用方照常消费即可。
   */
  skipped: string[];
}

// ============ 知识库（Knowledge Base，与数据表完全独立） ============

export interface KbDTO {
  id: string;
  name: string;
  iconColor: string;
  /** 自定义图标名（ENTITY_ICONS 之一）；null/undefined = 未自定义，前端渲染默认图标。 */
  icon?: string | null;
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
  /** 自定义图标名（ENTITY_ICONS 之一）；null/undefined = 未自定义，前端按 kind 渲染默认图标。 */
  icon?: string | null;
  /** 自定义图标颜色 #RRGGBB；null/undefined = 未自定义，前端取默认色。 */
  iconColor?: string | null;
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
  /** 所在知识库的「允许分享」开关（GET 才回；POST 响应不带）。 */
  shareAllowed?: boolean;
  /**
   * 本次访问实际生效的档位（GET 才回，后端 resolveDocShareCaps 现算）。
   * 是文档里「嵌入的数据表预览能不能写」的开关；文档正文能否写看同响应的 canEdit
   * （两者都由同一档位算出来，但语义不同：正文可写的前提是分享人此刻仍有内容编辑权）。
   * 分享人被降权时 mode 回落 view 且 degraded=true。
   */
  mode?: ShareMode;
  /** 创建时申请的档位（mode=edit 而 effective=view 时才看得出差别）。 */
  requestedMode?: ShareMode;
  /** requestedMode=edit 但分享人已失去编辑权 → 链接自动降级为只读。 */
  degraded?: boolean;
  /**
   * 本人此刻能否开「可编辑」档位（GET 才回，后端 canSharerGrantDocEdit 现算）。
   * 与 POST 时的 assertSharerCanGrantDocEdit 是同一次判定——用它把选项置灰，不要前端自己猜。
   * 未加载 / 出错时按不能处理（fail-closed）。
   */
  canGrantEdit?: boolean;
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

// ---------------------------------------------------------------------------
// 公开分享（doc / table / base 三类）—— web 本地契约类型
//
// 后端按对象族在 GET /api/public/s/:token 分三种响应（见 apps/api/src/routes/public.ts）。
// 这些类型是**前端本地声明**（packages/shared-types 的 base/tables[].token 字段由后端
// 同事在增量补齐，为避免跨包耦合，此处只声明 web 需要的形状，新增字段一律给可选）。
// ---------------------------------------------------------------------------

/** 公开「表 + 视图」分享（含首屏记录）。与 @gx/shared-types PublicTablePayload 同构。 */
export interface PublicTableShareDTO {
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
  view: {
    id: string;
    name: string;
    type: string;
    lockMode: string;
    config: unknown;
  } | null;
  /** 已按分享人字段权限裁剪（隐藏字段不出现）。 */
  fields: FieldDTO[];
  /** 视图可见字段子集（渲染列）。 */
  visibleFields: FieldDTO[];
  records: RecordDTO[];
  total: number;
  filteredTotal: number;
  page: { limit: number; offset: number };
}

/** 公开读记录翻页响应（与 PublicTableShareDTO.records 段同构）。 */
export interface PublicRecordsShareDTO {
  canEdit: boolean;
  mode: ShareMode;
  degraded: boolean;
  records: RecordDTO[];
  total: number;
  filteredTotal: number;
  page: { limit: number; offset: number };
}

/** 库分享外壳中「可点进去看」的一张表：仅列自身已开分享且带有效 token 的表。 */
export interface PublicShareTableItem {
  id: string;
  name: string;
  icon: string | null;
  /** 该表当前有效的独立 table 分享 token（后端增量字段，缺省视为不可点）。 */
  token?: string;
}

/** 库（base）分享外壳：库信息 + 该库内已单独开启分享的表清单，不含任何记录数据。 */
export interface PublicBaseShareDTO {
  kind: "base";
  token: string;
  mode: ShareMode;
  canEdit: false;
  base: { id: string; name: string };
  tables: PublicShareTableItem[];
}

/**
 * 文档（kb_doc）分享响应。
 * 后端 docShareResponse 实际带 `kind: "doc"`（历史 getShare 类型未显式声明，这里补齐）。
 */
export type PublicDocShareDTO = {
  kind?: "doc";
  rootToken: string;
  shareRole: "viewer" | "editor";
  canEdit: boolean;
  requestedMode: ShareMode;
  mode: ShareMode;
  degraded: boolean;
  includeChildren: boolean;
  doc: KbPublicDocDTO;
  tree: KbTreeItemDTO[];
};

/** GET /api/public/s/:token 的判别联合：按 kind 分发到 doc / table / base 三类页面。 */
export type PublicShareAnyDTO = PublicDocShareDTO | PublicTableShareDTO | PublicBaseShareDTO;


export interface KbDocVersionDTO {
  id: string;
  version: number;
  label: string | null;
  title: string;
  content?: string;
  createdBy: string;
  createdAt: string;
}

export const KbApi = {
  list: () => apiFetch<{ knowledgeBases: KbDTO[] }>("/api/kb"),
  get: (kbId: string) => apiFetch<{ knowledgeBase: KbDTO }>(`/api/kb/${kbId}`),
  create: (data: { name: string; iconColor?: string }) =>
    apiFetch<{ knowledgeBase: KbDTO }>("/api/kb", { method: "POST", body: JSON.stringify(data) }),
  // icon 为 ENTITY_ICONS 白名单之一；null = 清除回默认图标。
  // 同 Bases.update：null = 恢复默认色（后端知识库列 NOT NULL，映射回 #0F6E56）。
  update: (kbId: string, data: { name?: string; iconColor?: string | null; icon?: string | null }) =>
    apiFetch<{ knowledgeBase: KbDTO }>(`/api/kb/${kbId}`, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (kbId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/${kbId}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS }),

  // 只读台账，与 Bases.members 同源（后端 libraryVisibility）：加人/改档位/踢人三个
  // 写端点已下线，kb_members 行只作历史留档。
  members: (kbId: string) => apiFetch<LibraryVisibilityResponse>(`/api/kb/${kbId}/members`),

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
    // 内部段后端只回一个汇总开关（sharing.ts）：逐库逐人的成员名册下线后不再有人数可给。
    apiFetch<{ share: KbShareStateDTO; internal: { membersCanEdit: boolean } }>(
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
  /**
   * PATCH /api/kb/docs/:docId。
   * 传字符串 = 仅改标题（旧签名，保持不变）；传对象 = 改标题 / 图标 / 图标颜色，
   * 其中 icon 与 iconColor 传 null 表示清除回默认。
   */
  renameDoc: (
    docId: string,
    patch: string | { title?: string; icon?: string | null; iconColor?: string | null },
  ) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}`, {
      method: "PATCH",
      body: JSON.stringify(typeof patch === "string" ? { title: patch } : patch),
    }),
  saveContent: (docId: string, data: { content: string; title?: string; baseVersion?: number }) =>
    apiFetch<{ ok: true; snapshotted: boolean; savedAt: string; contentVersion: number | null }>(`/api/kb/docs/${docId}/content`, {
      method: "PUT",
      body: JSON.stringify(data),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  deleteDoc: (docId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS }),
  restoreDoc: (docId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/restore`, {
      method: "POST",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  purgeDoc: (docId: string) =>
    apiFetch<{ ok: true }>(`/api/kb/docs/${docId}/permanent`, {
      method: "DELETE",
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

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
  /**
   * 分享根：内容 + 级联子树摘要。
   * canEdit 为真实值：可编辑档位且分享人此刻仍有内容编辑权时为 true，否则 false。
   * mode / degraded 描述生效档位与降级情况；文档里嵌入的数据表预览按 mode 决定读写。
   * 前端一律以 canEdit 为准决定正文是否可编辑（缺字段 / 出错时 fail-closed 按只读）。
   */
  getShare: (token: string) =>
    publicFetch<{
      rootToken: string;
      shareRole: "viewer" | "editor";
      canEdit: boolean;
      /** 分享链接申请档位 */
      requestedMode: ShareMode;
      /** 本次访问实际生效档位（分享人被降权时回落 view）。前端一律以它为准。 */
      mode: ShareMode;
      /** mode=edit 但实际只读 —— 分享人已失去编辑权，链接自动降级。 */
      degraded: boolean;
      includeChildren: boolean;
      doc: KbPublicDocDTO;
      tree: KbTreeItemDTO[];
    }>(`/api/public/s/${token}`),

  /**
   * 分享根（三类判别联合）：按对象族分发。
   *   - 文档/画布（历史 kb_doc，后端 kind 字面量为 "doc"，可能缺省）→ PublicDocShareDTO；
   *   - 数据表 → PublicTableShareDTO（表结构 + 首屏记录）；
   *   - 库 base → PublicBaseShareDTO（库信息 + 可点进去看的已分享表清单，不含记录）。
   * 匿名只读；外部人免登录。文档族正文是否可编辑仍以各自 canEdit 为准。
   */
  getPublicShareAny: (token: string) =>
    publicFetch<PublicShareAnyDTO>(`/api/public/s/${token}`),

  /**
   * 库分享作用域内的「单表只读」：GET /s/:baseToken/t/:tableId。
   * 仅当该表自身已单独开启分享（出现在库外壳清单里）才可读，否则后端 404。
   * 返回与直连表 token（getPublicShareAny 的 table 分支）逐字段同构。
   */
  getPublicBaseTable: (baseToken: string, tableId: string, opts?: { limit?: number; offset?: number }) =>
    publicFetch<PublicTableShareDTO>(
      `/api/public/s/${baseToken}/t/${tableId}${qs({
        limit: opts?.limit,
        offset: opts?.offset,
      })}`,
    ),

  /** 库分享作用域内单表翻页读记录（只读）：GET /s/:baseToken/t/:tableId/records。 */
  getPublicBaseTableRecords: (
    baseToken: string,
    tableId: string,
    opts: { limit: number; offset: number },
  ) =>
    publicFetch<PublicRecordsShareDTO>(
      `/api/public/s/${baseToken}/t/${tableId}/records${qs(opts)}`,
    ),

  /** 直连数据表 token 的翻页读记录（只读）：GET /s/:tableToken/records。 */
  getPublicTableRecords: (token: string, opts: { limit: number; offset: number }) =>
    publicFetch<PublicRecordsShareDTO>(`/api/public/s/${token}/records${qs(opts)}`),

  /** 子树内某文档内容（canEdit 为真实值，同分享根口径） */
  getDoc: (token: string, docId: string) =>
    publicFetch<{ doc: KbPublicDocDTO; canEdit: boolean; shareRole: "viewer" | "editor" }>(
      `/api/public/s/${token}/doc/${docId}`,
    ),
  /** 引用闭包内文档（画布 gxDocRef/gxLinkRef 指向的子树外文档，匿名只读；canEdit 恒 false） */
  getRef: (token: string, docId: string) =>
    publicFetch<{ doc: KbPublicDocDTO; canEdit: boolean; shareRole: "viewer" | "editor" }>(
      `/api/public/s/${token}/ref/${docId}`,
    ),

  /**
   * 保存正文（可编辑档位下的匿名写）。
   * 乐观锁：必须带上「加载 / 上次成功保存」时拿到的 updatedAt 作为 baseUpdatedAt。
   *   200 → { ok, updatedAt, canEdit, mode }，用返回的 updatedAt 作为新基线；
   *   409 → body 带 code="CONFLICT" + 最新 content/updatedAt，**绝不覆盖他人改动**，
   *         调用方应就地刷新为最新内容并提示用户重新编辑（不得自动重发）；
   *   403 → 档位不足（分享人被降权后链接回落只读）；
   *   400 → 缺 baseUpdatedAt。
   * docId 走子树通道（/doc/），只对本次分享子树内文档有效。
   */
  updateDocContent: (
    token: string,
    docId: string,
    data: { content: string; baseUpdatedAt: string },
  ) =>
    publicFetch<{ ok: true; updatedAt: string; canEdit: boolean; mode: ShareMode }>(
      `/api/public/s/${token}/doc/${docId}/content`,
      { method: "PUT", body: JSON.stringify(data) },
    ),

  // ---- 文档/画布中【嵌入的数据表预览】的分享态通道 ----
  // 档位由宿主文档/画布的分享档位决定（canEdit/mode 由服务端按宿主档位算好），
  // 与该数据表自身的分享开关无关。没有宿主 token 就没有这条通道。
  getEmbed: (token: string, tableId: string, opts?: { viewId?: string | null; limit?: number; offset?: number }) =>
    publicFetch<EmbeddedTablePayload>(
      `/api/public/s/${token}/embed/${tableId}${qs({
        viewId: opts?.viewId ?? undefined,
        limit: opts?.limit,
        offset: opts?.offset,
      })}`,
    ),
  createEmbedRecord: (token: string, tableId: string, fields: Record<string, unknown>) =>
    publicFetch<{ record: { id: string }; canEdit: boolean; mode: ShareMode }>(
      `/api/public/s/${token}/embed/${tableId}/records`,
      { method: "POST", body: JSON.stringify({ fields }) },
    ),
  updateEmbedRecord: (token: string, tableId: string, recordId: string, fields: Record<string, unknown>) =>
    publicFetch<{ ok: true; canEdit: boolean; mode: ShareMode }>(
      `/api/public/s/${token}/embed/${tableId}/records/${recordId}`,
      { method: "PATCH", body: JSON.stringify({ fields }) },
    ),
  deleteEmbedRecord: (token: string, tableId: string, recordId: string) =>
    publicFetch<{ ok: true; canEdit: boolean; mode: ShareMode }>(
      `/api/public/s/${token}/embed/${tableId}/records/${recordId}`,
      { method: "DELETE" },
    ),
  // 正文匿名写：仅「可编辑」档位 + 分享人此刻仍有内容编辑权时开放（读接口 canEdit 随之返回真实值）。
  // 保存走上面的 updateDocContent（乐观锁 baseUpdatedAt）。
};

// ============ 可关联对象 / 嵌入数据表预览：重导出 ============
// 类型名在上方 import type 块已引入本地绑定（LinkableApi / PublicApi.getEmbed 直接用），
// 这里做本地重导出供消费点 import（features/kb/canvas/linkable-hooks.ts 等）。
export type {
  ObjectShareLinkDTO,
  ShareMode,
  LinkableType,
  LinkableItem,
  LinkableResponse,
  EmbeddedTablePayload,
};

// 若干单测/调试入口按既有约定从这里取 toast 快照（真实实现住在 components/ui）。
// 组件层不反向依赖本模块，因此这条重导出不构成循环依赖。
export { toastSnapshot } from "../components/ui";

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

/** DELETE /api/v1/org/members/:id 的删除结果（物理删除，不可恢复）。 */
export interface DeleteUserResult {
  id: string;
  email: string;
  deleted: true;
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
  /** 删除账号（需 delete_users）：物理删除，不可恢复；自删 400、删掉最后 owner 409。 */
  remove: (id: string) =>
    apiFetch<DeleteUserResult>(`/api/v1/org/members/${id}`, { method: "DELETE" }),
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
 * 角色 × 库视野（权限核心模型二）。命名 RoleScopes 前缀，与库设置页那组读写区分开。
 *
 * 端点形态（与后端 roleLibraryScopes.ts 严格对应，改任一侧都要同步）：
 *   GET  /api/v1/org/library-scopes?roleId=       某角色的全部库视野
 *   PUT  /api/v1/org/library-scopes  {roleId,items} 整体替换（roleId 走【请求体】，不是 query）
 *   GET  /api/v1/org/libraries/:kind/:id/visibility  这个库被哪些角色覆盖（只读台账）
 *   PATCH /api/bases/:id/share-enabled、/api/kb/:id/share-enabled  库级允许分享开关
 *
 * PUT 必须整体替换：逐条改会让「取消勾选」与「没提交」无法区分，从而留下删不干净的授权。
 */
export const RoleScopes = {
  list: (roleId: string) =>
    apiFetch<{ roleId: string; scopes: RoleLibraryScopeDTO[] }>(
      `/api/v1/org/library-scopes${qs({ roleId })}`,
    ),
  replace: (roleId: string, items: PutLibraryScopeInput[]) =>
    apiFetch<{ roleId: string; scopes: RoleLibraryScopeDTO[] }>("/api/v1/org/library-scopes", {
      method: "PUT",
      body: JSON.stringify({ roleId, items }),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  visibility: (kind: LibraryKind, libraryId: string) =>
    apiFetch<LibraryVisibilityResponse>(`/api/v1/org/libraries/${kind}/${libraryId}/visibility`),
  setShareEnabled: (kind: LibraryKind, libraryId: string, enabled: boolean) =>
    apiFetch<{ shareEnabled: boolean }>(
      `${kind === "kb" ? `/api/kb/${libraryId}` : `/api/bases/${libraryId}`}/share-enabled`,
      { method: "PATCH", body: JSON.stringify({ enabled }), timeoutMs: WRITE_TIMEOUT_MS },
    ),
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

// 节点模式 S2：nav flag 是「每个部署一份」的能力位，切到另一节点后旧值不可复用。
// 订阅数据源，nodeId 变化即重置缓存。浏览器/fnOS 下 nodeId 恒 "local" 从不触发，零行为变化。
{
  let lastNavFlagNodeId = dataSourceResolver.current().nodeId;
  dataSourceResolver.subscribe(() => {
    const next = dataSourceResolver.current().nodeId;
    if (next !== lastNavFlagNodeId) {
      lastNavFlagNodeId = next;
      navFlagCache = null;
    }
  });
}

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

// ============ M4 统一权限引擎 /api/v1/*（S5-S9 冻结契约，只消费后端） ============
//
// 门控纪律（M4-FE handoff §1）：继承切换 + 策略编辑入口仅在 /meta 显式 authzManage===true
// 时放行；后端 S10 翻 AUTHZ_ENFORCE_READY 总门前不下发此字段，故任何环境默认 fail-closed。
// 只读解释类（effective 来源链 / visible-scope 诊断 / breadcrumb 截断标记）不受此门控。

/** GET /api/v1/meta 响应。authzManage 由后端 S10 起在总门 on 时下发，缺省即关。 */
export interface EnterpriseMeta {
  apiVersion?: string;
  enterpriseOrg?: boolean;
  /** 权限写能力总门：仅严格等于 true 才放行策略编辑/继承切换；undefined/false 一律只读。 */
  authzManage?: boolean;
  auth?: { userId?: string; status?: string; workspaceId?: string };
}

/**
 * 读企业能力位。/meta 仅在 enterpriseOrg on 时挂载；404（未挂载）与网络错误都收敛为
 * 「无能力位」而非抛出——门控调用方按 fail-closed 处理，不能因探针失败暴露写入口。
 */
export async function fetchEnterpriseMeta(): Promise<EnterpriseMeta | null> {
  try {
    return await apiFetch<EnterpriseMeta>("/api/v1/meta");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) return null;
    return null;
  }
}

export interface VisibleScopeQuery {
  userId?: string;
  /** 逗号串，如 "r,u"。 */
  actions?: string;
  /** 逗号串，如 "table,doc"。 */
  kinds?: string;
  budget?: number;
}

export const AuthzApi = {
  /** 节点策略管理视图（direct 可编辑 + ancestors cutoff 链只读摘要）。 */
  getNodePolicies: (id: string) =>
    apiFetch<NodePoliciesViewDTO>(`/api/v1/nodes/${id}/policies`),
  /** 整单替换（upserts/deletes）；后端整单校验，任一 4xx 全拒、不局部生效。 */
  putNodePolicies: (id: string, body: PolicyWriteRequestDTO) =>
    apiFetch<PolicyWriteResultDTO>(`/api/v1/nodes/${id}/policies`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** 有效权限来源链（缺省查本人；查他人需节点 manage_share，403 时前端隐入口）。 */
  getEffective: (id: string, userId?: string) =>
    apiFetch<EffectiveViewDTO>(`/api/v1/nodes/${id}/effective${qs({ userId })}`),
  /** 可见集诊断（查他人仅 workspace owner 放行；manage_share 直授也 403）。 */
  getVisibleScope: (params: VisibleScopeQuery = {}) =>
    apiFetch<VisibleScopeDTO>(
      `/api/v1/authz/visible-scope${qs({
        userId: params.userId,
        actions: params.actions,
        kinds: params.kinds,
        budget: params.budget,
      })}`,
    ),
  /** 继承切换影响面预览；value 为目标 inheritAncestors（0/1），items 按 userId 字典序分页。 */
  getInheritanceImpact: (id: string, value: boolean, limit?: number, offset?: number) =>
    apiFetch<InheritanceImpactDTO>(
      `/api/v1/nodes/${id}/inheritance/impact${qs({
        value: value ? 1 : 0,
        limit,
        offset,
      })}`,
    ),
  /** 切换继承；confirmed=false 首次会 409 INHERITANCE_CONFIRM_REQUIRED 并附 impact。 */
  patchInheritance: (id: string, value: boolean, confirmed: boolean) =>
    apiFetch<InheritanceChangeResultDTO>(`/api/v1/nodes/${id}/inheritance`, {
      method: "PATCH",
      body: JSON.stringify({ value, confirmed }),
    }),
  /** 中性化面包屑（on 态已截无权祖先；truncatedAbove=true 时链首渲染截断标记）。 */
  getBreadcrumb: (id: string) =>
    apiFetch<NodeBreadcrumbDTO>(`/api/v1/nodes/${id}/breadcrumb`),
};

// ============ M5 统一检索 /api/v1/*（GX_M5_SEARCH=on|shadow 挂载；off 落 v1 自身 404） ============
//
// 与 M3 nav 同一套 flag 回退风格：v1 端点 off 时返回 404（{code:"NOT_FOUND"}），
// 由数据适配层 search-adapter 捕获后回退旧 /api/search，组件不感知差异。
// 管理面（/admin/*）仅 role_owner 可访问，403 由设置面板静默降级为不可见。

export const SearchV1Api = {
  /** 统一检索（record/doc/canvas + auto/vector/fts）。off 时 404，调用方回退旧链。 */
  search: (params: V1SearchQuery) =>
    apiFetch<V1SearchResponse>(
      `/api/v1/search${qs({
        q: params.q,
        type: params.type,
        mode: params.mode,
        limit: params.limit,
      })}`,
    ),
  /** 以图搜图：POST JSON body（含 data:image 图片），响应与 GET 同契约。 */
  searchByImage: (body: V1SearchPostBody) =>
    apiFetch<V1SearchResponse>("/api/v1/search", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const EmbeddingAdminApi = {
  /** 读嵌入配置（apiKey 仅存在性 + 末 4，role_owner）。 */
  getConfig: () => apiFetch<EmbeddingConfigDTO>("/api/v1/admin/embedding/config"),
  /** 改配置；off->cloud 缺 confirmCloud 时后端 409 NEED_CLOUD_CONFIRM。 */
  patchConfig: (patch: EmbeddingConfigPatch) =>
    apiFetch<EmbeddingConfigPatchResult>("/api/v1/admin/embedding/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** 轮换 db 嵌入 key（AES-GCM 落库），回存在性形状。 */
  rotateApiKey: (apiKey: string) =>
    apiFetch<EmbeddingApiKeyStatus>("/api/v1/admin/embedding/api-key/rotate", {
      method: "POST",
      body: JSON.stringify({ apiKey } satisfies ApiKeyRotateRequest),
    }),
  /** 清除 db 嵌入 key（随后回落 env 种子或 none），204 无体，需容忍空响应。 */
  clearApiKey: async () => {
    // S2：跟数据源；Bearer 风格为历史既有，仅把 token/URL 改读 resolver，保留头风格（golden）。
    const token = dataSourceResolver.current().token;
    const res = await fetch(dataSourceResolver.baseFor("/api/v1/admin/embedding/api-key"), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body);
    }
  },
  /** 连通性自检：按已保存配置探活，不落库、不回凭据（200 本体带 ok 字段）。 */
  testConnection: () =>
    apiFetch<EmbeddingConnectionTestResult>("/api/v1/admin/embedding/test-connection", {
      method: "POST",
      body: "{}",
    }),
  /** 触发重建索引（异步，202）；进行中再调 409 REINDEX_IN_PROGRESS。 */
  reindex: (body: ReindexRequest = {}) =>
    apiFetch<ReindexStarted>("/api/v1/admin/reindex", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** 检索子系统状态（覆盖度/积压/chunks/embedding 健康）。 */
  status: () => apiFetch<SearchStatusDTO>("/api/v1/admin/search/status"),
};

// ============ M6 PAT 访问令牌 /api/v1/pats（GX_ENTERPRISE_ORG 门控；本人限定） ============
//
// 形状对齐后端 routes/v1/pats.ts + mcp/pat/patService.ts（PatMetadata）；契约见 M6-implementation-plan §5.2/§6/C-3。
//   POST   /api/v1/pats        -> 201 { id, name, scopes, token(仅此一次), tokenPrefix, expiresAt, createdAt }
//   GET    /api/v1/pats        -> 200 PatMetadata[]（绝无 token/tokenHash；tokenPrefix 仅前 14 字符）
//   DELETE /api/v1/pats/:id    -> 204（非本人/不存在统一 404 PAT_NOT_FOUND；超限 429 MCP_RATE_LIMITED + Retry-After）
// 门控纪律：/api/v1/pats 与 /mcp 同受 GX_ENTERPRISE_ORG；off 即 404，调用方按 fail-closed 隐入口。
// 鉴权语义（P3）：令牌只做「认证 + 有效期」，**能力按签发者账号实时计算**（与 Web 端 X-GX-Token
//   会话同口径）；scopes 仍随令牌返回（老数据兼容），但界面既不勾选也不据此说明权限。
// 类型位置：M6-FE 片只在 apps/web 工作，故 DTO 定义为前端本地契约；后端 openapi 冻结后如需可上提 @gx/shared-types。

/** scope 六位（C-2 定稿）。 */
export type PatScope =
  | "record:read"
  | "record:write"
  | "doc:read"
  | "doc:write"
  | "canvas:read"
  | "canvas:write";

/** 列表/元数据（绝不含明文或 hash）。 */
export interface PatMetadata {
  id: string;
  name: string;
  /** 明文前 14 字符，仅辨识用（不可认证）。 */
  tokenPrefix: string;
  scopes: PatScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** 创建响应：多一枚 `token`（**仅此一次**，前端只在一次性弹窗内呈现，绝不落 storage/URL）。 */
export interface CreatedPat {
  id: string;
  name: string;
  scopes: PatScope[];
  token: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

/** 创建入参：expiresInDays 为 30/90/365 或 null（永不过期）。 */
export interface CreatePatInput {
  name: string;
  /**
   * 可选：P3 起令牌只做「认证 + 有效期」，能力按签发者账号实时计算，界面不再勾选权限范围。
   * 保留该字段只为老客户端兼容（显式传了后端仍按原规则校验）；缺省即不传。
   */
  scopes?: PatScope[];
  expiresInDays: 30 | 90 | 365 | null;
}

export const PatsApi = {
  /** 本人全部令牌（已吊销行也在列表内，前端按状态置灰）。 */
  list: () => apiFetch<PatMetadata[]>("/api/v1/pats"),
  /** 签发一枚令牌；响应的 token 仅此一次。 */
  create: (input: CreatePatInput) =>
    apiFetch<CreatedPat>("/api/v1/pats", { method: "POST", body: JSON.stringify(input) }),
  /** 吊销（204 无体，容忍空响应；本人限定；429 请尊重 Retry-After，勿自动重试）。 */
  revoke: async (id: string): Promise<void> => {
    // S2：跟当前数据源（X-GX-Token 头不变，local 逐字节等价）。
    const res = await fetch(
      dataSourceResolver.baseFor(`/api/v1/pats/${encodeURIComponent(id)}`),
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...dataSourceResolver.headers(),
        },
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body, parseRetryAfter(res.headers.get("Retry-After")));
    }
  },
};

// ============ 应用更新 /api/v1/admin/update（GX_UPDATE_ENABLED 门控；role_owner） ============
//
// 两段式下载（DESIGN §6.2/§6.3）：status / download-ticket 走 apiFetch（JWT + JSON + 统一超时）；
// 真正的文件下载不经 fetch——createDownloadTicket 拿到 downloadPath 后由调用方拼 withBase()
// 交 window.location 原生导航（浏览器带不了 X-GX-Token 头，下载端点只验 HMAC 票）。

export interface UpdateDownloadTicket {
  ticket: string;
  expiresAt: string;
  downloadPath: string;
}

/**
 * 方案 A：POST /admin/update/prefetch 响应。
 * decision 与后端 prefetcher.start 的四种结果逐字对齐；HTTP 202（started/running）/
 * 200（ready）/409（busy 或当前无可预缓存更新）。
 */
export interface UpdatePrefetchStart {
  decision: "started" | "running" | "ready" | "busy";
  prefetch: UpdatePrefetchDTO;
}

export const AdminUpdateApi = {
  /** 检查更新（owner）。默认走后端 5 分钟 TTL 缓存；force=true 旁路缓存（?force=1）。 */
  status: (params?: { channel?: string; arch?: string; platform?: string; force?: boolean }) =>
    apiFetch<UpdateStatusDTO>(
      `/api/v1/admin/update/status${qs({
        channel: params?.channel,
        arch: params?.arch,
        platform: params?.platform,
        force: params?.force ? "1" : undefined,
      })}`,
      { timeoutMs: 15_000 },
    ),
  /** 第一段：现场重算后换 120s 下载票。body 可空（服务端自识别通道）。 */
  createDownloadTicket: (body: { channel?: string; arch?: string; platform?: string } = {}) =>
    apiFetch<UpdateDownloadTicket>("/api/v1/admin/update/download-ticket", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  /**
   * 方案 A：owner 触发后端【后台】分块预拉更新包到 NAS 本地。202 即已受理，真正进度
   * 靠随后的 status 轮询（prefetch 快照）反映；body 可空（服务端自识别通道）。
   */
  startPrefetch: (body: { channel?: string; arch?: string; platform?: string } = {}) =>
    apiFetch<UpdatePrefetchStart>("/api/v1/admin/update/prefetch", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
};


// ============ Branding（品牌外观：匿名读 + 管理员写，0.2.4-rc） ============
//
// GET  /api/auth/branding        匿名公开（fail-closed 永返默认 DTO，不会 401）
// GET  /api/admin/branding       登录 + 超管/管理员
// PATCH /api/admin/branding      改名/版权（至少一键）
// POST  /api/admin/branding/hero multipart 字段名 file（jpg/png/webp，≤5MB）
// DELETE /api/admin/branding/hero 恢复内置默认图
//
// 上传不能走 apiFetch：它强制注入 Content-Type: application/json（见上方 apiFetch），
// multipart 请求必须让浏览器自行带 boundary，故手写 fetch；鉴权头由 dataSourceResolver.headers()
// 统一给 X-GX-Token（local 下等价旧 authHeaders），不要照抄 Auth.uploadAvatar 的 Authorization
// 写法——那是飞牛网关踩坑前的旧代码（见 api/authHeader.ts 头注释）。
export const Branding = {
  /** 匿名读公开品牌配置（产品名/版权/广告图）。 */
  publicConfig: () => apiFetch<BrandingConfigDTO>("/api/auth/branding"),
  /** 管理员读当前品牌配置（含与公开口同形状的 DTO；后端在此口做角色校验）。 */
  adminConfig: () => apiFetch<BrandingConfigDTO>("/api/admin/branding"),
  /** 改产品名/版权；空对象后端 400「没有需要更新的字段」。 */
  update: (data: BrandingUpdateInput) =>
    apiFetch<BrandingConfigDTO>("/api/admin/branding", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  /** 上传登录广告图（multipart，字段名 file）；返回保存后的最新 DTO。 */
  uploadHero: async (file: File): Promise<BrandingConfigDTO> => {
    const fd = new FormData();
    fd.append("file", file);
    // S2：跟当前数据源（local 逐字节等价）；不设 Content-Type，由浏览器带 multipart boundary。
    const res = await fetch(dataSourceResolver.baseFor("/api/admin/branding/hero"), {
      method: "POST",
      // 注意：不设 Content-Type，由浏览器带 multipart/form-data; boundary=...
      headers: dataSourceResolver.headers(),
      body: fd,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body);
    }
    return (await res.json()) as BrandingConfigDTO;
  },
  /** 恢复内置默认广告图；返回最新 DTO。 */
  resetHero: () =>
    apiFetch<BrandingConfigDTO>("/api/admin/branding/hero", { method: "DELETE" }),
};

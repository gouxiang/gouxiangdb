// apps/web/src/features/detail/form-versioning/useLayoutVersions.ts
// 表单布局版本的 TanStack Query 层：列表 / 单份 / 手动建版。
//
// 网络一律走 apps/web/src/api/client.ts 的 apiFetch（带 JWT 注入、401 处理、超时），
// 本文件不出现裸 fetch。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, Views, WRITE_TIMEOUT_MS } from "../../../api/client";
import { QK } from "../../../api/hooks";
import type { DetailLayout, TabConfig } from "@gx/shared-types";
import {
  parseSnapshot,
  sortVersionsDesc,
  type LayoutVersionDetail,
  type LayoutVersionSummary,
  type TabsSnapshotWire,
} from "./versioning";

export const layoutVersionKeys = {
  all: ["layout-versions"] as const,
  list: (viewId: string) => ["layout-versions", viewId] as const,
  detail: (viewId: string, versionRowId: string) => ["layout-versions", viewId, versionRowId] as const,
};

// ============ 端点 ============
// 三个端点跟随现有 /api/views 族，**没有 v1 前缀**。

interface RawSummary {
  id?: unknown;
  viewId?: unknown;
  version?: unknown;
  label?: unknown;
  createdBy?: unknown;
  createdAt?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toSummary(r: RawSummary): LayoutVersionSummary {
  // createdBy：DTO 里是非空 string，缺失归一成空串（UI 不展示作者，只用于判空）
  return {
    id: str(r.id),
    viewId: str(r.viewId),
    version: num(r.version),
    label: strOrNull(r.label),
    createdBy: str(r.createdBy),
    createdAt: str(r.createdAt),
  };
}

/**
 * 单份响应体的解包。后端 routes/layoutVersions.ts 的口径：
 *   GET  /:id -> `{ version: { ...meta, snapshot } }`，snapshot 已被 JSON.parse 成对象
 *   POST      -> `{ version: { ...meta } }`（不带 snapshot）
 * 这里同时兜住 `item` 与裸对象两种历史形状，取不到就当解析失败（UI 会禁用回退，不静默降级）。
 */
function toDetail(res: unknown): LayoutVersionDetail | null {
  const box = (res && typeof res === "object" ? res : null) as Record<string, unknown> | null;
  if (!box) return null;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  // 注意：meta 自身也有一个数字 `version` 字段，故只有当 box.version 是**对象**时才当信封外壳用。
  const raw = (isObj(box.version) ? box.version : isObj(box.item) ? box.item : box) as RawSummary & { snapshot?: unknown };
  if (typeof raw.id !== "string") return null;
  // 快照可能是对象（后端已 parse）也可能是字符串（历史形状）；统一按字符串存，由 parseSnapshot 归一。
  const snap = raw.snapshot;
  return { ...toSummary(raw), snapshot: typeof snap === "string" ? snap : JSON.stringify(snap ?? null) };
}

/** 手动留档的入参。snapshot 只发后端认的两个键（版本号由服务端分配成 max+1）。 */
export interface CreateLayoutVersionInput {
  // tabs 已定死为结构化信封：容器字段 id -> { cards, lazyTouched, tabs?: TabConfig[] }
  snapshot: { layout: DetailLayout | null; tabs?: Record<string, TabsSnapshotWire> | null };
  label?: string;
}

/** 详情布局一次事务保存的入参（layout + tabs 同生共死，不留半回滚窗口）。 */
export interface SaveDetailLayoutInput {
  detailLayout: DetailLayout | null;
  tabs: Record<string, TabConfig[]>;
}

export const LayoutVersionsApi = {
  list: (viewId: string) =>
    apiFetch<{ items?: RawSummary[] }>(`/api/views/${encodeURIComponent(viewId)}/layout-versions`).then((r) =>
      sortVersionsDesc((r.items ?? []).map(toSummary)),
    ),
  get: (viewId: string, versionRowId: string) =>
    apiFetch<unknown>(`/api/views/${encodeURIComponent(viewId)}/layout-versions/${encodeURIComponent(versionRowId)}`).then(toDetail),
  create: (viewId: string, body: CreateLayoutVersionInput) =>
    apiFetch<unknown>(`/api/views/${encodeURIComponent(viewId)}/layout-versions`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: WRITE_TIMEOUT_MS,
    }).then(toDetail),
};

// ============ hooks ============

/** 版本列表（按 version 倒序）。viewId 为空时不发请求。 */
export function useLayoutVersions(viewId: string | null | undefined) {
  return useQuery({
    queryKey: layoutVersionKeys.list(viewId ?? ""),
    queryFn: () => LayoutVersionsApi.list(viewId!),
    enabled: !!viewId,
  });
}

/** 单份版本 + 已解析的快照。versionRowId 为空时不发请求。 */
export function useLayoutVersion(viewId: string | null | undefined, versionRowId: string | null) {
  return useQuery({
    queryKey: layoutVersionKeys.detail(viewId ?? "", versionRowId ?? ""),
    queryFn: () => LayoutVersionsApi.get(viewId!, versionRowId!),
    enabled: !!viewId && !!versionRowId,
    select: (d: LayoutVersionDetail | null) => ({
      detail: d,
      snapshot: d ? parseSnapshot(d.snapshot) : null,
    }),
  });
}

/** 手动建版：成功后失效列表，让新版本立刻出现在历史里。 */
export function useCreateLayoutVersion(viewId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLayoutVersionInput) => LayoutVersionsApi.create(viewId!, body),
    onSuccess: () => {
      if (!viewId) return;
      void qc.invalidateQueries({ queryKey: layoutVersionKeys.list(viewId) });
    },
  });
}

/**
 * 详情布局「一次事务」保存。
 *
 * 取代前端串行的 `PATCH /api/views/:id` + N 个 `PATCH /api/fields/:id`：那串请求中途失败
 * 会留下半回滚状态（布局回去了、选项卡没回去），比完全不保存更糟。事务端点把窗口关掉，
 * 写完由服务端统一触发自动留档，这里只负责失效缓存。
 *
 * 响应里的 `removedFieldIds` 不在这里消费：缓存失效是无差别刷新，而「有字段被剔除了」
 * 是一次性的、必须被用户看见的信息，由调用方（FormDesigner）读返回值 toast 出来。
 */
export function useSaveDetailLayout(viewId: string | null | undefined, tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveDetailLayoutInput) => Views.saveDetailLayout(viewId!, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QK.views(tableId) });
      void qc.invalidateQueries({ queryKey: QK.fields(tableId) });
      if (viewId) void qc.invalidateQueries({ queryKey: layoutVersionKeys.list(viewId) });
    },
  });
}

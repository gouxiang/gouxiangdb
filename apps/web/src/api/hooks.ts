// apps/web/src/api/hooks.ts
// TanStack Query hooks：统一缓存键与失效策略
//
// 约定：所有写操作成功后按「维度」失效（而不是精确 key），
// 保证 records 改动后 fields 上的 count/lookup/rollup 也会刷新。

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Auth, Bases, Tables, Fields, Records, Views, SearchApi, OrgMembers } from "./client";
import { useAuthStore } from "../store/auth";
import type {
  BaseDTO,
  TableDTO,
  FieldDTO,
  RecordDTO,
  ViewDTO,
  ViewConfig,
  ViewType,
  LockMode,
  MemberDTO,
  CommentDTO,
  ShareLinkDTO,
  Role,
  CSVImportResult,
  TrashItemDTO,
  GroupBucketDTO,
} from "@gx/shared-types";

export const QK = {
  bases: ["bases"] as const,
  base: (id: string) => ["base", id] as const,
  baseStats: (id: string) => ["base", id, "stats"] as const,
  baseErd: (id: string) => ["base", id, "erd"] as const,
  members: (baseId: string) => ["base", baseId, "members"] as const,
  shareLinks: (baseId: string) => ["base", baseId, "share"] as const,
  tables: (baseId: string) => ["tables", baseId] as const,
  fields: (tableId: string) => ["fields", tableId] as const,
  lookupTargets: (linkFieldId: string) => ["lookupTargets", linkFieldId] as const,
  relationTypes: ["relationTypes"] as const,
  records: (tableId: string, viewId?: string) => ["records", tableId, viewId ?? "default"] as const,
  record: (id: string) => ["record", id] as const,
  views: (tableId: string) => ["views", tableId] as const,
  comments: (recordId: string) => ["comments", recordId] as const,
  trash: (baseId: string) => ["trash", baseId] as const,
  search: (baseId: string, q: string) => ["search", baseId, q] as const,
  globalSearch: (q: string) => ["globalSearch", q] as const,
};

function enabledOf(v: string | null | undefined): boolean {
  return !!v;
}

type QueryClientLike = ReturnType<typeof useQueryClient>;

/**
 * 子表/关联记录变更后，按后端返回的受影响父表父记录失效父表查询：
 * 父表的公式字段是服务端实时 hydrate 的，必须重新拉取才能看到重算结果；
 * 同时失效父记录详情（详情页打开时）。
 */
function invalidateAffectedParents(
  qc: QueryClientLike,
  parents: { tableId: string; recordId: string }[],
): void {
  const tables = new Set<string>();
  for (const p of parents) {
    tables.add(p.tableId);
    void qc.invalidateQueries({ queryKey: QK.record(p.recordId) });
  }
  for (const tableId of tables) {
    void qc.invalidateQueries({ queryKey: ["records", tableId] });
  }
}

// ============ Auth ============

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => (await Auth.me()).user,
    retry: false,
  });
}

/**
 * 建库 / 建知识库权限门：当前登录者是否持有 create_library 动作。
 *
 * queryKey 用字面量 ["org","me","effective-roles"]，与 features/contacts/contacts-hooks.ts
 * 的 ORG_QK.myEffectiveRoles 同键——两处共享同一份缓存，不新增请求。
 * 这里不 import contacts-hooks：api 层不反向依赖 features 层。
 *
 * 默认拒绝：加载中 / 请求失败 / 数据缺失一律 false。宁可暂时不渲染建库入口，
 * 也不能让无权限用户看见按钮（后端 assertCanCreateLibrary 同步门控 403）。
 */
export function useCanCreateLibrary(): boolean {
  const query = useQuery({
    queryKey: ["org", "me", "effective-roles"],
    queryFn: async () => (await OrgMembers.myEffectiveRoles()).roles,
    staleTime: 60_000,
    retry: false,
  });
  if (query.isLoading || query.isError || !query.data) return false;
  return query.data.some((r) => r.actions.includes("create_library"));
}

/** 个人中心 — 更新昵称/用户名/手机/简介 */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Parameters<typeof Auth.updateMe>[0]) =>
      (await Auth.updateMe(patch)).user,
    onSuccess: (user) => {
      // 1) 同步 auth store（顶栏 / 抽屉显示）
      useAuthStore.getState().updateUser(user);
      // 2) 失效 useMe 的 query（其它组件读 useMe 的会刷新）
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/** 个人中心 — 修改密码 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      Auth.changePassword(data),
  });
}

/** 个人中心 — 上传头像（multipart） */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => Auth.uploadAvatar(file),
    onSuccess: (res) => {
      useAuthStore.getState().updateUser(res.user);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/** 个人中心 — 移除头像 */
export function useRemoveAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => Auth.removeAvatar(),
    onSuccess: (res) => {
      useAuthStore.getState().updateUser(res.user);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/** 个人中心 — 注销账号 */
export function useDeleteMe() {
  return useMutation({
    mutationFn: (data: { password: string }) => Auth.deleteMe({ confirm: true, password: data.password }),
  });
}

// ============ Bases ============

export function useBases(): UseQueryResult<BaseDTO[]> {
  return useQuery({
    queryKey: QK.bases,
    queryFn: async () => (await Bases.list()).bases,
  });
}

export function useBase(baseId: string | null): UseQueryResult<BaseDTO> {
  return useQuery({
    queryKey: QK.base(baseId ?? ""),
    queryFn: async () => (await Bases.get(baseId!)).base,
    enabled: enabledOf(baseId),
  });
}

export function useBaseStats(baseId: string | null) {
  return useQuery({
    queryKey: QK.baseStats(baseId ?? ""),
    queryFn: async () => (await Bases.stats(baseId!)).stats,
    enabled: enabledOf(baseId),
  });
}

export function useBaseErd(baseId: string | null) {
  return useQuery({
    queryKey: QK.baseErd(baseId ?? ""),
    queryFn: async () => Bases.erd(baseId!),
    enabled: enabledOf(baseId),
  });
}

// ============ Tables ============

export function useTables(baseId: string | null): UseQueryResult<TableDTO[]> {
  return useQuery({
    queryKey: QK.tables(baseId ?? ""),
    queryFn: async () => (await Tables.list(baseId!)).tables,
    enabled: enabledOf(baseId),
  });
}

// ============ Fields ============

export function useFields(tableId: string | null): UseQueryResult<FieldDTO[]> {
  return useQuery({
    queryKey: QK.fields(tableId ?? ""),
    queryFn: async () => (await Fields.list(tableId!)).fields,
    enabled: enabledOf(tableId),
  });
}

export function useLookupTargets(linkFieldId: string | null): UseQueryResult<FieldDTO[]> {
  return useQuery({
    queryKey: QK.lookupTargets(linkFieldId ?? ""),
    queryFn: async () => (await Fields.lookupTargets(linkFieldId!)).fields,
    enabled: enabledOf(linkFieldId),
  });
}

export function useRelationTypes() {
  return useQuery({
    queryKey: QK.relationTypes,
    queryFn: async () => (await Fields.relationTypes()).relationTypes,
    staleTime: Infinity,
  });
}

// ============ Records ============

export interface UseRecordsParams {
  tableId: string | null;
  viewId?: string;
  limit?: number;
  offset?: number;
  search?: string;
  /** S7 keyset 游标（分页 hook 在 records-paging-hooks.ts 管理，直接用本 hook 的场景一般不传）。 */
  cursor?: string;
}

export interface RecordsResult {
  records: RecordDTO[];
  total: number;
  filteredTotal: number;
  fields: FieldDTO[];
  allFields: FieldDTO[];
  groups: GroupBucketDTO[] | null;
  aggregations: Record<string, number | null> | null;
  // S7 additive 三键：仅服务端 keyset 开启时出现，缺省即「未开启」（能力探测依据）。
  nextCursor?: string | null;
  hasMore?: boolean;
  degraded?: string[];
}

export function useRecords(params: UseRecordsParams): UseQueryResult<RecordsResult> {
  const { tableId, viewId, limit, offset, search, cursor } = params;
  return useQuery({
    queryKey: QK.records(tableId ?? "", viewId),
    queryFn: async () => await Records.list({ tableId: tableId!, viewId, limit, offset, search, cursor }),
    enabled: enabledOf(tableId),
  });
}

export function useRecord(recordId: string | null) {
  return useQuery({
    queryKey: QK.record(recordId ?? ""),
    queryFn: async () => await Records.get(recordId!),
    enabled: enabledOf(recordId),
  });
}

// ============ Views ============

export function useViews(tableId: string | null): UseQueryResult<ViewDTO[]> {
  return useQuery({
    queryKey: QK.views(tableId ?? ""),
    queryFn: async () => (await Views.list(tableId!)).views,
    enabled: enabledOf(tableId),
  });
}

// ============ Members / Share / Trash ============

export function useMembers(baseId: string | null): UseQueryResult<MemberDTO[]> {
  return useQuery({
    queryKey: QK.members(baseId ?? ""),
    queryFn: async () => (await Bases.members(baseId!)).members,
    enabled: enabledOf(baseId),
  });
}

export function useShareLinks(baseId: string | null): UseQueryResult<ShareLinkDTO[]> {
  return useQuery({
    queryKey: QK.shareLinks(baseId ?? ""),
    queryFn: async () => (await Bases.shareLinks(baseId!)).links,
    enabled: enabledOf(baseId),
  });
}

export function useTrash(baseId: string | null): UseQueryResult<TrashItemDTO[]> {
  return useQuery({
    queryKey: QK.trash(baseId ?? ""),
    queryFn: async () => (await Records.trash(baseId!)).items,
    enabled: enabledOf(baseId),
  });
}

export function useComments(recordId: string | null): UseQueryResult<CommentDTO[]> {
  return useQuery({
    queryKey: QK.comments(recordId ?? ""),
    queryFn: async () => (await Records.comments(recordId!)).comments,
    enabled: enabledOf(recordId),
  });
}

export function useSearch(baseId: string | null, q: string) {
  return useQuery({
    queryKey: QK.search(baseId ?? "", q),
    queryFn: async () => (await Records.search(baseId!, q)).results,
    enabled: enabledOf(baseId) && q.trim().length > 0,
  });
}

/** 全局统一搜索：跨所有可访问的表格记录 + 知识库文档/画布 */
export function useGlobalSearch(q: string) {
  return useQuery({
    queryKey: QK.globalSearch(q),
    queryFn: async () => await SearchApi.global(q.trim()),
    enabled: q.trim().length > 0,
    staleTime: 5_000,
  });
}

// ============ Mutations ============

/**
 * 统一 mutation 工厂：
 * - 成功后按维度失效相关缓存
 * - records 相关改动会连带失效 fields（因为 count/lookup/rollup/formula 是服务端现算）
 */
export function useGXMutations() {
  const qc = useQueryClient();

  const invalidateAll = (baseId?: string | null) => {
    void qc.invalidateQueries({ queryKey: ["bases"] });
    if (baseId) {
      void qc.invalidateQueries({ queryKey: ["base", baseId] });
      void qc.invalidateQueries({ queryKey: ["tables", baseId] });
      void qc.invalidateQueries({ queryKey: ["trash", baseId] });
    }
  };

  const invalidateTable = (tableId: string, viewId?: string) => {
    void qc.invalidateQueries({ queryKey: ["fields", tableId] });
    void qc.invalidateQueries({ queryKey: ["views", tableId] });
    if (viewId) {
      void qc.invalidateQueries({ queryKey: ["records", tableId, viewId] });
    }
    void qc.invalidateQueries({ queryKey: ["records", tableId] });
    void qc.invalidateQueries({ queryKey: ["lookupTargets"] });
  };

  return {
    // --- base ---
    createBase: useMutation({
      mutationFn: async (data: { name: string; iconColor?: string }) => (await Bases.create(data)).base,
      onSuccess: () => invalidateAll(),
    }),
    updateBase: useMutation({
      mutationFn: async (p: {
        baseId: string;
        // iconColor 允许 null：语义为「恢复默认色」（后端对 NOT NULL 的 Base.iconColor 列做三态映射），
        // 缺省 undefined 才是「不改动这一列」。
        data: { name?: string; iconColor?: string | null; icon?: string | null };
      }) => (await Bases.update(p.baseId, p.data)).base,
      onSuccess: (_d, v) => invalidateAll(v.baseId),
    }),
    deleteBase: useMutation({
      mutationFn: async (baseId: string) => await Bases.remove(baseId),
      onSuccess: () => invalidateAll(),
    }),

    // --- table ---
    createTable: useMutation({
      mutationFn: async (p: { baseId: string; name: string; withDefaults?: boolean }) =>
        (await Tables.create(p.baseId, { name: p.name, withDefaults: p.withDefaults })).table,
      onSuccess: (_d, v) => invalidateAll(v.baseId),
    }),
    updateTable: useMutation({
      mutationFn: async (p: {
        tableId: string;
        data: { name?: string; primaryFieldId?: string; icon?: string | null; iconColor?: string | null };
      }) => (await Tables.update(p.tableId, p.data)).table,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["tables"] }),
    }),
    deleteTable: useMutation({
      mutationFn: async (p: { tableId: string; baseId: string }) => {
        await Tables.remove(p.tableId);
        return p;
      },
      onSuccess: (_d, v) => invalidateAll(v.baseId),
    }),
    duplicateTable: useMutation({
      mutationFn: async (p: { tableId: string; name?: string; withData?: boolean }) =>
        (await Tables.duplicate(p.tableId, { name: p.name, withData: p.withData })).table,
      // 改：补失效 ["tables"]（与 updateTable 同一口径）。此前只有 invalidateAll() 不带
      // baseId，实际只失效了 ["bases"]，而库下表列表的 queryKey 是 ["tables", baseId] ——
      // 表现为「服务端已复制成功，但列表不出现副本，刷新才有」。复制表回挂到 L2 行菜单后，
      // 这个缓存洞在真机上直接可见，故补齐。（服务端 duplicate 只回部分字段、不含 baseId，
      // 拿不到 baseId，按表列表前缀失效即可。）
      onSuccess: () => {
        invalidateAll();
        void qc.invalidateQueries({ queryKey: ["tables"] });
      },
    }),
    clearTable: useMutation({
      mutationFn: async (p: { tableId: string; viewId?: string }) => {
        await Tables.clear(p.tableId);
        return p;
      },
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),

    // --- field ---
    createField: useMutation({
      mutationFn: async (p: { tableId: string; data: Record<string, unknown>; viewId?: string }) =>
        await Fields.create(p.tableId, p.data),
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),
    updateField: useMutation({
      mutationFn: async (p: { fieldId: string; data: Record<string, unknown>; tableId: string; viewId?: string }) =>
        (await Fields.update(p.fieldId, p.data)).field,
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),
    deleteField: useMutation({
      mutationFn: async (p: { fieldId: string; tableId: string; viewId?: string }) =>
        await Fields.remove(p.fieldId),
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),
    moveField: useMutation({
      mutationFn: async (p: { fieldId: string; toIndex: number; tableId: string; viewId?: string }) =>
        (await Fields.move(p.fieldId, p.toIndex)).fields,
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),

    // --- record ---
    createRecord: useMutation({
      mutationFn: async (p: {
        tableId: string;
        fields?: Record<string, unknown>;
        viewId?: string;
        draft?: boolean;
      }) => await Records.create(p.tableId, { fields: p.fields, draft: p.draft }),
      onSuccess: (d, v) => {
        invalidateTable(v.tableId, v.viewId);
        invalidateAffectedParents(qc, d?.affectedParents ?? []);
      },
    }),
    updateRecord: useMutation({
      mutationFn: async (p: {
        recordId: string;
        fields: Record<string, unknown>;
        tableId: string;
        viewId?: string;
      }) => await Records.update(p.recordId, { fields: p.fields }),
      onSuccess: (d, v) => {
        invalidateTable(v.tableId, v.viewId);
        void qc.invalidateQueries({ queryKey: QK.record(v.recordId) });
        invalidateAffectedParents(qc, d?.affectedParents ?? []);
      },
    }),
    deleteRecord: useMutation({
      mutationFn: async (p: { recordId: string; tableId: string; viewId?: string }) =>
        await Records.remove(p.recordId),
      onSuccess: (d, v) => {
        invalidateTable(v.tableId, v.viewId);
        invalidateAffectedParents(qc, d?.affectedParents ?? []);
      },
    }),
    bulkDeleteRecords: useMutation({
      mutationFn: async (p: { ids: string[]; tableId: string; viewId?: string }) =>
        await Records.bulkDelete(p.ids),
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),
    bulkUpdateRecords: useMutation({
      mutationFn: async (p: { ids: string[]; fields: Record<string, unknown>; tableId: string; viewId?: string }) =>
        await Records.bulkUpdate(p.ids, p.fields),
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),
    csvImport: useMutation({
      mutationFn: async (p: {
        tableId: string;
        csv: string;
        hasHeader: boolean;
        mapping?: Record<string, string | null>;
        viewId?: string;
      }): Promise<CSVImportResult> =>
        (await Records.csvImport(p.tableId, { csv: p.csv, hasHeader: p.hasHeader, mapping: p.mapping })).result,
      onSuccess: (_d, v) => invalidateTable(v.tableId, v.viewId),
    }),

    // --- view ---
    createView: useMutation({
      mutationFn: async (p: { tableId: string; name: string; type: ViewType; config?: Partial<ViewConfig> }) =>
        (await Views.create(p.tableId, { name: p.name, type: p.type, config: p.config })).view,
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: ["views", v.tableId] }),
    }),
    updateView: useMutation({
      mutationFn: async (p: {
        viewId: string;
        tableId: string;
        data: { name?: string; lockMode?: LockMode; order?: number; config?: Partial<ViewConfig> };
      }) => (await Views.update(p.viewId, p.data)).view,
      onSuccess: (_d, v) => {
        void qc.invalidateQueries({ queryKey: ["views", v.tableId] });
        void qc.invalidateQueries({ queryKey: ["records", v.tableId] });
      },
    }),
    deleteView: useMutation({
      mutationFn: async (p: { viewId: string; tableId: string }) => await Views.remove(p.viewId),
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: ["views", v.tableId] }),
    }),
    duplicateView: useMutation({
      mutationFn: async (p: { viewId: string; tableId: string }) => (await Views.duplicate(p.viewId)).view,
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: ["views", v.tableId] }),
    }),

    // --- members / share ---
    inviteMember: useMutation({
      mutationFn: async (p: { baseId: string; email: string; role: Role }) =>
        (await Bases.invite(p.baseId, { email: p.email, role: p.role })).member,
      onSuccess: (_d, v) => {
        void qc.invalidateQueries({ queryKey: QK.members(v.baseId) });
        void qc.invalidateQueries({ queryKey: QK.baseStats(v.baseId) });
      },
    }),
    updateMember: useMutation({
      mutationFn: async (p: { baseId: string; memberId: string; role: Role }) =>
        (await Bases.updateMember(p.baseId, p.memberId, { role: p.role })).member,
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.members(v.baseId) }),
    }),
    removeMember: useMutation({
      mutationFn: async (p: { baseId: string; memberId: string }) =>
        await Bases.removeMember(p.baseId, p.memberId),
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.members(v.baseId) }),
    }),
    createShareLink: useMutation({
      mutationFn: async (p: { baseId: string; role: "editor" | "commenter" | "viewer" }) =>
        (await Bases.createShareLink(p.baseId, { role: p.role })).link,
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.shareLinks(v.baseId) }),
    }),
    removeShareLink: useMutation({
      mutationFn: async (p: { baseId: string; linkId: string }) => await Bases.removeShareLink(p.baseId, p.linkId),
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.shareLinks(v.baseId) }),
    }),

    // --- comments ---
    addComment: useMutation({
      mutationFn: async (p: { recordId: string; body: string }) =>
        (await Records.addComment(p.recordId, p.body)).comment,
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.comments(v.recordId) }),
    }),
    removeComment: useMutation({
      mutationFn: async (p: { commentId: string; recordId: string }) =>
        await Records.removeComment(p.commentId),
      onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: QK.comments(v.recordId) }),
    }),

    // --- trash ---
    restoreTrash: useMutation({
      mutationFn: async (p: { id: string; kind: "record" | "table" | "field"; baseId: string }) =>
        await Records.restore(p.id, p.kind),
      onSuccess: (_d, v) => invalidateAll(v.baseId),
    }),
    purgeTrash: useMutation({
      mutationFn: async (p: { id: string; kind: "record" | "table" | "field"; baseId: string }) =>
        await Records.purge(p.id, p.kind),
      onSuccess: (_d, v) => invalidateAll(v.baseId),
    }),
  };
}

export type GXMutations = ReturnType<typeof useGXMutations>;

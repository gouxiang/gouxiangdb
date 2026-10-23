// apps/web/src/api/hooks.ts
// TanStack Query hooks：统一缓存键与失效策略
//
// 约定：所有写操作成功后按「维度」失效（而不是精确 key），
// 保证 records 改动后 fields 上的 count/lookup/rollup 也会刷新。

import type {
  LibraryKind,
  LibraryVisibilityResponse,
  PutLibraryScopeInput,
  RoleLibraryScopeDTO,
  UserDTO,
} from "@gx/shared-types";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  Auth,
  Bases,
  KbApi,
  Tables,
  Fields,
  Records,
  Views,
  SearchApi,
  OrgMembers,
  RoleScopes,
  ApiError,
  parseRecordChanges,
  type RecordChangeEntry,
} from "./client";
import { useAuthStore } from "../store/auth";
import { refreshActiveSourceUser } from "../node/activeAuth";
import { refreshAfterCreateBase, refreshAfterCreateTable } from "./create-refresh";

/**
 * 个人资料写成功后的会话回写（统一分流，供 useUpdateMe/useUploadAvatar/useRemoveAvatar）：
 * 活动源是远端节点（桌面壳）→ 用当前活动数据源 token + 最新 user 重写该节点会话分键
 * （commit 会触发会话/数据源通知，订阅 useActiveSession 的顶栏/抽屉即时刷新），**不**污染本地
 * gx-auth；本地源/门控关 handled=false → 维持原 updateUser 写 gx-auth，现网逐字节不变。
 * 远端无 token 理论不可达（请求刚成功），refreshActiveSourceUser fail-closed 抛错时回落本地，
 * 绝不吞掉 onSuccess。
 */
/** 导出供测试：资料写成功后按当前活动源分槽回写 user（远端会话分键 / 本地 gx-auth）。 */
export function syncActiveUser(user: UserDTO): void {
  try {
    if (refreshActiveSourceUser(user).handled) return;
  } catch {
    // 落到本地分支兜底
  }
  useAuthStore.getState().updateUser(user);
}
import type {
  BaseDTO,
  TableDTO,
  FieldDTO,
  RecordDTO,
  ViewDTO,
  ViewConfig,
  ViewAdminConfig,
  ViewUserPrefs,
  ViewType,
  LockMode,
  CommentDTO,
  CreateCommentRequest,
  ShareLinkDTO,
  CSVImportResult,
  TrashItemDTO,
  GroupBucketDTO,
} from "@gx/shared-types";

export const QK = {
  bases: ["bases"] as const,
  base: (id: string) => ["base", id] as const,
  baseStats: (id: string) => ["base", id, "stats"] as const,
  baseErd: (id: string) => ["base", id, "erd"] as const,
  shareLinks: (baseId: string) => ["base", baseId, "share"] as const,
  tables: (baseId: string) => ["tables", baseId] as const,
  fields: (tableId: string) => ["fields", tableId] as const,
  lookupTargets: (linkFieldId: string) => ["lookupTargets", linkFieldId] as const,
  relationTypes: ["relationTypes"] as const,
  // 权限核心模型（二）：角色 × 库视野。失效维度按 roleId，不按库——PUT 是整份替换。
  roleScopes: (roleId: string) => ["org", "library-scopes", roleId] as const,
  libraryVisibility: (kind: string, id: string) => ["org", "library-visibility", kind, id] as const,
  // 库设置页那份台账走 /:baseId/members（门控是「能看这个库」），与上面的组织面台账同源但缓存分开。
  libraryAccess: (kind: string, id: string) => ["library-access", kind, id] as const,
  records: (tableId: string, viewId?: string) => ["records", tableId, viewId ?? "default"] as const,
  record: (id: string) => ["record", id] as const,
  views: (tableId: string) => ["views", tableId] as const,
  comments: (recordId: string) => ["comments", recordId] as const,
  // 记录变更日志（数据日志）：与 comments 同级，按 recordId 缓存。
  recordChanges: (recordId: string) => ["recordChanges", recordId] as const,
  trash: (baseId: string) => ["trash", baseId] as const,
  search: (baseId: string, q: string) => ["search", baseId, q] as const,
  globalSearch: (q: string) => ["globalSearch", q] as const,
  // 品牌外观（0.2.4-rc）：匿名读与管理员读共用同一缓存键，管理员保存后整体失效，
  // 登录页/顶栏/公开分享页等匿名读组件立即拿到新配置（features/branding/useBranding.ts）。
  branding: ["branding"] as const,
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
 * 建库 / 建知识库权限门：当前登录者能否建库（硬规则 B：超级管理员或管理员）。
 *
 * 判据来自后端现算并随有效角色响应下发的 canCreateLibrary 布尔（shared-types
 * EffectiveRolesResponse.canCreateLibrary）——不在前端重抄一遍角色规则，杜绝口径漂移。
 * 此前这里按「是否持有 create_library 动作」判断，那是已被新模型取代的旧规则，会出现
 * 「按钮显示了但点了 403」或「超管/管理员反而看不到按钮」。
 *
 * queryKey 用字面量 ["org","me","effective-roles"]，与 features/contacts/contacts-hooks.ts 的
 * ORG_QK.myEffectiveRoles、features/settings/role-permission/role-permission-hooks.ts 的
 * useMyRoleRefs 同键——三处共享同一份缓存、同一份响应形状（都由 OrgMembers.myEffectiveRoles()
 * 的整份响应填充），不新增请求。这里不 import features：api 层不反向依赖 features 层。
 *
 * 默认拒绝：加载中 / 请求失败 / 数据缺失一律 false。宁可暂时不渲染建库入口，
 * 也不能让无权限用户看见按钮（后端 assertCanCreateLibrary 同步门控 403）。
 */
export function useCanCreateLibrary(): boolean {
  const query = useQuery({
    queryKey: ["org", "me", "effective-roles"],
    queryFn: async () => await OrgMembers.myEffectiveRoles(),
    staleTime: 60_000,
    retry: false,
  });
  return query.data?.canCreateLibrary === true;
}

/** 个人中心 — 更新昵称/用户名/手机/简介 */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Parameters<typeof Auth.updateMe>[0]) =>
      (await Auth.updateMe(patch)).user,
    onSuccess: (user) => {
      // 1) 同步当前活动会话（顶栏 / 抽屉显示）：远端写该节点会话分键，本地写 gx-auth
      syncActiveUser(user);
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
      syncActiveUser(res.user);
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
      syncActiveUser(res.user);
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

// ============ 库访问台账（只读）/ Share / Trash ============

/**
 * 某个库的「谁能进来」只读台账。
 *
 * 与 useRoleScopesVisibility 的区别只有取数路径：那个走 /api/v1/org/libraries/:kind/:id/visibility
 * （门控是组织动作 view_directory），这个走 /:baseId/members 或 /:kbId/members（门控是「能看这个库」）。
 * 两者后端同源于 libraryVisibility，返回同一份 DTO；设置页面向的是普通库成员，只有后者够得着。
 *
 * fail-closed：加载中 / 出错时 data 为 undefined，调用方一律按「看不到、改不了」渲染。
 */
export function useLibraryAccess(
  kind: LibraryKind | null,
  libraryId: string | null,
): UseQueryResult<LibraryVisibilityResponse> {
  return useQuery({
    queryKey: QK.libraryAccess(kind ?? "", libraryId ?? ""),
    queryFn: () =>
      kind === "kb"
        ? KbApi.members(libraryId as string)
        : Bases.members(libraryId as string),
    enabled: !!kind && enabledOf(libraryId),
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

/**
 * 记录变更日志（数据日志）：GET /api/records/:id/changes。
 *
 * 两条硬要求：
 *   ① 没打开弹窗（recordId 为 null）就不发请求 —— 走 enabledOf；
 *   ② 端点还没上线（404）时不报错，降级成空列表，UI 走「暂无变更记录」空态。
 * 读取结果一律先过 parseRecordChanges，字段缺失/类型不对都不会崩。
 */
export function useRecordChanges(recordId: string | null): UseQueryResult<RecordChangeEntry[]> {
  return useQuery({
    queryKey: QK.recordChanges(recordId ?? ""),
    queryFn: async () => {
      try {
        return parseRecordChanges(await Records.changes(recordId!));
      } catch (err) {
        // 后端 /changes 尚未落地时是 404：按「没有变更记录」处理，不把错误抛给用户。
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
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
      // 建库后调用方会立刻 navigate('/base/:newId')。必须 await 库列表刷新落地（同 #1006 竞态），
      // 否则根索引/BaseIndexRedirect 读到旧的 bases 会闪错或误跳。原先只 fire-and-forget 失效
      // ["bases"]（无 baseId 时唯一覆盖项），这里覆盖范围不变，仅把「触发」升级为「等待落地」。
      onSuccess: () => refreshAfterCreateBase(qc),
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
      // 同 #1006：调用方 .then 里立刻 navigate('/base/:id/table/:newId')，必须等
      // tables/views/fields 刷新落地，否则 TableIndexRedirect 读空 views 会误跳设置页。
      onSuccess: (t, v) => refreshAfterCreateTable(qc, v.baseId, t.id),
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
      // #1006：必须 await 表列表 refetch 落地后再让 mutateAsync resolve。
      // 此前只「触发」失效（void），三个删表入口在 .then 里立刻 navigate('/base/:id')，
      // BaseIndexRedirect 挂载时 useTables 读到的还是删除前的旧缓存（isLoading=false），
      // tables[0] 若正好是被删表 → 又被重定向回那张已删表的死视图，要手动切走才消失。
      // await 后调用方跳转时缓存必为新列表（已不含被删表）。
      onSuccess: async (_d, v) => {
        await qc.invalidateQueries({ queryKey: ["tables", v.baseId] });
        void qc.invalidateQueries({ queryKey: ["bases"] });
        void qc.invalidateQueries({ queryKey: ["base", v.baseId] });
        void qc.invalidateQueries({ queryKey: ["trash", v.baseId] });
      },
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
    updateViewAdmin: useMutation({
      mutationFn: async (p: {
        viewId: string;
        tableId: string;
        adminConfig: Partial<Omit<ViewAdminConfig, "version">>;
      }) => (await Views.updateAdmin(p.viewId, p.adminConfig)).view,
      onSuccess: (_d, v) => {
        void qc.invalidateQueries({ queryKey: QK.views(v.tableId) });
        void qc.invalidateQueries({ queryKey: ["records", v.tableId] });
      },
    }),
    // #561：当前用户视图个性化层。只写自己的 prefs，不触碰共享 config；
    // 生效后合成的 ViewDTO.config 会变，因此 views + records 都要失效。
    saveViewPrefs: useMutation({
      mutationFn: async (p: {
        viewId: string;
        tableId: string;
        prefs: Partial<Omit<ViewUserPrefs, "version">>;
      }) => (await Views.savePrefs(p.viewId, p.prefs)).userPrefs,
      onSuccess: (_d, v) => {
        void qc.invalidateQueries({ queryKey: ["views", v.tableId] });
        void qc.invalidateQueries({ queryKey: ["records", v.tableId] });
      },
    }),
    resetViewPrefs: useMutation({
      mutationFn: async (p: { viewId: string; tableId: string }) =>
        (await Views.resetPrefs(p.viewId)).ok,
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

    // --- share ---
    // 成员写操作（inviteMember / updateMember / removeMember）已随后端三个端点一起删除：
    // 权限只按角色配后，逐库逐人的名册不再是授权入口。
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
      mutationFn: async (p: { recordId: string; data: CreateCommentRequest }) =>
        (await Records.addComment(p.recordId, p.data)).comment,
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

// ============ 角色 × 库视野（权限核心模型二） ============
//
// 命名一律 RoleScopes 前缀：库设置页那组（bases/kb 成员与分享）是另一套读写面，
// 两边共用 /api/bases、/api/kb 前缀却不共用语义，前缀分开避免误挂失效。

/** 某角色的全部库视野。roleId 为空不选（不查询）。 */
export function useRoleScopes(roleId: string | null): UseQueryResult<RoleLibraryScopeDTO[]> {
  return useQuery({
    queryKey: QK.roleScopes(roleId ?? ""),
    queryFn: async () => (await RoleScopes.list(roleId as string)).scopes,
    enabled: !!roleId,
  });
}

/** 整份替换某角色的库视野（未出现在 items 里的库 = 撤销）。 */
export function useRoleScopesSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { roleId: string; items: PutLibraryScopeInput[] }) =>
      RoleScopes.replace(v.roleId, v.items),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: QK.roleScopes(v.roleId) });
      // 库视野变了，逐库「谁能进来」的台账随之变
      void qc.invalidateQueries({ queryKey: ["org", "library-visibility"] });
      // 当前登录者自己的可见库集合可能随之变（把自己所在角色的库去掉了）
      void qc.invalidateQueries({ queryKey: QK.bases });
    },
  });
}

/** 某个库被哪些角色覆盖（只读台账）。kind/id 任一为空不查询。 */
export function useRoleScopesVisibility(
  kind: LibraryKind | null,
  libraryId: string | null,
): UseQueryResult<LibraryVisibilityResponse> {
  return useQuery({
    queryKey: QK.libraryVisibility(kind ?? "", libraryId ?? ""),
    queryFn: () => RoleScopes.visibility(kind as LibraryKind, libraryId as string),
    enabled: !!kind && !!libraryId,
  });
}

/** 库级「允许分享」开关。后端按硬规则 C 门控（管理权角色 + 超级管理员 + 管理员），越权 403。 */
export function useRoleScopesShareEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: LibraryKind; libraryId: string; enabled: boolean }) =>
      RoleScopes.setShareEnabled(v.kind, v.libraryId, v.enabled),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({
        queryKey: QK.libraryVisibility(v.kind, v.libraryId),
      });
      // 库设置页那份台账走的是另一个端点（/members），得单独失效，
      // 否则开关拨完页面上的状态还是旧的。
      void qc.invalidateQueries({ queryKey: QK.libraryAccess(v.kind, v.libraryId) });
      void qc.invalidateQueries({ queryKey: QK.bases });
    },
  });
}

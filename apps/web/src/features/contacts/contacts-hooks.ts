// M2/S7 组织通讯录 TanStack Query hooks：部门 / 成员（无限分页+过滤）/ 角色 / 授予 / 有效角色，
// 以及全套写 mutation（成功后按维度 invalidate）。所有请求都经 client.ts 的 Org* 段，禁裸 fetch。
import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  OrgDepartments,
  OrgMembers,
  OrgRoles,
  type MemberListParams,
} from "../../api/client";
import type {
  DeptDTO,
  OrgRoleDTO,
  RoleAssignmentDTO,
  OrgMemberDTO,
  EffectiveRoleDTO,
  UserAccountStatus,
  OrgAction,
  AssignmentSubjectInput,
} from "@gx/shared-types";

import { isAdminLevelSystemKey } from "../../lib/role-policy";
import { useAuthStore } from "../../store/auth";
import { useRemoteSessionActive } from "../../node/useActiveSession";

/** 成员目录每页大小：取服务端单页上限 100，配合前端窗口化与触底续翻。 */
export const ORG_MEMBER_PAGE_SIZE = 100;

export interface MemberFilter {
  q: string;
  deptId: string | null;
  status: UserAccountStatus | null;
}

export const ORG_QK = {
  departments: ["org", "departments"] as const,
  members: (f: MemberFilter) =>
    ["org", "members", f.q.trim(), f.deptId ?? "", f.status ?? ""] as const,
  roles: ["org", "roles"] as const,
  assignments: (roleId: string) => ["org", "roles", roleId, "assignments"] as const,
  effectiveRoles: (memberId: string) => ["org", "members", memberId, "effective-roles"] as const,
  myEffectiveRoles: ["org", "me", "effective-roles"] as const,
};

// ============ 部门 ============

export function useDepartments() {
  return useQuery({
    queryKey: ORG_QK.departments,
    queryFn: () => OrgDepartments.list(),
    staleTime: 30_000,
  });
}

// ============ 成员（无限分页 + q/deptId/status 服务端过滤） ============

/**
 * 纯判定（可单测）：组织名册这类**私有**接口当前是否存在可用登录会话。
 *   - 本地 gx-auth 有 token（普通浏览器/fnOS 登录态），或
 *   - 桌面壳连的是「已登录远端节点」（S2，门控开时才有意义）。
 * 两者皆无＝匿名访客（公开分享页），名册查询必须 enabled:false，不发请求，
 * 否则匿名 401 会被全局拦截器当登录态失效、硬跳 /login。
 */
export function hasRosterSession(localToken: string | null, remoteActive: boolean): boolean {
  return !!localToken || remoteActive;
}

export function useOrgMembers(filter: MemberFilter) {
  // 会话门控：组织名册是私有接口（view_directory 门控）。匿名访客打开公开分享页
  // （/s/:token/...，无本地登录、非已登录远端节点）时绝不发起该请求——否则后端
  // 401 会被全局拦截器当成登录态失效，硬跳 /login，公开表页（成员列 MemberCell
  // 无条件用名册）直接崩。成员格子在无名册时由 MemberDisplay 兜底显短 id。
  const localToken = useAuthStore((s) => s.token);
  const remoteActive = useRemoteSessionActive();
  const hasSession = hasRosterSession(localToken, remoteActive);
  const params: MemberListParams = {
    q: filter.q.trim() || undefined,
    deptId: filter.deptId ?? undefined,
    status: filter.status ?? undefined,
    limit: ORG_MEMBER_PAGE_SIZE,
  };
  const query = useInfiniteQuery({
    queryKey: ORG_QK.members(filter),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => OrgMembers.list({ ...params, page: pageParam }),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: hasSession,
    // 过滤条件变化即新缓存（key 含过滤项），无需手动 reset。
  });

  const items = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.items),
    [query.data?.pages],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    items,
    total,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    isLoading: query.isLoading,
    /** 是否有任意请求在途（首屏或重试）——供「重试中」按钮态使用 */
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

// ============ 角色与授予 ============

export function useOrgRoles() {
  return useQuery({ queryKey: ORG_QK.roles, queryFn: () => OrgRoles.list(), staleTime: 30_000 });
}

export function useRoleAssignments(roleId: string | null) {
  return useQuery({
    queryKey: roleId ? ORG_QK.assignments(roleId) : ["org", "assignments", "none"],
    queryFn: () => OrgRoles.listAssignments(roleId as string),
    enabled: !!roleId,
  });
}

/** 指定成员有效组织角色（只读，含来源清单）；memberId 为 null 时不查询。 */
export function useEffectiveRoles(memberId: string | null) {
  return useQuery({
    queryKey: memberId ? ORG_QK.effectiveRoles(memberId) : ["org", "effective-roles", "none"],
    queryFn: async (): Promise<EffectiveRoleDTO[]> => {
      const res = await OrgMembers.effectiveRoles(memberId as string);
      return res.roles;
    },
    enabled: !!memberId,
  });
}

/** 当前登录者的有效组织动作集合（通讯录由 view_directory 门控，写按钮据余下十枚动作显隐）。 */
export function useMyOrgActions(): { actions: Set<OrgAction>; isLoading: boolean } {
  const query = useQuery({
    queryKey: ORG_QK.myEffectiveRoles,
    queryFn: async () => await OrgMembers.myEffectiveRoles(),
    staleTime: 60_000,
  });
  const actions = useMemo(() => {
    const s = new Set<OrgAction>();
    for (const r of query.data?.roles ?? []) for (const a of r.actions) s.add(a);
    return s;
  }, [query.data]);
  return { actions, isLoading: query.isLoading };
}

/**
 * 当前登录者是否为「工作区管理员」——持有超级管理员或管理员系统角色
 * （super_admin/admin；'owner' 是超级管理员的旧 systemKey，存量库仍可能挂着，一并认）。
 * 复用 myEffectiveRoles 同一查询缓存，不新增请求。工作区设置页的「仅管理员可见」分区据此门控。
 *
 * 历史口径 systemKey==="owner" 已失效：新权限模型把该行的 systemKey 改成了 super_admin，
 * 于是这个判定恒为 false，工作区设置页里所有 ownerOnly 分区（含权限管理）对超管也不显示。
 * 加载未完成时 isOwner=false，调用方应同时看 isLoading，避免在信号缺失时闪现面板。
 */
export function useIsWorkspaceOwner(): { isOwner: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ORG_QK.myEffectiveRoles,
    queryFn: async () => await OrgMembers.myEffectiveRoles(),
    staleTime: 60_000,
  });
  const isOwner = useMemo(
    () =>
      // 与权限配置面（role-permission-hooks）同用一把尺子，不再各写一份字面量。
      (query.data?.roles ?? []).some((r) => isAdminLevelSystemKey(r.systemKey)),
    [query.data],
  );
  return { isOwner, isLoading: query.isLoading };
}

// ============ 写操作 ============

export function useOrgDeptMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ORG_QK.departments });
    // 部门增删移会改成员子树过滤口径与 memberCount
    void qc.invalidateQueries({ queryKey: ["org", "members"] });
  };
  return {
    createDept: useMutation({
      mutationFn: OrgDepartments.create,
      onSuccess: invalidate,
    }),
    updateDept: useMutation({
      mutationFn: (v: { id: string; data: Parameters<typeof OrgDepartments.update>[1] }) =>
        OrgDepartments.update(v.id, v.data),
      onSuccess: invalidate,
    }),
    removeDept: useMutation({
      mutationFn: OrgDepartments.remove,
      onSuccess: invalidate,
    }),
  };
}

export function useOrgMemberMutations() {
  const qc = useQueryClient();
  const invalidateMembers = () =>
    void qc.invalidateQueries({ queryKey: ["org", "members"] });
  return {
    invite: useMutation({ mutationFn: OrgMembers.invite, onSuccess: invalidateMembers }),
    create: useMutation({ mutationFn: OrgMembers.create, onSuccess: invalidateMembers }),
    assignDepartments: useMutation({
      mutationFn: (v: { id: string; data: Parameters<typeof OrgMembers.assignDepartments>[1] }) =>
        OrgMembers.assignDepartments(v.id, v.data),
      // 调岗/兼岗同时影响成员列表（归属）与有效角色（祖先闭包授予）
      onSuccess: invalidateMembers,
    }),
    disable: useMutation({ mutationFn: OrgMembers.disable, onSuccess: invalidateMembers }),
    reactivate: useMutation({ mutationFn: OrgMembers.reactivate, onSuccess: invalidateMembers }),
    // 删除是物理删除：deleteUser 会连外键覆盖不到的孤立 user 授予行一起清，
    // 故角色详情的主体清单（role_assignments 视图）也要一并失效。
    remove: useMutation({
      mutationFn: OrgMembers.remove,
      onSuccess: () => {
        invalidateMembers();
        void qc.invalidateQueries({ queryKey: ["org", "roles"] });
      },
    }),
  };
}

export function useOrgRoleMutations() {
  const qc = useQueryClient();
  const invalidateRoles = () => void qc.invalidateQueries({ queryKey: ["org", "roles"] });
  return {
    createRole: useMutation({ mutationFn: OrgRoles.create, onSuccess: invalidateRoles }),
    updateRole: useMutation({
      mutationFn: (v: { id: string; data: Parameters<typeof OrgRoles.update>[1] }) =>
        OrgRoles.update(v.id, v.data),
      onSuccess: invalidateRoles,
    }),
    removeRole: useMutation({
      mutationFn: (v: { id: string; reassignTo?: string }) =>
        OrgRoles.remove(v.id, v.reassignTo),
      onSuccess: invalidateRoles,
    }),
    replaceAssignments: useMutation({
      mutationFn: (v: { roleId: string; subjects: AssignmentSubjectInput[] }) =>
        OrgRoles.replaceAssignments(v.roleId, v.subjects),
      onSuccess: (_d, v) => {
        void qc.invalidateQueries({ queryKey: ORG_QK.assignments(v.roleId) });
        // 授予变化会改相关成员的有效角色
        void qc.invalidateQueries({ queryKey: ["org", "members"] });
      },
    }),
  };
}

// 供组件按 id 快速取部门名/角色名的派生 hook（数据来自已缓存的列表查询，不额外发请求）。
export function useDeptNameLookup(): (id: string) => string {
  const { data } = useDepartments();
  return useMemo(() => {
    const map = new Map<string, string>((data ?? []).map((d: DeptDTO) => [d.id, d.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [data]);
}

export function useRoleNameLookup(): (id: string) => string {
  const { data } = useOrgRoles();
  return useMemo(() => {
    const map = new Map<string, string>((data ?? []).map((r: OrgRoleDTO) => [r.id, r.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [data]);
}

export type { DeptDTO, OrgRoleDTO, RoleAssignmentDTO, OrgMemberDTO };

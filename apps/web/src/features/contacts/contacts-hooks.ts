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

export function useOrgMembers(filter: MemberFilter) {
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

/** 当前登录者的有效组织动作集合（全员可读目录，写按钮据三枚动作门控显隐/禁用）。 */
export function useMyOrgActions(): { actions: Set<OrgAction>; isLoading: boolean } {
  const query = useQuery({
    queryKey: ORG_QK.myEffectiveRoles,
    queryFn: async () => (await OrgMembers.myEffectiveRoles()).roles,
    staleTime: 60_000,
  });
  const actions = useMemo(() => {
    const s = new Set<OrgAction>();
    for (const r of query.data ?? []) for (const a of r.actions) s.add(a);
    return s;
  }, [query.data]);
  return { actions, isLoading: query.isLoading };
}

/**
 * 当前登录者是否为工作区所有者（任一有效系统角色 systemKey="owner"）。
 * 复用 myEffectiveRoles 同一查询缓存，不新增请求。M5 检索管理面（role_owner）据此门控。
 * 加载未完成时 isOwner=false，调用方应同时看 isLoading，避免在信号缺失时闪现面板。
 */
export function useIsWorkspaceOwner(): { isOwner: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ORG_QK.myEffectiveRoles,
    queryFn: async () => (await OrgMembers.myEffectiveRoles()).roles,
    staleTime: 60_000,
  });
  const isOwner = useMemo(
    () => (query.data ?? []).some((r) => r.systemKey === "owner"),
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

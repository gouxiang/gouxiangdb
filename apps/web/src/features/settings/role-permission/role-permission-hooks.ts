// apps/web/src/features/settings/role-permission/role-permission-hooks.ts
// 权限配置界面自己的几个派生 hook（库视野的读写 hook 在 api/hooks.ts，走 RoleScopes 前缀）。
//
// 放这里而不是 contacts-hooks 的原因：contacts-hooks 是通讯录目录的缓存层，
// 权限配置面要的是「我属于哪些角色、我是不是超级管理员/管理员」这类裁决输入，
// 塞进通讯录会让两边互相牵扯。

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { OrgMembers } from "../../../api/client";
import type { LibraryKind } from "@gx/shared-types";
import { isAdminLevelSystemKey } from "../../../lib/role-policy";

/**
 * 「我属于哪些角色」。
 *
 * queryKey 用字面量 ["org","me","effective-roles"]：与 contacts-hooks 的
 * ORG_QK.myEffectiveRoles、api/hooks.ts 的 useCanCreateLibrary 同键，三处共享同一份缓存，
 * 不新增请求（见 api/hooks.ts 同款注释）。
 *
 * fail-closed：加载中 / 出错一律返回空集合且 isSuperOrAdmin=false——
 * 宁可暂时不显示「允许分享」开关，也不能按猜的结果把它显示给没权限的人。
 */
export function useMyRoleRefs(): {
  roleIds: Set<string>;
  isSuperOrAdmin: boolean;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ["org", "me", "effective-roles"],
    queryFn: async () => await OrgMembers.myEffectiveRoles(),
    staleTime: 60_000,
    retry: false,
  });
  const roleIds = useMemo(
    () => new Set((query.data?.roles ?? []).map((r) => r.roleId)),
    [query.data],
  );
  const isSuperOrAdmin = useMemo(
    // owner 是超级管理员的旧 systemKey（迁移 20260921010000 起改为 super_admin），
    // 存量数据里仍可能出现，一并认。与通讯录（contacts-hooks 的 useIsWorkspaceOwner）
    // 共用 lib/role-policy 的同一把尺子。
    () => (query.data?.roles ?? []).some((r) => isAdminLevelSystemKey(r.systemKey)),
    [query.data],
  );
  return { roleIds, isSuperOrAdmin, isLoading: query.isLoading };
}

/** 库在草稿里的唯一键。写回时再拆成 (kind, libraryId)。 */
export function scopeKey(kind: LibraryKind, libraryId: string): string {
  return `${kind}:${libraryId}`;
}

export function parseScopeKey(key: string): { kind: LibraryKind; libraryId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const libraryId = key.slice(at + 1);
  if (kind !== "base" && kind !== "kb") return null;
  return libraryId ? { kind, libraryId } : null;
}

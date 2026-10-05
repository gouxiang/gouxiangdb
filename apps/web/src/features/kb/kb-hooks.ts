// apps/web/src/features/kb/kb-hooks.ts
// 知识库 TanStack Query hooks：缓存键与失效策略（独立前缀，不触碰数据表缓存）。

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KbApi, PublicApi, type KbDTO, type KbDocDTO, type KbDocKind, type KbDocVersionDTO, type KbShareStateDTO, type KbPublicDocDTO, type KbTreeItemDTO } from "../../api/client";

const QK = {
  kbList: ["kb", "list"] as const,
  kb: (id: string) => ["kb", id] as const,
  docs: (kbId: string, kind?: string, q?: string) => ["kb", kbId, "docs", kind ?? "all", q ?? ""] as const,
  doc: (id: string) => ["kb", "doc", id] as const,
  versions: (id: string) => ["kb", "doc", id, "versions"] as const,
  trash: (kbId: string) => ["kb", kbId, "trash"] as const,
};

// ============ 知识库容器 ============

export function useKbList() {
  return useQuery({ queryKey: QK.kbList, queryFn: () => KbApi.list().then((r) => r.knowledgeBases) });
}

export function useKb(kbId: string | undefined) {
  return useQuery({
    queryKey: QK.kb(kbId ?? ""),
    queryFn: () => KbApi.get(kbId!).then((r) => r.knowledgeBase),
    enabled: !!kbId,
  });
}

export function useCreateKb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; iconColor?: string }) => KbApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb"] }),
  });
}

export function useUpdateKb(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    // 同 updateBase：iconColor 的 null = 恢复默认色，undefined = 不改动。
    mutationFn: (data: { name?: string; iconColor?: string | null; icon?: string | null }) => KbApi.update(kbId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.kb(kbId) });
      qc.invalidateQueries({ queryKey: QK.kbList });
    },
  });
}

export function useDeleteKb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kbId: string) => KbApi.remove(kbId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb"] }),
  });
}

// ============ 内容（文档/画布） ============
//
// 成员段已整体删除：GET /kb/:kbId/members 现在是「哪些角色覆盖本库」的只读台账
// （LibraryVisibilityResponse，不再是人员名册），三个写端点已下线。
// 唯一消费过它的 @提及改为走组织通讯录，见 MentionPicker 注释。

export function useKbDocs(kbId: string | undefined, kind?: KbDocKind | "all", q?: string) {
  return useQuery({
    queryKey: QK.docs(kbId ?? "", kind, q),
    queryFn: () =>
      KbApi.docs(kbId!, {
        kind: kind && kind !== "all" ? kind : undefined,
        q: q?.trim() || undefined,
      }).then((r) => r.docs as KbDocDTO[]),
    enabled: !!kbId,
  });
}

export function useCreateDoc(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { kind: KbDocKind; title?: string }) => KbApi.createDoc(kbId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
      qc.invalidateQueries({ queryKey: QK.kb(kbId) });
    },
  });
}

export function useDoc(docId: string | undefined) {
  return useQuery({
    queryKey: QK.doc(docId ?? ""),
    queryFn: () => KbApi.doc(docId!).then((r) => r.doc),
    enabled: !!docId,
    // 编辑器持有本地草稿，不做后台刷新覆盖
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useRenameDoc(docId: string, kbId: string) {
  const qc = useQueryClient();
  // patch 支持对象形态：只改 icon/iconColor 时不必带 title（后端对两者都容忍缺省）。
  return useMutation({
    mutationFn: (patch: string | { title?: string; icon?: string | null; iconColor?: string | null }) =>
      KbApi.renameDoc(docId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.doc(docId) });
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
    },
  });
}

// ============ 树移动（级联） ============

export function useMoveDoc(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, parentId }: { docId: string; parentId: string | null }) =>
      KbApi.moveDoc(docId, parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
    },
  });
}

// ============ 分享 ============

export function useShareState(docId: string | undefined) {
  return useQuery({
    queryKey: ["kb", "doc", docId, "share"],
    queryFn: () => KbApi.getShare(docId!),
    enabled: !!docId,
  });
}

export function useSetShare(docId: string, kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { shareEnabled: boolean; shareRole?: "viewer" | "editor"; shareIncludeChildren?: boolean }) =>
      KbApi.setShare(docId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "doc", docId, "share"] });
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
    },
  });
}

// ============ 公开分享（匿名） ============

export function usePublicShare(token: string | undefined) {
  return useQuery({
    queryKey: ["kb", "public", token],
    queryFn: () => PublicApi.getShare(token!),
    enabled: !!token,
    retry: false,
  });
}

export function usePublicDoc(token: string | undefined, docId: string | undefined) {
  return useQuery({
    queryKey: ["kb", "public", token, "doc", docId],
    queryFn: () => PublicApi.getDoc(token!, docId!),
    enabled: !!token && !!docId,
    retry: false,
  });
}

export type { KbShareStateDTO, KbPublicDocDTO, KbTreeItemDTO };

export function useDeleteDoc(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => KbApi.deleteDoc(docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
      qc.invalidateQueries({ queryKey: QK.trash(kbId) });
      qc.invalidateQueries({ queryKey: QK.kb(kbId) });
    },
  });
}

// ============ 版本 ============

export function useVersions(docId: string | undefined) {
  return useQuery({
    queryKey: QK.versions(docId ?? ""),
    queryFn: () => KbApi.versions(docId!).then((r) => r.versions as KbDocVersionDTO[]),
    enabled: !!docId,
  });
}

export function useVersion(docId: string | undefined, versionRowId: string | null) {
  return useQuery({
    queryKey: ["kb", "doc", docId, "version", versionRowId],
    queryFn: () => KbApi.version(docId!, versionRowId!).then((r) => r.version as KbDocVersionDTO),
    enabled: !!docId && !!versionRowId,
  });
}

export function useCreateVersion(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => KbApi.createVersion(docId, label),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.versions(docId) }),
  });
}

export function useRollback(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionRowId: string) => KbApi.rollback(docId, versionRowId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.doc(docId) });
      qc.invalidateQueries({ queryKey: QK.versions(docId) });
    },
  });
}

// ============ 回收站 ============

export function useKbTrash(kbId: string | undefined) {
  return useQuery({
    queryKey: QK.trash(kbId ?? ""),
    queryFn: () => KbApi.trash(kbId!).then((r) => r.docs as KbDocDTO[]),
    enabled: !!kbId,
  });
}

export function useRestoreDoc(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => KbApi.restoreDoc(docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.trash(kbId) });
      qc.invalidateQueries({ queryKey: ["kb", kbId, "docs"] });
    },
  });
}

export function usePurgeDoc(kbId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => KbApi.purgeDoc(docId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.trash(kbId) }),
  });
}

// 单文档独立权限弹窗（DocAclModal）及其专属 hooks useDocAcl / useSetDocAcl 已随
// 该零引用组件一并删除；文档级授权不再有独立入口。

export type { KbDTO, KbDocDTO };

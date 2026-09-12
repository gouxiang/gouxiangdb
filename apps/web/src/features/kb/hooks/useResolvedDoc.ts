// apps/web/src/features/kb/hooks/useResolvedDoc.ts
// 单一文档解析 hook：内部态复用 useDoc，公开匿名态走引用闭包接口 PublicApi.getRef。
// 卡 / 弹窗 / 其它嵌入共用本 hook，保证 react-query 缓存键统一，见
// docs/decisions/KB-EDITOR-ROUND-5.md §2.1 / §2.4。

import { useQuery } from "@tanstack/react-query";
import { ApiError, PublicApi } from "../../../api/client";
import { useDoc } from "../kb-hooks";

export interface ResolvedDoc {
  id: string;
  kind: "doc" | "canvas";
  title: string;
  content: string;
  /** 乐观锁版本号（内部态才有；公开分享保存暂不走版本校验） */
  contentVersion?: number;
}

export interface UseResolvedDocResult {
  doc: ResolvedDoc | undefined;
  isLoading: boolean;
  error: unknown;
  /** ApiError 的 HTTP status；非 ApiError 时为 undefined */
  status: number | undefined;
  canEdit: boolean;
  refetch: () => Promise<unknown>;
  isPublic: boolean;
}

export function useResolvedDoc(
  docId: string | undefined,
  opts?: { publicToken?: string },
): UseResolvedDocResult {
  const publicToken = opts?.publicToken;
  const isPublic = !!publicToken;

  // 内部态：复用既有 useDoc（queryKey ["kb","doc",id]）
  const internal = useDoc(isPublic ? undefined : docId);

  // 公开态：引用闭包单文档接口（queryKey 不带任何后缀，嵌入间共享缓存）
  const pub = useQuery({
    queryKey: ["kb", "public", publicToken, "doc", docId],
    queryFn: () => PublicApi.getRef(publicToken!, docId!),
    enabled: !!publicToken && !!docId,
    retry: false,
  });

  const rawError = isPublic ? pub.error : internal.error;
  const status = rawError instanceof ApiError ? rawError.status : undefined;

  if (isPublic) {
    const d = pub.data?.doc;
    return {
      doc: d ? { id: d.id, kind: d.kind, title: d.title, content: d.content } : undefined,
      isLoading: pub.isLoading,
      error: pub.error,
      status,
      canEdit: !!pub.data?.canEdit,
      refetch: () => pub.refetch(),
      isPublic: true,
    };
  }

  const d = internal.data;
  return {
    doc: d ? { id: d.id, kind: d.kind, title: d.title, content: d.content ?? "", contentVersion: d.contentVersion } : undefined,
    isLoading: internal.isLoading,
    error: internal.error,
    status,
    // 内部文档未显式返回 canEdit 时默认可编辑（沿用既有内部编辑器行为）
    canEdit: (d as { canEdit?: boolean } | undefined)?.canEdit ?? true,
    refetch: () => internal.refetch(),
    isPublic: false,
  };
}

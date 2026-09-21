// apps/web/src/features/kb/CanvasEmbed.tsx
// 文档内画布内嵌预览器：只读渲染目标画布（Drawnix 原生支持平移/缩放/快捷键/触控板/滚轮），
// 工具条提供「跳转至画布」与「编辑」（弹出画布编辑弹窗，保存后本预览即时刷新）。
// 内部知识库页走 useDoc(KbApi+JWT)；公开分享页走 usePublicDoc(PublicApi 匿名)。

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { useDoc } from "./kb-hooks";
import { PublicApi } from "../../api/client";
import { DrawnixCanvas } from "./DrawnixCanvas";
import { CanvasEditModal } from "./CanvasEditModal";

interface CanvasEmbedProps {
  docId: string;
  kbId?: string;
  canEdit: boolean;
  /** 公开分享 token：传入时走匿名 PublicApi（无 JWT） */
  publicToken?: string;
  /** 独立 root 挂载时无 Router context，导航由调用方注入；公开页不提供跳转 */
  onNavigate?: (path: string) => void;
}

export function CanvasEmbed({ docId, kbId, canEdit, publicToken, onNavigate }: CanvasEmbedProps) {
  // 内部页：useDoc（JWT）；公开页：usePublicDoc（匿名，只可能取到分享子树内的画布）
  const internal = useDoc(publicToken ? undefined : docId);
  const pub = useQuery({
    queryKey: ["kb", "public", publicToken, "doc", docId, "embed"],
    queryFn: () => PublicApi.getDoc(publicToken!, docId),
    enabled: !!publicToken,
    retry: false,
  });

  const isLoading = publicToken ? pub.isLoading : internal.isLoading;
  const error = publicToken ? pub.error : internal.error;
  const doc = publicToken
    ? pub.data?.doc
      ? { id: pub.data.doc.id, title: pub.data.doc.title, content: pub.data.doc.content }
      : undefined
    : internal.data
      ? { id: internal.data.id, title: internal.data.title, content: internal.data.content }
      : undefined;
  // 公开页的可编辑性以分享角色为准
  // 公开分享恒只读：匿名写已关闭（后端 public.ts 无任何写端点，读接口 canEdit 恒 false）。
  const effectiveCanEdit = publicToken ? false : canEdit;

  const [editing, setEditing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 空画布判定（与 RefEmbedBody 对齐）：content="[]" 或空串 → 嵌空白网格，视觉上是
  // "只剩边框没有内容"。改为展示空态占位，让卡片始终包裹一个可见节点。
  const isEmptyCanvas = useMemo(() => {
    if (!doc) return false;
    try {
      const arr = JSON.parse(doc.content || "[]");
      return Array.isArray(arr) && arr.length === 0;
    } catch {
      return true;
    }
  }, [doc]);

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-gx-lg border border-gx-separator bg-gx-bg">
        <Spinner size={18} />
      </div>
    );
  }

  // 无权限 / 已删除 / 不在分享子树内：渲染为受限占位
  if (error || !doc) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-4 text-gx-12 text-gx-text-hint">
        <Icon name="lock" size={15} />
        该画布未包含在可访问范围内，或已被删除。
      </div>
    );
  }

  return (
    <div className="mb-3 overflow-hidden rounded-gx-lg border border-gx-separator bg-gx-bg">
      {/* 工具条 */}
      <div className="flex items-center gap-1.5 border-b border-gx-separator bg-gx-surface px-2.5 py-1.5">
        <Icon name="canvas" size={14} className="text-gx-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-gx-12 font-medium text-gx-text-primary">{doc.title || "未命名画布"}</span>
        <span className="text-gx-11 text-gx-text-hint">滚轮/触控板缩放查看</span>
        {kbId && onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate(`/kb/${kbId}/canvas/${docId}`)}
            className="inline-flex h-6 items-center gap-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 text-gx-11 text-gx-text-secondary hover:bg-gx-bg"
          >
            <Icon name="expand" size={12} />
            跳转至画布
          </button>
        )}
        {effectiveCanEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex h-6 items-center gap-1 rounded-gx-sm bg-gx-accent px-2 text-gx-11 font-medium text-white hover:brightness-95"
          >
            <Icon name="edit" size={12} />
            编辑
          </button>
        )}
      </div>
      {/* 画布主体：固定高度，Drawnix 只读但允许平移/滚轮缩放（allowViewInteraction，不盖 pointer 遮罩）；
          C-4：fitOnLoad 初始化后自动适配全貌，避免沿用保存时视口导致内容偏出可视区 */}
      <div className="h-80 bg-white">
        {isEmptyCanvas ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="canvas" size={20} className="text-gx-text-hint" />
            <div className="text-gx-12 font-medium text-gx-text-primary">空白画布</div>
            <div className="text-gx-11 text-gx-text-hint">
              {publicToken
                ? "关联画布为空，分享者尚未添加节点。"
                : "点击「编辑」开始绘制，或在源画布中添加节点后此处自动同步。"}
            </div>
          </div>
        ) : (
          <DrawnixCanvas key={`${docId}-${reloadKey}`} content={doc.content} readonly allowViewInteraction fitOnLoad />
        )}
      </div>

      {editing && (
        <CanvasEditModal
          docId={docId}
          kbId={kbId}
          canEdit={effectiveCanEdit}
          publicToken={publicToken}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setReloadKey((k) => k + 1);
            setEditing(false);
            if (publicToken) void pub.refetch();
            else internal.refetch();
          }}
        />
      )}
    </div>
  );
}

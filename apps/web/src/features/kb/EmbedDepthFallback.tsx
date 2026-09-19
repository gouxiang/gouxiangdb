// apps/web/src/features/kb/EmbedDepthFallback.tsx
// 互嵌降级卡：成环 / 超过 MAX_EMBED_DEPTH 层时替换原本要挂载的嵌入体。
//
// 三条硬要求（P2-A④）：不报错、不白屏、不无限递归——所以这里**不取数、不挂 React root、
// 不渲染任何会再触发渲染链的组件**，只画一张静态链接卡。标题取不到（没去查接口）就退化为
// 「已折叠的内容」，按钮仍然指向真实目标地址，用户点开是完整的新上下文，链路在该处断掉。

import { MAX_EMBED_DEPTH } from "./embed-depth";
import { Icon } from "../../components/icons";

export interface EmbedDepthFallbackProps {
  docId: string;
  kind: "cycle" | "depth";
  kbId?: string;
  title?: string;
  /** 跳转目标路径模板所需的 kind：画布 / 文档 */
  targetKind?: "canvas" | "doc";
  /** 独立 root 场景由调用方注入；公开分享页不注入 → 不出按钮（无站内目标可跳） */
  onNavigate?: (path: string) => void;
}

export function EmbedDepthFallback({
  docId,
  kind,
  kbId,
  title,
  targetKind = "canvas",
  onNavigate,
}: EmbedDepthFallbackProps) {
  const cycle = kind === "cycle";
  const canJump = !!kbId && !!onNavigate && !!docId;
  return (
    <div
      data-embed-fallback={cycle ? "cycle" : "depth"}
      className="mb-3 flex items-center gap-2.5 rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-3"
    >
      <Icon name="canvas" size={16} className="shrink-0 text-gx-text-hint" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-gx-12 font-medium text-gx-text-primary">
          {title?.trim() || "画布预览"}
        </div>
        <div className="mt-0.5 text-gx-11 text-gx-text-hint">
          {cycle
            ? "该内容存在循环嵌套，为避免重复渲染已折叠。"
            : `已达嵌套上限（${MAX_EMBED_DEPTH} 层），更深的内容不再展开。`}
        </div>
      </div>
      {canJump && (
        <button
          type="button"
          onClick={() => onNavigate!(`/kb/${kbId}/${targetKind}/${docId}`)}
          data-embed-fallback-jump
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 text-gx-11 text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="expand" size={12} />
          点击打开
        </button>
      )}
    </div>
  );
}

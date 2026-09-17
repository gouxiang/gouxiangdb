// apps/web/src/features/kb/canvas/RefEmbedBody.tsx
// 关联嵌入的唯一 body 渲染基元（KB-EDITOR-ROUND-5 §2.2）。
// 纯展示：loading / 404 已删除 / 403 无权限 / canvas 只读 / markdown 完整渲染 五态。
// DOM/className 沿用原 DocRefCard body，保证 A 独立块与 B 角标卡视觉完全一致。
// minimal 隐藏由外层 LinkBlockPreview 负责，本组件不感知。

import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../../components/icons";
import { Spinner } from "../../../components/ui";
import { renderMarkdown } from "@gx/blocks";
import { DrawnixCanvas } from "../DrawnixCanvas";
import { enhanceCanvasEmbeds } from "../enhanceEmbeds";
import type { UseResolvedDocResult } from "../hooks/useResolvedDoc";

export interface RefEmbedBodyProps {
  resolved: UseResolvedDocResult;
  /** 关联载荷声明的 kind（注意：不用 resolved.doc.kind，error 态仍需知道如何渲染） */
  refKind: "doc" | "canvas";
  /** canvas 保存后自增，强制只读 DrawnixCanvas 重挂载显示最新 JSON */
  reloadKey: number;
  publicToken?: string;
  /** 内部知识库 id：嵌入画布的「跳转至画布」入口需要；公开页不传 */
  kbId?: string;
}

export function RefEmbedBody({ resolved, refKind, reloadKey, publicToken, kbId }: RefEmbedBodyProps) {
  const { doc, isLoading, error, status } = resolved;
  const navigate = useNavigate();
  const mdHostRef = useRef<HTMLDivElement>(null);
  const mdHtml = useMemo(
    () => (!isLoading && !error && doc && refKind === "doc" ? renderMarkdown(doc.content ?? "") : ""),
    [isLoading, error, doc, refKind],
  );

  // 空内容判定：用户报"边框与内容分离/空白卡"——空 doc（renderMarkdown("")=>""）和
  // 空 canvas（content="[]"）都会让 body 区域只剩 bg-gx-surface 白底 + 边框，毫无内容节点。
  // 改为统一渲染一个居中空态占位（沿用 error/loading 风格：图标 + 文案 + 引导），让
  // 边框视觉上紧贴一个真实存在的"内容"节点，避免误判为渲染失败。
  const isEmpty = useMemo(() => {
    if (isLoading || error || !doc) return false;
    if (refKind === "doc") return mdHtml.trim().length === 0;
    try {
      const arr = JSON.parse(doc.content || "[]");
      return Array.isArray(arr) && arr.length === 0;
    } catch {
      return true;
    }
  }, [isLoading, error, doc, refKind, mdHtml]);

  // C-2：被关联 markdown 文档内的 canvas-embed 占位（renderMarkdown 产出 .md-canvas-embed）
  // 之前没有任何调用方对这条 innerHTML 路径跑 enhance → 预览卡里是一块空白。
  // 这里补跑；嵌套预览一律只读（canEdit=false），避免编辑弹窗无限嵌套。
  useEffect(() => {
    const host = mdHostRef.current;
    if (!host || !mdHtml) return;
    return enhanceCanvasEmbeds(host, {
      kbId,
      canEdit: false,
      publicToken,
      onNavigate: (p) => navigate(p),
    });
  }, [mdHtml, kbId, publicToken, navigate]);

  return (
    <div className="relative min-h-0 flex-1 bg-gx-surface">
      {isLoading ? (
        <div className="flex h-full items-center justify-center"><Spinner size={18} /></div>
      ) : error || !doc ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Icon name={status === 404 ? "doc" : "lock"} size={20} className="text-gx-text-hint" />
          <div className="text-gx-12 font-medium text-gx-text-primary">
            {status === 404 ? "内容已被删除" : "没有访问权限"}
          </div>
          <div className="text-gx-11 text-gx-text-hint">
            {status === 404
              ? "关联的文档或画布已被删除，可在节点设置中取消关联。"
              : publicToken
                ? "该关联内容未包含在本次分享范围内。"
                : "你没有该内容的访问权限，或它不在当前分享范围内。"}
          </div>
        </div>
      ) : isEmpty ? (
        // 空内容占位：与 error/loading 态同款居中布局，让边框始终包裹一个可见节点。
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <Icon name={refKind === "canvas" ? "canvas" : "doc"} size={20} className="text-gx-text-hint" />
          <div className="text-gx-12 font-medium text-gx-text-primary">
            {refKind === "canvas" ? "空白画布" : "暂无内容"}
          </div>
          <div className="text-gx-11 text-gx-text-hint">
            {publicToken
              ? "关联内容为空，分享者尚未填写。"
              : `点击右上角「编辑」开始${refKind === "canvas" ? "绘制" : "书写"}，或双击跳转${refKind === "canvas" ? "到源画布" : "到源文档"}。`}
          </div>
        </div>
      ) : refKind === "canvas" ? (
        <div className="h-full bg-white" key={reloadKey}>
          {/* C-4：fitOnLoad 初始化后自动适配全貌，避免沿用保存时视口导致内容偏出可视区 */}
          <DrawnixCanvas content={doc.content} readonly allowViewInteraction fitOnLoad />
        </div>
      ) : (
        <div className="h-full overflow-auto px-4 py-3">
          <div
            ref={mdHostRef}
            className="md-preview mx-auto max-w-2xl text-gx-13"
            dangerouslySetInnerHTML={{ __html: mdHtml }}
          />
        </div>
      )}
    </div>
  );
}

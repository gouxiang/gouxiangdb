// apps/web/src/features/kb/canvas/RefEmbedCard.tsx
// 关联嵌入的唯一取数 + header + body + 编辑弹窗组件（KB-EDITOR-ROUND-5 §2.3）。
// A 独立块（GxLinkBlockView）与 B 节点角标（DocRefCard）两个薄适配层都渲染本组件，
// 定位 / 尺寸 / 删除 / 关闭 / 重命名全部由调用点经 props 注入，本组件不感知几何。

import { useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useResolvedDoc } from "../hooks/useResolvedDoc";
import { EmbedChainContext, planEmbed, useEmbedChain } from "../embed-depth";
import { EmbedDepthFallback } from "../EmbedDepthFallback";
import type { GxDocRef } from "./types";
import { LinkBlockPreview } from "./LinkBlockPreview";
import { RefEmbedBody } from "./RefEmbedBody";
import { TableEmbedPreview } from "./TableEmbedPreview";
import { useCanvasBoard } from "./canvas-context";
import { CanvasEditModal } from "../CanvasEditModal";
import { DocEditModal } from "./DocEditModal";

export interface RefEmbedCardProps {
  /**
   * 关联载荷。注意：不能命名为 `ref`——普通函数组件的 ref 会被 React 特殊拦截
   * （不进 props，需 forwardRef），曾因此导致 ref_ 恒为 undefined、打开画布即崩溃。
   */
  gxRef: GxDocRef;
  kbId?: string;
  publicToken?: string;
  /** 外层画布是否可编辑（ctx.canEdit） */
  canEdit: boolean;
  /** 含 fixed、z-index token、圆角、边框、阴影、flex 布局类 */
  containerClassName: string;
  /** left/top/width/height */
  containerStyle: CSSProperties;
  dataAttrs?: Record<string, string>;
  onContainerPointerDown?: (e: ReactPointerEvent) => void;
  onContainerDoubleClick?: (e: ReactMouseEvent) => void;
  /** header 根条 pointer-down（独立块按住头部拖拽移动） */
  onHeaderPointerDown?: (e: ReactPointerEvent) => void;
  /** resize 手柄（由适配层提供） */
  trailingNode?: ReactNode;
  // header 能力（callback-present，沿用 LinkBlockPreview）
  canRename?: boolean;
  onRename?: (value: string) => void;
  onClose?: () => void;
  onDelete?: () => void;
  jumpEnabled?: boolean;
  onJump?: () => void;
  /** 是否显示"刷新"按钮（内部独立块显示；公开页隐藏） */
  showRefresh?: boolean;
}

export function RefEmbedCard({
  gxRef,
  kbId,
  publicToken,
  canEdit,
  containerClassName,
  containerStyle,
  dataAttrs,
  onContainerPointerDown,
  onContainerDoubleClick,
  onHeaderPointerDown,
  trailingNode,
  canRename,
  onRename,
  onClose,
  onDelete,
  jumpEnabled,
  onJump,
  showRefresh,
}: RefEmbedCardProps) {
  // kind="table" 不是文档：没有可解析的 doc，也不能走文档预览链，提前分流。
  const isTable = gxRef.kind === "table";
  const r = useResolvedDoc(isTable ? undefined : gxRef.docId, { publicToken });
  const rt = useCanvasBoard();
  const qc = useQueryClient();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);

  // 标题优先级：本地 displayTitle > 源 doc.title > 插入时快照 title
  // 数据表没有源标题，用 displayTitle > 快照 title（视图名由预览内部展示）。
  const title = isTable
    ? gxRef.displayTitle?.trim() || gxRef.title || "数据表"
    : gxRef.displayTitle?.trim() || r.doc?.title || gxRef.title || "未命名";
  // 公开引用闭包内文档 r.canEdit 恒 false；公开可编辑子树为 true
  const effectiveCanEdit = canEdit && r.canEdit;
  // 嵌入数据表的写权限与「宿主正文可否编辑」是两回事：
  //   - 登录态：ctx.embedCanEdit 未设 → 回落 canEdit（画布能编辑，嵌入的表就能编辑）
  //   - 分享态：canEdit 恒 false（正文匿名写已关闭），写权限由宿主分享档位 mode 决定
  const embedCanEdit = rt?.ctx.embedCanEdit ?? canEdit;


  const handleSaved = () => {
    setReloadKey((k) => k + 1);
    setEditing(false);
    void r.refetch();
  };

  // P2-A：canvas→doc/doc→canvas 这条互嵌链的判定下沉到统一入口。
  // 链由外层画布所在的嵌入链继承（context），测试用例与主画布（顶层）都落在根链上。
  // 数据表不参与这条链（它既不是 doc 也不是 canvas），故不查链。
  const chain = useEmbedChain();
  const plan = isTable ? null : planEmbed(gxRef.docId, chain);
  // isTable 是独立布尔，TS 无法据此收窄 gxRef.kind；这里显式收敛出文档侧的 kind。
  const docKind: "doc" | "canvas" = gxRef.kind === "canvas" ? "canvas" : "doc";
  // 降级卡复用外层注入的跳转行为（onJump），不额外引入 react-router 依赖。
  const body = isTable ? (
    <TableEmbedPreview
      tableId={gxRef.docId}
      viewId={gxRef.viewId ?? null}
      publicToken={publicToken}
      canEdit={embedCanEdit}
      fallbackTitle={gxRef.title}
    />
  ) : plan?.kind === "render" ? (
    <EmbedChainContext.Provider value={plan.chain}>
      <RefEmbedBody resolved={r} refKind={docKind} reloadKey={reloadKey} publicToken={publicToken} kbId={kbId} />
    </EmbedChainContext.Provider>
  ) : plan ? (
    <EmbedDepthFallback
      docId={gxRef.docId}
      kind={plan.kind}
      kbId={kbId}
      title={title}
      targetKind={docKind}
      onNavigate={onJump}
    />
  ) : null;
  return (
    <>
      <LinkBlockPreview
        kind={gxRef.kind}
        title={title}
        canEdit={effectiveCanEdit}
        canRename={canRename}
        onRename={onRename}
        jumpEnabled={jumpEnabled}
        onJump={onJump ?? (() => {})}
        // 数据表没有「正文」可编辑：增删改就在预览区里完成，不弹编辑弹窗。
        onEdit={!isTable && effectiveCanEdit ? () => setEditing(true) : undefined}
        onRefresh={
          showRefresh && !publicToken
            ? () => {
                void r.refetch();
                void qc.invalidateQueries({ queryKey: ["kb", "doc", gxRef.docId] });
              }
            : undefined
        }
        onDelete={onDelete}
        onClose={onClose}
        previewType={gxRef.previewType ?? "full"}
        body={body}
        containerClassName={containerClassName}
        containerStyle={containerStyle}
        dataAttrs={dataAttrs}
        onContainerPointerDown={onContainerPointerDown}
        onContainerDoubleClick={onContainerDoubleClick}
        onHeaderPointerDown={onHeaderPointerDown}
        trailingNode={trailingNode}
      />
      {!isTable &&
        editing &&
        (gxRef.kind === "canvas" ? (
          <CanvasEditModal
            docId={gxRef.docId}
            kbId={kbId}
            canEdit={effectiveCanEdit}
            publicToken={publicToken}
            onClose={() => setEditing(false)}
            onSaved={handleSaved}
          />
        ) : (
          <DocEditModal
            docId={gxRef.docId}
            publicToken={publicToken}
            onClose={() => setEditing(false)}
            onSaved={handleSaved}
          />
        ))}
    </>
  );
}

// 知识库能力回挂 L2（第四批 · 丢失入口恢复之二、之三）。
//
// 第三批把 L2 换成 SecondaryNav 后，旧壳 KbTree（features/kb/KbTree.tsx）已无任何引用点，
// 挂在它上面的两件事随之失联，这里接回 L2：
//   ① 新建文档 / 新建画布 —— 移到 L2 选项卡行右侧，按当前 tab 决定建哪种（原在 KbHomePage）；
//   ② 文档拖拽改层级 —— 拖到另一文档上成为其子级、拖到根区回到顶级（moveDoc({parentId})）。
//
// 复用而非复制：useKb 取 role、useCreateDoc 建文档、useMoveDoc 改层级，全部是 KbTree / KbHomePage
// 正在用的同一批 kb-hooks；层级校验（不能拖到自己或自己的子树）沿用 KbTree 的同一套判定。
// 画布行不参与拖拽：后端 moveDoc 的 parentId 层级语义只用在文档树上（KbTree 同样把画布
// 平铺在级联之外），不造后端没有的语义。

import { useState, type ReactNode } from "react";
import { Icon } from "../../components/icons";
import { toast } from "../../components/ui";
import { useKb, useCreateDoc, useMoveDoc } from "../kb/kb-hooks";
import type { KbDocKind } from "../../api/client";
import type { SecondaryRowDrag } from "./SecondaryNavSections";

/** 判定层级用的最小形态（父链上溯，不含画布）。 */
export interface SecondaryDocRef {
  id: string;
  parentId?: string | null;
}

export interface SecondaryKbOps {
  /** 内容创建权限（role ∈ owner/editor），与 KbHomePage 的 canCreate 同一口径。 */
  canCreate: boolean;
  /** 选项卡行右侧的「新建文档 / 新建画布」按钮；无权限时为 null（不渲染，不做禁用假入口）。 */
  createNode: ReactNode | null;
  /** 文档行拖拽状态（画布行不给）。 */
  rowDrag: (id: string) => SecondaryRowDrag;
  /**
   * 当前是否有文档行正在被拖拽（dragId 非空）。
   * 「移到顶级」落区据此按需渲染：非拖拽态整块不进 DOM，不再白占一片空白
   * （P0-④ 知识库文档列表顶部空一大条）。
   */
  dragActive: boolean;
  /** 顶部「拖到此处移到顶级」落区。 */
  rootZone: {
    active: boolean;
    onDragOver: (e: { preventDefault: () => void }) => void;
    onDrop: (e: { preventDefault: () => void }) => void;
  };
}

export function useSecondaryKbOps({
  kbId,
  tab,
  navigate,
  docs,
}: {
  kbId: string | null;
  /** 当前选项卡：只有文档 tab 才挂拖拽与「新建文档」。 */
  tab: "doc" | "canvas";
  navigate: (to: string) => void;
  docs: readonly SecondaryDocRef[];
}): SecondaryKbOps {
  const kbQ = useKb(kbId ?? undefined);
  const createDoc = useCreateDoc(kbId ?? "");
  const moveDoc = useMoveDoc(kbId ?? "");

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string | null; zone: "into" | "root" } | null>(null);

  // role 缺省 owner：kb 未加载完时不该先闪出无权限形态（与 KbHomePage 的取值一致）
  const role = kbQ.data?.role ?? "owner";
  const canCreate = role === "owner" || role === "editor";

  const create = (kind: KbDocKind) => {
    if (!kbId || createDoc.isPending) return;
    void createDoc
      .mutateAsync({ kind, title: kind === "canvas" ? "未命名画布" : "未命名文档" })
      .then((r) => {
        navigate(kind === "canvas" ? `/kb/${kbId}/canvas/${r.doc.id}` : `/kb/${kbId}/doc/${r.doc.id}`);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "新建失败", "error"));
  };

  /** target 是自己或自己的后代 → 禁止落点（拖成环）。 */
  const isSelfOrDescendant = (targetId: string): boolean => {
    if (!dragId) return false;
    if (targetId === dragId) return true;
    const byId = new Map(docs.map((d) => [d.id, d]));
    const seen = new Set<string>();
    let cur = byId.get(targetId);
    while (cur?.parentId && !seen.has(cur.id)) {
      if (cur.parentId === dragId) return true;
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    return false;
  };

  const handleDrop = () => {
    const from = dragId;
    const target = dropTarget;
    setDragId(null);
    setDropTarget(null);
    if (!from || !target) return;
    const parentId = target.zone === "root" ? null : target.id;
    if (parentId && isSelfOrDescendant(parentId)) {
      toast("无法移动：不能将文档放到它自己或它的子级中", "error");
      return;
    }
    void moveDoc
      .mutateAsync({ docId: from, parentId })
      .then(() => toast(parentId ? "已移到目标文档下" : "已移到顶级", "success"))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "移动失败", "error"));
  };

  const noop = () => undefined;

  return {
    canCreate,
    // 拖拽中标志：dragId 在 onDragStart 置位、onDragEnd/handleDrop 清空，
    // 与行高亮（rowDrag.dragging）同源，不需要另接 dragstart/dragend 监听。
    dragActive: dragId !== null,
    createNode: canCreate
      ? tab === "doc"
        ? (
          <button
            type="button"
            onClick={() => create("doc")}
            title="新建文档"
            aria-label="新建文档"
            className="flex items-center gap-1 rounded-gx-sm px-1.5 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
          >
            <Icon name="plus" size={12} />
            <span>新建文档</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => create("canvas")}
            title="新建画布"
            aria-label="新建画布"
            className="flex items-center gap-1 rounded-gx-sm px-1.5 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
          >
            <Icon name="plus" size={12} />
            <span>新建画布</span>
          </button>
        )
      : null,
    rowDrag: (id: string): SecondaryRowDrag => ({
      draggable: canCreate,
      dragging: dragId === id,
      dropInto: dropTarget?.zone === "into" && dropTarget.id === id,
      onDragStart: canCreate ? () => setDragId(id) : noop,
      onDragEnd: canCreate
        ? () => {
            setDragId(null);
            setDropTarget(null);
          }
        : noop,
      onDragOver: canCreate
        ? (e) => {
            if (!dragId || isSelfOrDescendant(id)) return;
            e.preventDefault();
            setDropTarget({ id, zone: "into" });
          }
        : noop,
      onDrop: canCreate
        ? (e) => {
            e.preventDefault();
            handleDrop();
          }
        : noop,
    }),
    rootZone: {
      active: dropTarget?.zone === "root",
      onDragOver: (e) => {
        if (!canCreate || !dragId) return;
        e.preventDefault();
        setDropTarget({ id: null, zone: "root" });
      },
      onDrop: (e) => {
        if (!canCreate) return;
        e.preventDefault();
        handleDrop();
      },
    },
  };
}

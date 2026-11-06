// 知识库能力回挂 L2（第四批 · 丢失入口恢复之二、之三、之四）。
//
// 第三批把 L2 换成 SecondaryNav 后，旧壳 KbTree（features/kb/KbTree.tsx）已无任何引用点，
// 挂在它上面的三件事随之失联，这里接回 L2：
//   ① 新建文档 / 新建画布 —— 移到 L2 选项卡行右侧，按当前 tab 决定建哪种（原在 KbHomePage）；
//   ② 文档拖拽改层级 —— 拖到另一文档上成为其子级、拖到根区回到顶级（moveDoc({parentId})）；
//   ③ 文档 / 画布行尾「⋯」菜单 —— 重命名 / 图标与颜色 / 删除（软删进回收站，可撤销）。
//
// 全部复用 kb-hooks 现成能力，不新造 fetch / 确认：改名与图标走 useRenameDoc（字符串 patch 改名、
// 对象 patch 改图标），删除走 useDeleteDoc + 全局 confirmSoftDelete（L2 可恢复）+ toastDeleted 撤销
// （useRestoreDoc），与旧壳 KbTree 的 doDelete / 图标弹窗逐同源。层级校验沿用 KbTree 同一套判定。
// 画布行不参与拖拽：moveDoc 的 parentId 层级语义只用在文档树上（KbTree 同样把画布平铺在级联之外）。
//
// 权限口径：canCreate（role ∈ owner/editor）为假时 rowMenuItems 恒返回 []，行尾只渲染占位、
// 不出现可点的三点入口（不是 disabled 假入口）——与新建按钮、拖拽、旧壳 KbTree 的 canEdit 同一口径。

import { useState, type ReactNode } from "react";
import { Icon } from "../../components/icons";
import { Input, Modal, toast } from "../../components/ui";
import { EntityIconPanel } from "../../components/EntityIconPicker";
import { confirmSoftDelete } from "../../components/feedback";
import { toastDeleted } from "../../components/interaction";
import { colors } from "@gx/design-tokens";
import {
  useKb,
  useCreateDoc,
  useMoveDoc,
  useRenameDoc,
  useDeleteDoc,
  useRestoreDoc,
} from "../kb/kb-hooks";
import type { KbDocKind } from "../../api/client";
import type { SecondaryRowDrag, RowMoreItem } from "./SecondaryNavSections";

/** 判定层级用的最小形态（父链上溯，不含画布）。 */
export interface SecondaryDocRef {
  id: string;
  parentId?: string | null;
}

/** 行菜单需要 id + 名字 + 族类型（+ 当前自定义图标，供「图标与颜色」弹窗回显）。 */
export interface SecondaryKbRowRef {
  id: string;
  name: string;
  kind: "doc" | "canvas";
  icon?: string | null;
  iconColor?: string | null;
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
  /** 文档 / 画布行菜单项；无写权限（canCreate=false）恒为空数组 → 行尾不渲染三点入口。 */
  rowMenuItems: (row: SecondaryKbRowRef) => RowMoreItem[];
  /** 重命名 / 图标与颜色弹窗，由调用点统一挂载（删除走全局确认宿主 ConfirmHost，不占本节点）。 */
  menuNode: ReactNode;
}

export function useSecondaryKbOps({
  kbId,
  tab,
  navigate,
  docs,
  activeDocId,
}: {
  kbId: string | null;
  /** 当前选项卡：只有文档 tab 才挂拖拽与「新建文档」。 */
  tab: "doc" | "canvas";
  navigate: (to: string) => void;
  docs: readonly SecondaryDocRef[];
  /** 当前所在文档 / 画布（删除后要回跳库首页，不能停在已删项的死路由）。 */
  activeDocId?: string | null;
}): SecondaryKbOps {
  const kbQ = useKb(kbId ?? undefined);
  const createDoc = useCreateDoc(kbId ?? "");
  const moveDoc = useMoveDoc(kbId ?? "");
  const deleteDoc = useDeleteDoc(kbId ?? "");
  const restoreDoc = useRestoreDoc(kbId ?? "");

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string | null; zone: "into" | "root" } | null>(null);
  // 重命名目标（null = 弹窗关闭）；docId 用 "__none__" 哨兵占位，与 KbTree:75 同一模式，
  // 保证 useRenameDoc 在渲染期无条件调用、无目标时不指向真实文档。
  const [renaming, setRenaming] = useState<SecondaryKbRowRef | null>(null);
  const [iconEdit, setIconEdit] = useState<SecondaryKbRowRef | null>(null);
  const renameDoc = useRenameDoc(renaming?.id ?? "__none__", kbId ?? "");
  const renameIconDoc = useRenameDoc(iconEdit?.id ?? "__none__", kbId ?? "");

  // PERM-S2：加载中按 owner 兜底（kb 未加载完时不闪无权限形态）；
  // 加载失败（403 等）一律按 viewer 收敛——失败态不能再给可点的新建/拖拽/行菜单入口。
  const role = kbQ.isLoading ? "owner" : (kbQ.data?.role ?? "viewer");
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

  /** 重命名提交：useRenameDoc 的字符串 patch 形态（只改 title，图标 / 颜色不动）。 */
  const submitRename = () => {
    if (!renaming || !renaming.name.trim()) return;
    void renameDoc
      .mutateAsync(renaming.name.trim())
      .then(() => setRenaming(null))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "重命名失败", "error"));
  };

  /** 图标与颜色：useRenameDoc 的对象 patch 形态（不带 title，后端对缺省容忍），选即持久。 */
  const commitIcon = (next: { icon: string | null; iconColor: string | null }) => {
    if (!iconEdit) return;
    setIconEdit((cur) => (cur ? { ...cur, ...next } : cur));
    void renameIconDoc
      .mutateAsync({ icon: next.icon, iconColor: next.iconColor })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "保存图标失败", "error"));
  };

  /**
   * 删除（软删进回收站，L2 可恢复）：与旧壳 KbTree.doDelete 逐同源 —— confirmSoftDelete 普通确认
   * + useDeleteDoc + toastDeleted 撤销（useRestoreDoc）。删的是当前所在项时跳回库首页，不停死路由。
   */
  const removeRow = (row: SecondaryKbRowRef) => {
    if (!kbId) return;
    // 闭包（撤销回调）里要用窄化后的非空值：参数在嵌套函数里不保留窄化。
    const bid = kbId;
    void confirmSoftDelete({
      title: `删除「${row.name || "未命名"}」`,
      confirmText: "删除并移入回收站",
      description: "文档会移入回收站，30 天内可恢复；下级文档会一并保留在回收站。",
    }).then((ok) => {
      if (!ok) return;
      void deleteDoc
        .mutateAsync(row.id)
        .then(() => {
          if (row.id === activeDocId) navigate(`/kb/${bid}`);
          toastDeleted({
            message: `已移入回收站「${row.name || "未命名"}」`,
            restoredMessage: `已恢复「${row.name || "未命名"}」`,
            onUndo: () => restoreDoc.mutateAsync(row.id),
          });
        })
        .catch((e: unknown) => toast(e instanceof Error ? e.message : "删除失败", "error"));
    });
  };

  const rowMenuItems = (row: SecondaryKbRowRef): RowMoreItem[] => {
    if (!canCreate) return [];
    return [
      { icon: "edit", label: "重命名", onClick: () => setRenaming({ ...row }) },
      { icon: "palette", label: "图标与颜色", onClick: () => setIconEdit({ ...row }) },
      { icon: "trash", label: "删除", danger: true, onClick: () => removeRow(row) },
    ];
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
            className="gx-l2-new-btn gx-l2-new-btn-auto"
          >
            <Icon name="plus" size={14} />
            <span>新建文档</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => create("canvas")}
            title="新建画布"
            aria-label="新建画布"
            className="gx-l2-new-btn gx-l2-new-btn-auto"
          >
            <Icon name="plus" size={14} />
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
    rowMenuItems,
    // 弹窗只在有目标时挂载实体内容；删除确认走全局 ConfirmHost（feedback.tsx），不在本节点。
    menuNode: (
      <>
        <Modal
          open={!!renaming}
          title={renaming?.kind === "canvas" ? "重命名画布" : "重命名文档"}
          onClose={() => setRenaming(null)}
          footer={
            <>
              <button
                className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
                onClick={() => setRenaming(null)}
              >
                取消
              </button>
              <button
                className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
                disabled={!renaming?.name.trim()}
                onClick={submitRename}
              >
                保存
              </button>
            </>
          }
        >
          <Input
            autoFocus
            value={renaming?.name ?? ""}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
          />
        </Modal>

        {/* 图标与颜色：复用统一 EntityIconPanel（与数据表行菜单、表页左上角零分叉）；
            默认图标 / 默认预览色按族区分，画布 secondaryAlt、文档 accent，同旧壳 KbTree。 */}
        <Modal
          open={!!iconEdit}
          title={`${iconEdit?.kind === "canvas" ? "画布" : "文档"}图标与颜色`}
          onClose={() => setIconEdit(null)}
          footer={
            <button
              className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
              onClick={() => setIconEdit(null)}
            >
              完成
            </button>
          }
        >
          {iconEdit ? (
            <EntityIconPanel
              icon={iconEdit.icon ?? null}
              iconColor={iconEdit.iconColor ?? null}
              defaultIcon={iconEdit.kind === "canvas" ? "canvas" : "doc"}
              defaultColor={iconEdit.kind === "canvas" ? colors.secondaryAlt : colors.accent}
              onPickIcon={(name) => commitIcon({ icon: name, iconColor: iconEdit.iconColor ?? null })}
              // 选「默认颜色」（c=null）不连带改图标名；选具体颜色时图标缺省回退到本族默认图标，
              // 口径同 EntityIconPicker 内建实现与 SecondaryNavTableOps.commitIcon。
              onPickColor={(c) =>
                commitIcon({
                  icon:
                    c === null
                      ? iconEdit.icon ?? null
                      : iconEdit.icon ?? (iconEdit.kind === "canvas" ? "canvas" : "doc"),
                  iconColor: c,
                })
              }
              onReset={() => commitIcon({ icon: null, iconColor: null })}
            />
          ) : null}
        </Modal>
      </>
    ),
  };
}

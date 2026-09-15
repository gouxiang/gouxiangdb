// M3/S9 导航编排器（manage_menu 可见者全屏编辑）：
//   - 菜单引用层：容器/快捷项增删改排、多处添加、别名、HTML5 拖拽（菜单层零权威副作用）
//   - 权威层：新建 nav group 并挂为菜单 shortcut（二级导航中做实体移入与 impact 确认）
//   - 本地 draft 编辑 + 「保存」一次性 diff 成 MenuOp[] 整单提交（成功本体或整单回滚）
//
// 三态规则（M3 §4.3 / ADR-0029）：alive 正常；soft_dangling 全员隐藏（含编排态，源软删
// 引用保留待恢复，ComposerTree 仅视图过滤、不产生 delete）；broken 显灰可清理删除。
// 无权限时设置页渲染只读提示（不挂载本组件）。
import { useEffect, useMemo, useState } from "react";
import { Button, Spinner, toast } from "../../components/ui";
import { useCreateGroup, useNavMenu, usePatchMenu } from "./nav-hooks";
import { ComposerTree, type DropTarget } from "./composer/ComposerTree";
import { DeleteMenuModal, type DeleteTarget } from "./composer/DeleteMenuModal";
import { EntityPickerModal } from "./EntityPickerModal";
import { GroupCreateModal } from "./composer/GroupCreateModal";
import {
  diffMenu,
  draftItem,
  moveItem,
  newDraftId,
  removeItem,
  type MenuDraft,
} from "./lib/menu-ops";
import type { NavNodeDTO } from "@gx/shared-types";
import { buildMenuTree, type MenuTreeNode } from "./lib/menu-tree";

export function NavComposer() {
  const { menu, isLoading, isError } = useNavMenu();
  const patch = usePatchMenu();
  const createGroup = useCreateGroup();

  const [draft, setDraft] = useState<MenuDraft[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<DropTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [pickerFor, setPickerFor] = useState<MenuTreeNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);

  // 菜单数据加载/保存成功后与本地草稿对齐
  useEffect(() => {
    if (menu) setDraft(menu.items.map((i) => ({ ...i })));
  }, [menu]);

  const dirty = useMemo(() => {
    if (!menu || !draft) return false;
    return diffMenu(menu.items, draft).length > 0;
  }, [menu, draft]);

  if (isLoading || draft === null) {
    return (
      <div className="flex h-40 items-center justify-center"><Spinner size={18} /></div>
    );
  }
  if (isError) {
    return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">菜单加载失败，刷新重试</div>;
  }

  const set = (next: MenuDraft[]) => setDraft(next);

  const handleMove = (t: DropTarget) => {
    if (!dragId) return;
    const r = moveItem(draft, dragId, t.parentId, t.index >= 9999 ? 1 << 30 : t.index);
    setHover(null);
    setDragId(null);
    if (!r.ok) {
      if (r.reason === "cycle") toast("不能拖到自身或其子容器内", "error");
      return;
    }
    set(r.items);
  };

  const rename = (id: string, label: string) => {
    set(draft.map((i) => (i.id === id ? { ...i, label: label || null } : i)));
    setEditingId(null);
  };

  const addEntities = (nodes: NavNodeDTO[]) => {
    if (!pickerFor) return;
    let next = draft;
    for (const n of nodes) {
      next = draftItem(next, {
        id: newDraftId("s"),
        type: "shortcut",
        parentId: pickerFor.item.id,
        nodeId: n.id,
        // 本地临时摘要：保存前也能显示名称/图标而非“未命名/已失效”；
        // diff 不比较 node，保存成功后以服务端回填数据对齐。
        node: {
          id: n.id,
          kind: n.kind,
          name: n.name,
          iconName: n.iconName,
          resourceType: n.resourceType,
          resourceId: n.resourceId,
          state: "alive",
        },
      });
    }
    set(next);
    setPickerFor(null);
    toast(`已添加 ${nodes.length} 项到「${pickerFor.item.label ?? "容器"}」，保存后生效`);
  };

  const confirmDelete = (mode: { kind: "cascade" } | { kind: "move"; targetParentId: string }) => {
    if (!deleteTarget) return;
    const r = removeItem(
      draft,
      deleteTarget.item.id,
      mode.kind === "cascade" ? "cascade" : "move",
      mode.kind === "move" ? mode.targetParentId : undefined,
    );
    set(r.items);
    setDeleteTarget(null);
    toast("已从草稿移除，保存后生效");
  };

  const save = () => {
    const ops = diffMenu(menu!.items, draft);
    if (ops.length === 0) {
      toast("没有需要保存的改动");
      return;
    }
    patch.mutate(ops, {
      onSuccess: () => toast(`已保存 ${ops.length} 项编排变更`, "success"),
      onError: (e) => toast(e instanceof Error ? e.message : "保存失败", "error"),
    });
  };

  const discard = () => {
    setDraft(menu!.items.map((i) => ({ ...i })));
    toast("已放弃未保存的改动");
  };

  const handleCreateGroup = (name: string) => {
    createGroup.mutate(
      { name },
      {
        onSuccess: (res) => {
          // group 在权威树创建后，作为 shortcut 挂到根层菜单使其在一级导航可见。
          // group 摘要由 tree 回填（resourceType/resourceId 为 null），本地先构造临时摘要。
          set(
            draftItem(draft, {
              id: newDraftId("g"),
              type: "shortcut",
              parentId: null,
              nodeId: res.id,
              node: {
                id: res.id,
                kind: "group",
                name,
                iconName: null,
                resourceType: null,
                resourceId: null,
                state: "alive",
              },
            }),
          );
          setGroupOpen(false);
          toast("分组已创建并加入根层导航，保存后生效");
        },
        onError: (e) => toast(e instanceof Error ? e.message : "创建分组失败", "error"),
      },
    );
  };

  const tree2 = buildMenuTree(draft);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-gx-18 font-semibold text-gx-text-primary">导航编排</h2>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
            菜单引用层：容器与快捷项可多处挂载；拖拽排序不改实体归属。软删源自动标灰，恢复后自动还原。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon="folderPlus" onClick={() => setGroupOpen(true)}>
            新建分组
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} disabled={!dirty}>
            放弃
          </Button>
          <Button size="sm" variant="primary" icon="check" onClick={save} loading={patch.isPending} disabled={!dirty}>
            保存
          </Button>
        </div>
      </div>

      {/* ComposerTree 自身窗口化滚动（S10），容器只给布局高度不再 overflow */}
      <div className="min-h-0 flex-1 rounded-gx-lg border border-gx-separator bg-gx-surface p-2">
        {tree2.length === 0 ? (
          <div className="px-3 py-10 text-center text-gx-12 text-gx-text-hint">
            菜单为空。分组创建后会出现在根层；实体可通过二级导航「收纳到导航」加入容器。
          </div>
        ) : (
          <ComposerTree
            items={draft}
            dragId={dragId}
            hover={hover}
            editingId={editingId}
            onDragStart={setDragId}
            onDragEnd={() => {
              setDragId(null);
              setHover(null);
            }}
            onMove={handleMove}
            onHoverChange={setHover}
            onRename={rename}
            onStartEdit={setEditingId}
            onAdd={(c) => setPickerFor(c)}
            onDelete={(item) => {
              const childCount = countDescendants(draft, item.id);
              setDeleteTarget({ item, childCount });
            }}
          />
        )}
      </div>

      <EntityPickerModal
        open={pickerFor !== null}
        containerName={pickerFor?.item.label ?? "容器"}
        existingNodeIds={new Set(
          draft.filter((i) => i.parentId === pickerFor?.item.id).map((i) => i.nodeId ?? ""),
        )}
        onClose={() => setPickerFor(null)}
        onPick={addEntities}
      />
      <DeleteMenuModal
        target={deleteTarget}
        items={draft}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
      <GroupCreateModal
        open={groupOpen}
        busy={createGroup.isPending}
        onClose={() => setGroupOpen(false)}
        onCreate={handleCreateGroup}
      />
    </div>
  );
}

function countDescendants(items: readonly MenuDraft[], id: string): number {
  let n = 0;
  const walk = (pid: string) => {
    for (const i of items) {
      if (i.parentId === pid) {
        n += 1;
        walk(i.id);
      }
    }
  };
  walk(id);
  return n;
}

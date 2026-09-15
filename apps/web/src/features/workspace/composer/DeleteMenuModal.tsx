// M3/S9 菜单项删除确认。
//  - shortcut：仅移除这一处菜单引用（多处挂载的其它引用不受影响）。
//  - container：二选一——级联删除（容器与其内全部菜单项一并删引用，后端随容器级联软删）
//    或移动子项到另一个容器后删除空容器。
import { useMemo, useState } from "react";
import { Button, Modal } from "../../../components/ui";
import type { MenuDraft } from "../lib/menu-ops";

export interface DeleteTarget {
  item: MenuDraft;
  childCount: number;
}

export function DeleteMenuModal({
  target,
  items,
  onConfirm,
  onClose,
}: {
  target: DeleteTarget | null;
  items: readonly MenuDraft[];
  onConfirm: (mode: { kind: "cascade" } | { kind: "move"; targetParentId: string }) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"cascade" | "move">("cascade");
  const [toId, setToId] = useState("");

  const containers = useMemo(() => {
    if (!target) return [];
    // 可选目标：非自身、非自身后代的容器
    const descendant = new Set<string>();
    const walk = (id: string) => {
      for (const i of items) {
        if (i.parentId === id) {
          descendant.add(i.id);
          walk(i.id);
        }
      }
    };
    walk(target.item.id);
    return items.filter(
      (i) => i.type === "container" && i.id !== target.item.id && !descendant.has(i.id),
    );
  }, [items, target]);

  const isContainer = target?.item.type === "container";

  return (
    <Modal open={target !== null} title={isContainer ? "删除容器" : "移除快捷方式"} onClose={onClose} width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="danger"
            disabled={isContainer && mode === "move" && !toId}
            onClick={() => {
              if (!isContainer || mode === "cascade") onConfirm({ kind: "cascade" });
              else onConfirm({ kind: "move", targetParentId: toId });
            }}
          >
            {isContainer ? "删除容器" : "移除"}
          </Button>
        </>
      }
    >
      {target && (
        <div className="flex flex-col gap-3">
          {!isContainer ? (
            <p className="text-gx-13 text-gx-text-secondary">
              从菜单移除「{target.item.label ?? target.item.node?.name ?? "未命名"}」这一处引用？
              实体本身与其它容器中的引用不受影响。
            </p>
          ) : (
            <>
              <p className="text-gx-13 text-gx-text-secondary">
                容器「{target.item.label ?? "未命名分组"}」内有 {target.childCount} 个菜单项。删除容器时：
              </p>
              <label className="flex cursor-pointer items-start gap-2 rounded-gx-md border border-gx-separator p-3">
                <input type="radio" checked={mode === "cascade"} onChange={() => setMode("cascade")} className="mt-0.5" />
                <span>
                  <span className="block text-gx-13 text-gx-text-primary">一并删除容器内全部菜单项</span>
                  <span className="mt-0.5 block text-gx-12 text-gx-text-hint">仅删菜单引用，实体不受影响</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-gx-md border border-gx-separator p-3">
                <input type="radio" checked={mode === "move"} onChange={() => setMode("move")} className="mt-0.5" />
                <span className="flex-1">
                  <span className="block text-gx-13 text-gx-text-primary">把子项移到其他容器后删除</span>
                  <select
                    value={toId}
                    onChange={(e) => setToId(e.target.value)}
                    className="mt-2 w-full rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-13"
                  >
                    <option value="">选择目标容器…</option>
                    {containers.map((c) => (
                      <option key={c.id} value={c.id}>{c.label ?? "未命名容器"}</option>
                    ))}
                  </select>
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

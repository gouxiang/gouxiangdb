// M3/S9 二级栏「移动到分组」选择模态：把实体权威移动（nav_nodes.parentId）到某 group。
// 菜单层（menu_items）拖拽不走此流；确认后由父组件调 useMoveNode，409 再走 MoveImpactModal。
import { Icon } from "../../components/icons";
import type { CollectableEntry } from "./lib/collection";
import type { NavNodeDTO } from "@gx/shared-types";

export interface MoveToGroupModalProps {
  entry: CollectableEntry | null;
  groups: NavNodeDTO[];
  busy: boolean;
  onPick: (entry: CollectableEntry, target: NavNodeDTO) => void;
  onClose: () => void;
}

export function MoveToGroupModal({ entry, groups, busy, onPick, onClose }: MoveToGroupModalProps) {
  if (!entry) return null;
  return (
    <div className="fixed inset-0 z-[800] flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/25" />
      <div
        className="relative w-full max-w-sm rounded-gx-xl bg-gx-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gx-separator px-4 py-3 text-gx-14 font-semibold text-gx-text-primary">
          移动「{entry.node.name}」到分组
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2">
          {groups.length === 0 && (
            <li className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
              暂无分组，可在「设置 → 导航编排」中新建
            </li>
          )}
          {groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(entry, g)}
                className="flex w-full items-center gap-2 rounded-gx-sm px-3 py-2 text-left text-gx-13 text-gx-text-primary hover:bg-gx-row-hover disabled:opacity-50"
              >
                <Icon name="group" size={14} className="text-gx-text-tertiary" />
                {g.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// 网格多选 / 批量操作状态
// 用 Set<string> 维护已选记录 id，提供开关、全选、清空等能力。

import { useCallback, useMemo, useState } from "react";

export interface GridSelection {
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
  count: number;
  has: (id: string) => boolean;
}

export function useGridSelection(): GridSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      if (allSelected) {
        // 取消全选
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      }
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);
  const has = isSelected;

  const count = selectedIds.size;

  return useMemo(
    () => ({ selectedIds, toggle, toggleAll, clear, isSelected, count, has }),
    [selectedIds, toggle, toggleAll, clear, isSelected, count],
  );
}

export default useGridSelection;

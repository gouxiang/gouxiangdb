// M4 权限面板左侧资源树：复用 M3 deep tree（on 态已由后端按可见性剪枝，前端不二次判权）。
// 平铺按 depth 缩进 + 搜索过滤；group/view 不参与授权不列。
import { useMemo, useState } from "react";
import { useNavTreeDeep } from "../workspace/nav-hooks";
import { navKindIcon } from "../workspace/PrimaryNav";
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import type { NavKind, NavNodeDTO } from "@gx/shared-types";

const SELECTABLE: ReadonlySet<NavKind> = new Set(["base", "kb", "table", "doc", "canvas"]);

export function PermNodeTree({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (node: NavNodeDTO) => void;
}) {
  const { tree, isLoading } = useNavTreeDeep();
  const [q, setQ] = useState("");

  const items = useMemo(() => {
    const all = (tree?.items ?? []).filter((n) => SELECTABLE.has(n.kind) && !n.deletedAt);
    const kw = q.trim().toLowerCase();
    const hits = kw ? all.filter((n) => n.name.toLowerCase().includes(kw)) : all;
    return kw
      ? hits // 搜索结果不缩进，按名称相关性足够
      : [...hits].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.ord - b.ord));
  }, [tree?.items, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gx-separator p-2">
        <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-separator bg-gx-surface px-2 py-1">
          <Icon name="search" size={13} className="shrink-0 text-gx-text-hint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索资源"
            className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-2 py-8 text-center text-gx-12 text-gx-text-hint">没有可授权的资源</div>
        ) : (
          items.map((n) => {
            const active = n.id === selectedId;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onSelect(n)}
                style={{ paddingLeft: 8 + (q ? 0 : Math.min(n.depth, 6)) * 12 }}
                className={[
                  "flex w-full items-center gap-1.5 rounded-gx-sm py-1 pr-2 text-left text-gx-13 transition-colors",
                  active
                    ? "bg-gx-accent-bg font-medium text-gx-accent"
                    : "text-gx-text-primary hover:bg-gx-row-hover",
                ].join(" ")}
              >
                <Icon name={navKindIcon(n.kind)} size={13} className="shrink-0 opacity-80" />
                <span className="min-w-0 flex-1 truncate">{n.name}</span>
                {n.dimmed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gx-text-hint" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

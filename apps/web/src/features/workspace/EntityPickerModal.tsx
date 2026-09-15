// M3/S9 添加实体到菜单（多处挂载）选择器。
//
// 数据源：nav tree 深层索引（parentId=root,maxDepth=10，普通登录通道）。只列可作为 shortcut
// 的活实体（table/doc/canvas/view 不纳入一级快捷项口径——view 随表打开）；已在当前容器有活
// shortcut 的实体打勾但仍可重复添加（多处挂载是合法形态）。
import { useMemo, useState } from "react";
import { Button, Input, Modal } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { useNavTreeDeep } from "./nav-hooks";
import type { NavKind, NavNodeDTO } from "@gx/shared-types";

type PickerKind = "table" | "doc" | "canvas";

const KIND_TABS: { key: PickerKind | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "table", label: "数据表" },
  { key: "doc", label: "文档" },
  { key: "canvas", label: "画布" },
];

const KIND_ICON: Record<PickerKind, IconName> = { table: "table", doc: "doc", canvas: "canvas" };

export function EntityPickerModal({
  open,
  containerName,
  existingNodeIds,
  onClose,
  onPick,
}: {
  open: boolean;
  containerName: string;
  /** 当前容器已引用的 nodeId 集合（显示"已在本容器"标记）。 */
  existingNodeIds: ReadonlySet<string>;
  onClose: () => void;
  onPick: (nodes: NavNodeDTO[]) => void;
}) {
  const { tree, isLoading } = useNavTreeDeep();
  const [tab, setTab] = useState<PickerKind | "all">("all");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const candidates = useMemo(() => {
    const kinds: ReadonlySet<NavKind> = new Set(
      tab === "all" ? (["table", "doc", "canvas"] as NavKind[]) : [tab],
    );
    const q = query.trim().toLowerCase();
    return (tree?.items ?? [])
      .filter((n) => !n.deletedAt && kinds.has(n.kind))
      .filter((n) => (q ? n.name.toLowerCase().includes(q) : true))
      .slice(0, 200);
  }, [tree?.items, tab, query]);

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reset = () => {
    setChosen(new Set());
    setQuery("");
    setTab("all");
  };

  const confirm = () => {
    const nodes = (tree?.items ?? []).filter((n) => chosen.has(n.id));
    onPick(nodes);
    reset();
  };

  return (
    <Modal
      open={open}
      title={`添加到「${containerName}」`}
      onClose={() => {
        reset();
        onClose();
      }}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={confirm} disabled={chosen.size === 0}>
            添加{chosen.size > 0 ? `（${chosen.size}）` : ""}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索数据表、文档、画布名称…"
        />
        <div className="flex items-center gap-1">
          {KIND_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={[
                "rounded-gx-pill px-2.5 py-1 text-gx-12 transition-colors",
                tab === t.key
                  ? "bg-gx-accent-bg font-medium text-gx-accent"
                  : "text-gx-text-secondary hover:bg-gx-row-hover",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>

        <ul className="max-h-[46vh] divide-y divide-gx-separator overflow-y-auto rounded-gx-lg border border-gx-separator">
          {isLoading ? (
            <li className="px-3 py-8 text-center text-gx-12 text-gx-text-hint">加载中…</li>
          ) : candidates.length === 0 ? (
            <li className="px-3 py-8 text-center text-gx-12 text-gx-text-hint">没有匹配的实体</li>
          ) : (
            candidates.map((n) => {
              const selected = chosen.has(n.id);
              const already = existingNodeIds.has(n.id);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => toggle(n.id)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-gx-row-hover"
                  >
                    <span
                      className={[
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-gx-sm border",
                        selected ? "border-gx-accent bg-gx-accent text-white" : "border-gx-border",
                      ].join(" ")}
                    >
                      {selected && <Icon name="check" size={11} />}
                    </span>
                    <Icon name={KIND_ICON[n.kind as PickerKind] ?? "link"} size={14} className="shrink-0 text-gx-text-tertiary" />
                    <span className="flex-1 truncate text-gx-13 text-gx-text-primary">{n.name}</span>
                    {already && (
                      <span className="shrink-0 text-gx-11 text-gx-text-hint">已在本容器</span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <p className="text-gx-11 text-gx-text-hint">同一实体可添加到多个容器；多处挂载互不影响。</p>
      </div>
    </Modal>
  );
}

// apps/web/src/components/LibrarySwitcher.tsx
// 统一库切换器：一份菜单集中展示全部「智能数据库」与「知识库」，支持搜索过滤、直接切换，
// 底部「新建库」入口打开 CreateLibraryModal（一次填写名称 + 库类型；该弹窗与一级导航的
// 与一级导航的「新建库」共用同一份建库逻辑）。
// 数据表侧栏（Sidebar）与知识库侧栏（KbSidebar）共用本组件，消除两套切换器的割裂感。
// 颜色全走 gx-* token；图标全用自建 SVG（无 emoji）。

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBases } from "../api/hooks";
import { useKbList } from "../features/kb/kb-hooks";
import { Input, Menu, MenuItem, MenuDivider, Popover } from "./ui";
import { Icon } from "./icons";
import { CreateLibraryModal } from "./CreateLibraryModal";
import { entityIconColor, isEntityIconDefault, resolveEntityIcon } from "./EntityIconPicker";
import { colors } from "@gx/design-tokens";

export type ActiveLibrary =
  | { kind: "base"; id: string | null }
  | { kind: "kb"; id: string | null };

/**
 * 切换器 + 列表。建库弹窗抽到 CreateLibraryModal（一级导航的两个明确入口复用同一份），
 * 这里只留「新建库」这一个入口，行为与抽离前一致。
 * collapsed：一级导航折叠档（56px）下只留当前库的圆点/图标 + tooltip，不显示名称与箭头。
 */
export function LibrarySwitcher({ active, collapsed = false }: { active: ActiveLibrary; collapsed?: boolean }) {
  const navigate = useNavigate();
  const { data: bases } = useBases();
  const { data: kbs } = useKbList();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);

  const q = query.trim().toLowerCase();
  const filteredBases = useMemo(
    () => (bases ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)),
    [bases, q],
  );
  const filteredKbs = useMemo(
    () => (kbs ?? []).filter((k) => !q || k.name.toLowerCase().includes(q)),
    [kbs, q],
  );

  const currentName =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id)?.name ?? null
      : kbs?.find((k) => k.id === active.id)?.name ?? null;
  const currentColor =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id)?.iconColor ?? colors.textTertiary
      : kbs?.find((k) => k.id === active.id)?.iconColor ?? colors.accent;

  /**
   * 切换器头部：默认仍是「圆点」（未自定义时逐像素保持原样）；
   * 实体自定义了【图标】才换成图标渲染，颜色取自定义色（未设色时用各类型的既有默认色）。
   */
  const currentEntity =
    active.kind === "base"
      ? bases?.find((b) => b.id === active.id) ?? null
      : kbs?.find((k) => k.id === active.id) ?? null;
  const currentCustomized = !isEntityIconDefault(currentEntity);
  const currentResolved = resolveEntityIcon(currentEntity, {
    name: active.kind === "base" ? "database" : "book",
    color: currentColor,
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? (currentName ?? "选择库") : undefined}
        aria-label={collapsed ? `当前库：${currentName ?? "未选择"}` : undefined}
        className={[
          "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left hover:bg-gx-row-hover",
          collapsed ? "justify-center px-0" : "",
        ].join(" ")}
      >
        {currentCustomized ? (
          <Icon
            name={currentResolved.name}
            size={14}
            className="shrink-0"
            style={currentResolved.color ? { color: currentResolved.color } : undefined}
          />
        ) : (
          <span
            className="h-4 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: currentColor }}
          />
        )}
        {collapsed ? null : (
          <>
            <span className="flex-1 truncate text-gx-13 font-medium text-gx-text-primary">
              {currentName ?? "选择库"}
            </span>
            <Icon name="chevronDown" size={14} className="text-gx-text-tertiary" />
          </>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={264}>
        <div className="p-2">
          <Input
            autoFocus
            placeholder="搜索数据库 / 知识库"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Menu width={264}>
          <div className="max-h-[60vh] overflow-y-auto">
            {filteredBases.length > 0 && (
              <>
                <div className="px-3 py-1 text-gx-11 font-medium text-gx-text-hint">智能数据库</div>
                {filteredBases.map((b) => (
                  <MenuItem
                    key={`b-${b.id}`}
                    // 库切换器下拉：读实体自定义图标 + 自定义色（修掉原来写死 database 且丢色）
                    icon={resolveEntityIcon(b, { name: "database" }).name}
                    iconColor={entityIconColor(b)}
                    label={b.name}
                    active={active.kind === "base" && b.id === active.id}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/base/${b.id}`);
                    }}
                  />
                ))}
              </>
            )}

            {filteredKbs.length > 0 && (
              <>
                <div className="mt-1 px-3 py-1 text-gx-11 font-medium text-gx-text-hint">知识库</div>
                {filteredKbs.map((k) => (
                  <MenuItem
                    key={`k-${k.id}`}
                    icon={resolveEntityIcon(k, { name: "book" }).name}
                    iconColor={entityIconColor(k)}
                    label={k.name}
                    active={active.kind === "kb" && k.id === active.id}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/kb/${k.id}`);
                    }}
                  />
                ))}
              </>
            )}

            {filteredBases.length === 0 && filteredKbs.length === 0 && (
              <div className="px-3 py-2 text-gx-12 text-gx-text-hint">没有匹配的库</div>
            )}
          </div>
          <MenuDivider />
          <MenuItem icon="plus" label="新建库" onClick={() => { setOpen(false); setShowNew(true); }} />
        </Menu>
      </Popover>

      <CreateLibraryModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}

// apps/web/src/features/help/HelpCenterToc.tsx
// 帮助中心左侧目录：标题过滤（搜索框）+ 点击滚动定位 + 当前标题高亮。
//
// 自身滚动：目录过长时只滚目录（max-h/overflow-y-auto），不牵动右侧正文。
// 紧凑档（<1024）由外层收进顶部抽屉，这里只负责「内容 + 过滤 + 选中」，不关心摆放。

import { useMemo, useState } from "react";

import { Icon } from "../../components/icons";
import { Input } from "../../components/ui";
import type { HelpHeading } from "./help-html";

export interface HelpCenterTocProps {
  headings: readonly HelpHeading[];
  /** 当前阅读到的标题锚点 id（右侧正文滚动时回传） */
  activeId: string;
  onSelect: (id: string) => void;
  /** 紧凑档：目录在抽屉内，限高自身滚动，避免顶掉正文 */
  compact?: boolean;
}

/** 目录行缩进：按标题层级递进（h1 平齐，h3 起缩进），与正文层级对应。 */
const INDENT_CLASS: Record<number, string> = {
  1: "pl-0",
  2: "pl-0",
  3: "pl-3",
  4: "pl-6",
  5: "pl-9",
  6: "pl-12",
};

export function HelpCenterToc({ headings, activeId, onSelect, compact = false }: HelpCenterTocProps) {
  const [query, setQuery] = useState("");

  // 过滤只看标题文本（中文按子串匹配即可，不做分词）；空串返回全量。
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter((h) => h.text.toLowerCase().includes(q));
  }, [headings, query]);

  return (
    <nav
      className={[
        "flex min-h-0 flex-col gap-gx-xs",
        compact ? "max-h-[45vh] overflow-y-auto" : "h-full overflow-y-auto",
      ].join(" ")}
      aria-label="帮助中心目录"
    >
      <div className="relative shrink-0">
        <Icon
          name="search"
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gx-text-hint"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索章节"
          aria-label="搜索章节"
          className="pl-8"
        />
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-2 text-gx-12 text-gx-text-hint">没有匹配的章节</p>
      ) : (
        <ul className="flex flex-col gap-gx-xxs">
          {visible.map((h) => {
            const active = h.id === activeId;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => onSelect(h.id)}
                  aria-current={active ? "true" : undefined}
                  className={[
                    "w-full rounded-gx-sm px-2 py-1 text-left text-gx-13 transition-colors duration-[120ms]",
                    INDENT_CLASS[h.level] ?? "pl-0",
                    active
                      ? "bg-gx-accent-bg font-medium text-gx-accent"
                      : "text-gx-text-secondary hover:bg-gx-row-hover hover:text-gx-text-primary",
                  ].join(" ")}
                >
                  <span className="block truncate">{h.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

export default HelpCenterToc;

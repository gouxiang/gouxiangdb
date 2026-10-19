// apps/web/src/features/help/HelpCenterToc.tsx
// 帮助中心左侧目录：百科全站页面列表 + 标题过滤（搜索框）+ 当前页高亮。
//
// 与旧版区别：目录不再是单篇长文的页内标题 TOC，而是后端 /api/help/wiki 返回的
// 全站页面列表；点击即切换百科页面。页内章节锚点仍保留在正文 HTML 里（help-html.ts
// 的 attachHeadingIds），只是左栏不再驱动滚动 spy。
//
// 自身滚动：列表过长时只滚目录（max-h/overflow-y-auto），不牵动右侧正文。
// 紧凑档（<1024）由外层收进顶部抽屉，这里只负责「列表 + 过滤 + 选中」，不关心摆放。

import { useMemo, useState } from "react";

import { Icon } from "../../components/icons";
import { Input } from "../../components/ui";
import { filterHelpPages, type WikiPageEntry } from "./help-html";

export interface HelpCenterTocProps {
  /** 百科全站页面列表（至少含 Home）。 */
  pages: readonly WikiPageEntry[];
  /** 当前页标题（用于高亮）。 */
  activeTitle: string;
  onSelect: (title: string) => void;
  /** 紧凑档：目录在抽屉内，限高自身滚动，避免顶掉正文 */
  compact?: boolean;
}

export function HelpCenterToc({ pages, activeTitle, onSelect, compact = false }: HelpCenterTocProps) {
  const [query, setQuery] = useState("");

  // 过滤只看页面标题（中文按子串匹配即可，不做分词）；空串返回全量。
  const visible = useMemo(() => filterHelpPages(pages, query), [pages, query]);

  return (
    <nav
      className={[
        "flex min-h-0 flex-col gap-gx-xs",
        compact ? "max-h-[45vh] overflow-y-auto" : "h-full overflow-y-auto",
      ].join(" ")}
      aria-label="帮助百科页面目录"
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
          placeholder="搜索页面"
          aria-label="搜索帮助页面"
          className="pl-8"
        />
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-2 text-gx-12 text-gx-text-hint">没有匹配的页面</p>
      ) : (
        <ul className="flex flex-col gap-gx-xxs">
          {visible.map((p) => {
            const active = p.title === activeTitle;
            return (
              <li key={p.title}>
                <button
                  type="button"
                  onClick={() => onSelect(p.title)}
                  aria-current={active ? "true" : undefined}
                  className={[
                    "w-full rounded-gx-sm px-2 py-1 text-left text-gx-13 transition-colors duration-[120ms]",
                    active
                      ? "bg-gx-accent-bg font-medium text-gx-accent"
                      : "text-gx-text-secondary hover:bg-gx-row-hover hover:text-gx-text-primary",
                  ].join(" ")}
                >
                  <span className="block truncate">{p.title}</span>
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

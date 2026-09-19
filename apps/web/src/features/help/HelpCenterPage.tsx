// apps/web/src/features/help/HelpCenterPage.tsx
// 帮助中心预览页：左侧目录（可搜索 / 自身滚动 / 当前标题高亮）+ 右侧正文（md 渲染）。
//
// 内容真源：docs/help-center/HELP-CENTER.md → scripts/sync-help-center.mjs 同步到
// ./generated/help-center.md → 这里以 `?raw` 取文本 → renderMarkdown（@gx/blocks）
// → 配图相对路径映射（部署基路径）→ sanitizeHtml → 锚点回注（见 help-html.ts）。
//
// 响应式：<1024（断点 sm/md）目录收进顶部抽屉（在流内展开，不覆盖正文）；≥1024 常驻左栏。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../components/icons";
import { useBreakpointTier } from "../../lib/breakpoint";
import { resolveApiBase } from "../../lib/base";
import HelpCenterToc from "./HelpCenterToc";
import { buildHelpHtml } from "./help-html";
import HELP_MD from "./generated/help-center.md?raw";

/**
 * 部署基路径（""=根部署，"/app/gouxiangdb"=子路径）。
 * 只吃 import.meta.env.BASE_URL、不吃 VITE_API_URL：配图由静态服务在页面同源 base 下提供，
 * 与后端 API 是否跨域无关，故不能复用 API_BASE_URL。
 */
const HELP_BASE = resolveApiBase(undefined, import.meta.env.BASE_URL as string | undefined);

/** 正文排版：sanitizeHtml 会剥掉 md-* 类名，故一律用标签型 arbitrary 变体 + gx token。 */
const ARTICLE_CLASS = [
  "mx-auto max-w-[75ch] text-gx-13 leading-6 text-gx-text-primary",
  "[&_h1]:mt-0 [&_h1]:mb-gx-md [&_h1]:text-gx-20 [&_h1]:font-semibold",
  "[&_h2]:mt-gx-xl [&_h2]:mb-gx-sm [&_h2]:border-b [&_h2]:border-gx-separator [&_h2]:pb-gx-xs [&_h2]:text-gx-16 [&_h2]:font-semibold",
  "[&_h3]:mt-gx-lg [&_h3]:mb-gx-xs [&_h3]:text-gx-14 [&_h3]:font-medium",
  "[&_p]:my-gx-sm",
  "[&_ul]:my-gx-sm [&_ul]:list-disc [&_ul]:pl-gx-xl",
  "[&_ol]:my-gx-sm [&_ol]:list-decimal [&_ol]:pl-gx-xl",
  "[&_li]:my-gx-xxs",
  "[&_a]:text-gx-accent [&_a]:underline",
  "[&_code]:rounded-gx-sm [&_code]:bg-gx-bg [&_code]:px-1 [&_code]:text-gx-12",
  "[&_pre]:my-gx-md [&_pre]:overflow-x-auto [&_pre]:rounded-gx-lg [&_pre]:bg-gx-bg [&_pre]:p-gx-md [&_pre]:text-gx-12",
  "[&_blockquote]:my-gx-md [&_blockquote]:border-l-2 [&_blockquote]:border-gx-border [&_blockquote]:pl-gx-md [&_blockquote]:text-gx-text-secondary",
  "[&_img]:my-gx-md [&_img]:max-w-full [&_img]:rounded-gx-lg [&_img]:border [&_img]:border-gx-separator",
  "[&_table]:my-gx-md [&_table]:w-full [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-gx-separator [&_th]:bg-gx-table-header [&_th]:px-gx-sm [&_th]:py-gx-xs",
  "[&_td]:border [&_td]:border-gx-separator [&_td]:px-gx-sm [&_td]:py-gx-xs",
  "[&_hr]:my-gx-lg [&_hr]:border-gx-separator",
].join(" ");

export default function HelpCenterPage() {
  const tier = useBreakpointTier();
  // <1024：目录收进顶部抽屉（sm <768、md 768–1023 两档）
  const compact = tier === "sm" || tier === "md";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { html, headings } = useMemo(() => buildHelpHtml(HELP_MD, HELP_BASE), []);
  const [activeId, setActiveId] = useState(() => headings[0]?.id ?? "");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  /** 当前章节 = 最后一个「已滚过容器顶线」的标题（+8px 容差，避免边界反复横跳）。 */
  const syncActive = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const boxTop = box.getBoundingClientRect().top;
    let current = headings[0]?.id ?? "";
    box.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((el) => {
      if (el.getBoundingClientRect().top - boxTop <= 8) current = el.id || current;
    });
    setActiveId((prev) => (prev === current ? prev : current));
  }, [headings]);

  // 滚动是高频事件：一帧最多算一次，避免长文档下每帧同步十几个标题位置
  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncActive();
    });
  }, [syncActive]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const scrollToHeading = useCallback((id: string) => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!box || !el) return;
    // 尊重系统「减少动效」：直接跳位不做平滑滚动
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    box.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: reduced ? "auto" : "smooth" });
    setActiveId(id);
    setDrawerOpen(false);
  }, []);

  const toc = (
    <HelpCenterToc
      compact={compact}
      headings={headings}
      activeId={activeId}
      onSelect={scrollToHeading}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-surface">
      {compact ? (
        <header className="flex shrink-0 items-center justify-between border-b border-gx-separator px-gx-md py-gx-xs">
          <span className="text-gx-14 font-medium text-gx-text-primary">目录</span>
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            className="flex items-center gap-1 rounded-gx-sm px-2 py-1 text-gx-13 text-gx-text-secondary transition-colors duration-[120ms] hover:bg-gx-row-hover hover:text-gx-text-primary"
          >
            <Icon name={drawerOpen ? "chevronUp" : "list"} size={14} />
            <span>{drawerOpen ? "收起" : "展开"}</span>
          </button>
        </header>
      ) : null}

      {/* 抽屉在流内展开（不覆盖正文）：窄屏下宁可把正文往下推，也不让用户够不着标题 */}
      {compact && drawerOpen ? (
        <div className="shrink-0 border-b border-gx-separator bg-gx-bg px-gx-md py-gx-sm">{toc}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {compact ? null : (
          <aside className="w-56 shrink-0 border-r border-gx-separator bg-gx-bg p-gx-sm">{toc}</aside>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg"
        >
          {html ? (
            <article className={ARTICLE_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <p className="text-gx-13 text-gx-text-hint">
              帮助内容尚未生成：请先运行 <code>pnpm --filter @gx/web run sync:help</code>。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

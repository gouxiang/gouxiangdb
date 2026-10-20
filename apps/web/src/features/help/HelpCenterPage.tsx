// apps/web/src/features/help/HelpCenterPage.tsx
// 帮助中心：左侧百科全站页面目录（可搜索 / 自身滚动 / 当前页高亮）+ 右侧在线百科正文。
//
// 内容真源：后端同源代理 GET /api/help/wiki?page=<标题>（见 help-api.ts），拉到的是
// Gitea wiki markdown 原文（图片路径已由后端改写成同源 /api/help/asset?path=...）。
// 管线：rewriteWikiLinks（双链切内部切页链接）→ renderMarkdown（@gx/blocks）
//       → sanitizeHtml → 锚点回注（见 help-html.ts）。
// 离线/502：正文区给中文友好提示 + 重试，不白屏、不抛英文堆栈；已缓存的页面列表仍展示。
//
// 响应式：<1024（断点 sm/md）目录收进顶部抽屉（在流内展开，不覆盖正文）；≥1024 常驻左栏。

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { Icon } from "../../components/icons";
import { useBreakpointTier } from "../../lib/breakpoint";
import { ApiError } from "../../api/client";
import { fetchHelpWiki, WIKI_UNREACHABLE } from "./help-api";
import HelpCenterToc from "./HelpCenterToc";
import { buildHelpHtml, WIKI_PAGE_HASH_PREFIX, type WikiPageEntry } from "./help-html";

const HOME_PAGE = "Home";

/** 后端契约保证 pages 至少含 Home：首次请求未回来前先用它占位，左栏不至于全空。 */
const FALLBACK_PAGES: WikiPageEntry[] = [{ title: HOME_PAGE, href: HOME_PAGE }];

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

type LoadState = "loading" | "ready" | "error";

export default function HelpCenterPage() {
  const tier = useBreakpointTier();
  // <1024：目录收进顶部抽屉（sm <768、md 768–1023 两档）
  const compact = tier === "sm" || tier === "md";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [pages, setPages] = useState<WikiPageEntry[]>(FALLBACK_PAGES);
  const [activeTitle, setActiveTitle] = useState(HOME_PAGE);
  const [markdown, setMarkdown] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  // 最近一次正文是否来自后端离线持久缓存（cached:true）；仅控制顶部陈旧提示条，不进 error 态。
  const [cached, setCached] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 旧请求晚回来不得覆盖新页：每次发请求自增，回调只认最新一次
  const reqSeqRef = useRef(0);

  const loadPage = useCallback((title: string) => {
    const seq = ++reqSeqRef.current;
    setState("loading");
    setCached(false);
    fetchHelpWiki(title)
      .then((data) => {
        if (seq !== reqSeqRef.current) return;
        setActiveTitle(data.page || title);
        setMarkdown(data.markdown ?? "");
        if (Array.isArray(data.pages) && data.pages.length > 0) setPages(data.pages);
        setCached(data.cached === true);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (seq !== reqSeqRef.current) return;
        // 502 WIKI_UNREACHABLE（百科离线）与网络异常统一中文降级；控制台留机器码便于排查
        if (err instanceof ApiError) {
          if (err.status !== 502 || err.body?.code !== WIKI_UNREACHABLE) {
            console.warn("[help] wiki request failed", err.status, err.body?.code);
          }
        } else {
          console.warn("[help] wiki request failed", err);
        }
        setState("error");
      });
  }, []);

  useEffect(() => {
    loadPage(HOME_PAGE);
  }, [loadPage]);

  const selectPage = useCallback(
    (title: string) => {
      setActiveTitle(title);
      setDrawerOpen(false);
      scrollRef.current?.scrollTo({ top: 0 });
      loadPage(title);
    },
    [loadPage],
  );

  // 双链点击：事件委托拦截 a[href^="#help-page/"]，decode 出页面名后切页，
  // preventDefault 阻止浏览器改 hash / 跳锚点。
  const onContentClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        `a[href^="${WIKI_PAGE_HASH_PREFIX}"]`,
      );
      if (!anchor) return;
      e.preventDefault();
      const raw = anchor.getAttribute("href") ?? "";
      const encoded = raw.slice(WIKI_PAGE_HASH_PREFIX.length);
      try {
        const title = decodeURIComponent(encoded);
        if (title) selectPage(title);
      } catch {
        // 非法百分号编码：忽略这次点击，不导航
      }
    },
    [selectPage],
  );

  const { html } = useMemo(() => buildHelpHtml(markdown), [markdown]);

  const toc = (
    <HelpCenterToc
      compact={compact}
      pages={pages}
      activeTitle={activeTitle}
      onSelect={selectPage}
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

      {/* 抽屉在流内展开（不覆盖正文）：窄屏下宁可把正文往下推，也不让用户够不着目录 */}
      {compact && drawerOpen ? (
        <div className="shrink-0 border-b border-gx-separator bg-gx-bg px-gx-md py-gx-sm">{toc}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {compact ? null : (
          <aside className="w-56 shrink-0 border-r border-gx-separator bg-gx-bg p-gx-sm">{toc}</aside>
        )}
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg">
          {state === "loading" ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-gx-13 text-gx-text-hint">加载中…</p>
            </div>
          ) : state === "error" ? (
            <div className="mx-auto flex max-w-[75ch] flex-col items-start gap-gx-sm py-gx-xl">
              <div className="flex items-center gap-2">
                <Icon name="alertCircle" size={18} className="text-gx-text-secondary" />
                <h1 className="m-0 text-gx-16 font-semibold text-gx-text-primary">
                  暂时无法连接帮助百科
                </h1>
              </div>
              <p className="m-0 text-gx-13 text-gx-text-secondary">请检查网络或稍后重试。</p>
              <button
                type="button"
                onClick={() => loadPage(activeTitle)}
                className="mt-gx-xs inline-flex h-8 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-control px-3 text-gx-13 text-gx-text-secondary transition-colors duration-[120ms] hover:bg-gx-row-hover hover:text-gx-text-primary"
              >
                <Icon name="refresh" size={14} />
                <span>重试</span>
              </button>
            </div>
          ) : (
            <>
              {cached ? (
                <div
                  role="status"
                  className="mx-auto mb-gx-md flex max-w-[75ch] items-center gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg px-gx-md py-gx-xs text-gx-12 text-gx-text-secondary"
                >
                  <Icon name="clock" size={14} className="shrink-0 text-gx-text-hint" />
                  <span className="m-0">
                    当前为离线缓存的帮助内容，可能不是最新，联网后将自动刷新
                  </span>
                </div>
              ) : null}
              <article
                className={ARTICLE_CLASS}
                dangerouslySetInnerHTML={{ __html: html }}
                onClick={onContentClick}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

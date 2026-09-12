// apps/web/src/features/kb/DocOutline.tsx
// 右侧悬浮目录：基于正文中的 H1–H3 自动生成缩进树。
// - 编辑（WYSIWYG/源码切预览）、预览、公开分享页均展示（直接读容器内真实 h1/h2/h3 DOM）
// - fixed 定位：相对视口右侧悬浮、垂直居中，正文滚动时位置不动，不遮挡居中正文
// - 点击平滑滚动定位：显式在"滚动容器"上 scrollTo（避免 scrollIntoView 连锁触发多个
//   嵌套滚动容器/抢占窗口滚动，曾导致分享页跳转后滚动手势失效）
// - 滚动时 IntersectionObserver（root 绑定同一滚动容器）联动高亮当前标题

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

interface Heading {
  level: 1 | 2 | 3;
  text: string;
  el: HTMLElement;
}

/** 在 root 内部/祖先链中找到真正负责滚动的容器（overflowY auto/scroll 且有溢出） */
function findScrollContainer(root: HTMLElement): HTMLElement | Window {
  let el: HTMLElement | null = root;
  for (let i = 0; i < 8 && el; i++) {
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) {
      return el;
    }
    // 优先在 root 内部找（公开页/编辑器的内部滚动层）
    const inner = el.querySelector<HTMLElement>(
      ".kb-md-preview-scroll, .kb-wy-scroll, [data-outline-scroll]",
    );
    if (inner) {
      const cs2 = getComputedStyle(inner);
      const oy2 = cs2.overflowY;
      if ((oy2 === "auto" || oy2 === "scroll") && inner.scrollHeight > inner.clientHeight + 4) {
        return inner;
      }
    }
    el = el.parentElement;
  }
  return window;
}

export function DocOutline({ rootRef, hidden }: { rootRef: RefObject<HTMLElement | null>; hidden?: boolean }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [scrollEl, setScrollEl] = useState<HTMLElement | Window | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (hidden) return;
    const root = rootRef.current;
    if (!root) return;

    const scan = () => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3"));
      const list: Heading[] = nodes
        .filter((el) => {
          const t = el.textContent?.trim();
          return !!t && el.offsetParent !== null; // 仅可见
        })
        .map((el) => ({
          level: Number(el.tagName.charAt(1)) as 1 | 2 | 3,
          text: el.textContent?.trim().slice(0, 32) ?? "",
          el,
        }));
      setHeadings(list);
      setScrollEl(findScrollContainer(root));
    };

    const schedule = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(scan);
    };

    scan();
    // 内容/模式切换会改 DOM：MutationObserver 兜底
    const mo = new MutationObserver(schedule);
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    const timer = setInterval(scan, 1000); // 轻量轮询，弥补 contentEditable 内部变更
    return () => {
      mo.disconnect();
      clearInterval(timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [rootRef, hidden]);

  // 滚动联动高亮：observer root 绑定实际滚动容器
  useEffect(() => {
    if (hidden || headings.length === 0 || !scrollEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const idx = headings.findIndex((h) => h.el === visible[0]!.target);
          if (idx >= 0) setActiveIdx(idx);
        }
      },
      { root: scrollEl instanceof Window ? null : scrollEl, rootMargin: "-72px 0px -68% 0px", threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h.el));
    return () => observer.disconnect();
  }, [headings, hidden, scrollEl]);

  const indent = useMemo(() => ({ 1: 0, 2: 12, 3: 24 }), []);

  if (hidden || headings.length === 0) return null;

  function jump(h: Heading) {
    const idx = headings.findIndex((x) => x.el === h.el);
    if (idx >= 0) setActiveIdx(idx);
    // 显式滚动容器定位：heading 相对容器顶部的偏移 + 容器当前滚动 - 顶部留白
    const sc = scrollEl ?? findScrollContainer(rootRef.current!);
    const scRect = sc instanceof Window ? { top: 0 } : sc.getBoundingClientRect();
    const hRect = h.el.getBoundingClientRect();
    const topGap = 64; // 避开顶栏
    if (sc instanceof Window) {
      const target = window.scrollY + hRect.top - scRect.top - topGap;
      window.scrollTo({ top: target, behavior: "smooth" });
    } else {
      const target = sc.scrollTop + (hRect.top - scRect.top) - topGap;
      sc.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  return (
    <nav
      className="kb-outline pointer-events-auto fixed right-5 top-1/2 z-30 w-52 max-h-[70vh] -translate-y-1/2 overflow-y-auto rounded-gx-xl border border-gx-separator/70 bg-gx-surface/85 p-2 shadow-lg shadow-black/5 backdrop-blur-md"
      aria-label="文档目录"
    >
      <div className="mb-1.5 flex items-center gap-1.5 px-1.5 pt-0.5 text-gx-11 font-medium text-gx-text-hint">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gx-text-hint">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none" />
        </svg>
        目录
      </div>
      <div className="flex flex-col gap-px">
        {headings.map((h, i) => {
          const active = i === activeIdx;
          return (
            <button
              key={i}
              type="button"
              onClick={() => jump(h)}
              className={`group relative flex w-full items-center rounded-gx-md py-1 pr-2 text-left text-gx-12 leading-snug transition-colors duration-150 ${
                active
                  ? "bg-gx-accent-bg font-medium text-gx-accent"
                  : "text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
              }`}
              style={{ paddingLeft: `${8 + indent[h.level]}px` }}
              title={h.text}
            >
              {active && <span className="absolute left-1.5 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-gx-accent" />}
              <span className={`truncate ${h.level !== 1 ? "" : "font-medium"}`}>{h.text}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

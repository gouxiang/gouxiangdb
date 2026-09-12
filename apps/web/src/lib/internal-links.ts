// apps/web/src/lib/internal-links.ts
// 文档/单元格内的「内部链接」协议：用应用路由路径作 Markdown 链接 href，
// 渲染时区分内/外链——内部链接走 SPA 路由跳转（不新开标签、不刷新整页），
// 外部链接(http/https/data/mailto 等)保持新窗口打开。
//
// 支持的内部目标：
//   知识库文档  /kb/:kbId/doc/:docId
//   知识库画布  /kb/:kbId/canvas/:docId
//   知识库首页  /kb/:kbId
//   数据表      /base/:baseId/table/:tableId
//   表单等      /base/:baseId/...

export type InternalTarget =
  | { kind: "doc"; kbId: string; docId: string }
  | { kind: "canvas"; kbId: string; docId: string }
  | { kind: "kb"; kbId: string }
  | { kind: "table"; baseId: string; tableId: string; recordId?: string }
  | { kind: "base"; baseId: string };

/** 构造内部目标的应用路由路径 */
export function internalHref(t: InternalTarget): string {
  switch (t.kind) {
    case "doc":
      return `/kb/${t.kbId}/doc/${t.docId}`;
    case "canvas":
      return `/kb/${t.kbId}/canvas/${t.docId}`;
    case "kb":
      return `/kb/${t.kbId}`;
    case "table":
      return `/base/${t.baseId}/table/${t.tableId}${t.recordId ? `?record=${t.recordId}` : ""}`;
    case "base":
      return `/base/${t.baseId}`;
  }
}

/** 判断一个 href 是否为应用内部链接（相对路径或同源绝对路径） */
export function isInternalHref(href: string): boolean {
  if (!href) return false;
  const h = href.trim();
  // 绝对外部协议：http(s)/mailto/tel/data/blob/ftp/锚点 → 非内部（data: 媒体资源不算导航）
  if (/^(https?:|mailto:|tel:|data:|blob:|ftp:|javascript:|#)/i.test(h)) return false;
  // 以 / 开头的应用内路径
  if (h.startsWith("/")) return h.startsWith("/kb") || h.startsWith("/base");
  return false;
}

/** 危险协议（可执行脚本/可导航到伪协议）一律拦截 */
function isDangerousHref(href: string): boolean {
  return /^(javascript|vbscript|data:text\/html)/i.test(href.trim());
}

/**
 * 全局/容器级点击委托：拦截 Markdown 渲染区里 <a> 的点击。
 * 内部链接 → navigate(spa)；危险协议 → 阻止默认行为（防 XSS）；外部 → 交给默认行为（新窗口）。
 * 返回一个 onClick 处理器，绑定到渲染容器即可。
 */
export function makeLinkClickHandler(
  navigate: (path: string) => void,
): (e: React.MouseEvent<HTMLElement>) => void {
  return (e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (isDangerousHref(href)) {
      // 兜底防线：渲染层已降级危险协议，此处再拦一次（防绕过/历史脏数据）
      e.preventDefault();
      return;
    }
    if (isInternalHref(href)) {
      e.preventDefault();
      // 去掉 query 中 record 之外的多余部分直接导航；record 由目标页自行处理
      navigate(href);
    }
    // 外部链接：保持默认（markdown 渲染已带 target=_blank rel=noreferrer）
  };
}

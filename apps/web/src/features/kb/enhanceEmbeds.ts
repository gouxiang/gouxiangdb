// apps/web/src/features/kb/enhanceEmbeds.ts
// 预览/分享页增强：renderMarkdown 输出的两类占位节点挂载为可交互预览器——
//   <div class="md-canvas-embed" data-canvas-doc>  → <CanvasEmbed />（画布，只读预览 + 跳转 + 弹窗编辑）
//   <div class="md-table-embed" data-table-id>     → <TableEmbed />（数据表，读写档位随宿主分享档位）
// 用独立 React root 挂载，卸载时清理，避免与 dangerouslySetInnerHTML 的静态 HTML 冲突。
// 注意①：独立 root 不在主应用 Provider 树内，必须自行包 QueryClientProvider；
// 注意②（P2-A）：同一原因，root 内的子树过去也拿不到 Router context——而增强层
//   （GxLinkBlockView / DocRefCard / RefEmbedBody 等）直用 useNavigate，
//   于是「文档里嵌的画布点开编辑 → 弹窗里出现关联块」这条链路会直接抛
//   "useNavigate() may be used only in the context of a <Router>"（改 P2 之前就存在）。
//   这里用一个隔离的 MemoryRouter 提供 context，并用 NavBridge 把发生在
//   memory history 里的导航转发给调用方注入的 onNavigate——真实跳转仍由外层 router 完成。

import { createRoot } from "react-dom/client";
import { createElement, Fragment, useEffect, useRef, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasEmbed } from "./CanvasEmbed";
import { TableEmbed } from "./TableEmbed";
import { EmbedDepthFallback } from "./EmbedDepthFallback";
import { EmbedChainContext, planEmbed, ROOT_EMBED_CHAIN, type EmbedChain } from "./embed-depth";

const roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>();

/**
 * 把独立 root 内发生的导航导出来。
 * MemoryRouter 只解决「useNavigate 有 context」；它内部的跳转不会真的改浏览器地址，
 * 因此监听 location.key 的变化（同址重复 push 也会换 key），把目标转交给外层真实 router。
 */
function NavBridge({
  onNavigate,
  children,
}: {
  onNavigate?: (path: string) => void;
  children?: ReactNode;
}) {
  const location = useLocation();
  const lastKey = useRef(location.key);
  useEffect(() => {
    if (location.key === lastKey.current) return;
    lastKey.current = location.key;
    onNavigate?.(`${location.pathname}${location.search}${location.hash}`);
  }, [location, onNavigate]);
  return createElement(Fragment, null, children);
}

// 独立 root 专用 QueryClient（与主应用配置保持一致：不做窗口聚焦刷新）
const embedQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

export interface EnhanceEmbedOpts {
  kbId?: string;
  canEdit: boolean;
  /** 公开分享页：传入分享 token，嵌入画布走匿名 PublicApi；内部页不传 */
  publicToken?: string;
  /**
   * 跳转导航回调。独立 root 现在自带 MemoryRouter（子树可用 useNavigate），
   * 但 memory 内的跳转不会真的改地址，仍由本回调交给外层真实 router 落地；
   * 公开分享页不注入 → 站内目标一律不出跳转入口。
   */
  onNavigate?: (path: string) => void;
  /**
   * 渲染这段 markdown 的实体所处的嵌入链（P2-A）。调用方负责把「宿主自己」并进祖先
   * （用 chainWithSelf），本函数不再重复推导宿主身份。缺省即根链——顶层文档预览。
   */
  chain?: EmbedChain;
  /**
   * 内嵌【数据表】预览的写权限（与 canEdit 分开，两者来源不同）：
   *   - 登录态：不传 → 由调用方按「宿主文档是否可编辑」传 !readOnly
   *   - 分享态：由宿主文档/画布的分享档位 mode 决定（mode==="edit" 才 true）；
   *     正文能否写看宿主 canEdit，嵌入表能否写看 mode，两者独立。
   */
  embedCanEdit?: boolean;
}

export function enhanceCanvasEmbeds(container: HTMLElement, opts: EnhanceEmbedOpts): () => void {
  const placeholders = container.querySelectorAll<HTMLElement>(".md-canvas-embed[data-canvas-doc]");
  const mounted: Array<[HTMLElement, ReturnType<typeof createRoot>]> = [];
  const chain = opts.chain ?? ROOT_EMBED_CHAIN;
  placeholders.forEach((ph) => {
    const docId = ph.dataset.canvasDoc ?? "";
    if (!docId) return;
    if (roots.has(ph)) return; // 已挂载
    const root = createRoot(ph);
    roots.set(ph, root);
    mounted.push([ph, root]);

    // P2-A：问 planEmbed 要放行意见。成环 / 超限一律挂载降级卡——它不取数也不再有子节点，
    // 渲染链在此终止；放行则把「已含 target 自身」的新链交给 CanvasEmbed 的子树，
    // 使画布内的关联卡走到 RefEmbedCard 时能继承到完整祖先集合。
    const plan = planEmbed(docId, chain);
    const inner =
      plan.kind === "render" ? (
        createElement(
          QueryClientProvider,
          { client: embedQueryClient },
          createElement(
            EmbedChainContext.Provider,
            { value: plan.chain },
            createElement(CanvasEmbed, {
              docId,
              kbId: opts.kbId,
              canEdit: opts.canEdit,
              publicToken: opts.publicToken,
              onNavigate: opts.onNavigate,
            }),
          ),
        )
      ) : (
        createElement(EmbedDepthFallback, {
          docId,
          kind: plan.kind,
          kbId: opts.kbId,
          onNavigate: opts.onNavigate,
        })
      );
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(NavBridge, { onNavigate: opts.onNavigate }, inner),
      ),
    );
  });
  // 数据表内嵌：占位节点 .md-table-embed[data-table-id] → TableEmbed。
  // 数据表不参与 doc/canvas 的嵌套环判定（它既不是 doc 也不是 canvas），故不问 planEmbed。
  const tablePlaceholders = container.querySelectorAll<HTMLElement>(".md-table-embed[data-table-id]");
  tablePlaceholders.forEach((ph) => {
    const tableId = ph.dataset.tableId ?? "";
    if (!tableId) return;
    if (roots.has(ph)) return; // 已挂载
    const root = createRoot(ph);
    roots.set(ph, root);
    mounted.push([ph, root]);
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          NavBridge,
          { onNavigate: opts.onNavigate },
          createElement(
            QueryClientProvider,
            { client: embedQueryClient },
            createElement(TableEmbed, {
              tableId,
              viewId: ph.dataset.viewId ?? null,
              kbId: opts.kbId,
              publicToken: opts.publicToken,
              embedCanEdit: opts.embedCanEdit,
            }),
          ),
        ),
      ),
    );
  });

  // C-3：返回 cleanup。调用方（effect cleanup/组件卸载）必须执行，
  // 否则 innerHTML 重建后旧 placeholder 上的 root 永不 unmount（组件树/订阅泄漏）。
  return () => {
    for (const [ph, root] of mounted) {
      roots.delete(ph);
      root.unmount();
    }
  };
}

// apps/web/src/features/kb/enhanceEmbeds.ts
// 预览/分享页增强：renderMarkdown 输出的 <div class="md-canvas-embed" data-canvas-doc>
// 占位节点，挂载为可交互的 <CanvasEmbed />（只读预览 + 跳转 + 弹窗编辑）。
// 用独立 React root 挂载，卸载时清理，避免与 dangerouslySetInnerHTML 的静态 HTML 冲突。
// 注意：独立 root 不在主应用 Provider 树内，必须自行包 QueryClientProvider；
// 导航不能用 useNavigate（无 Router context），通过 onNavigate 回调由调用方注入。

import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasEmbed } from "./CanvasEmbed";

const roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>();

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
  /** 跳转导航回调（独立 root 无 Router context，须由调用方注入） */
  onNavigate?: (path: string) => void;
}

export function enhanceCanvasEmbeds(container: HTMLElement, opts: EnhanceEmbedOpts): () => void {
  const placeholders = container.querySelectorAll<HTMLElement>(".md-canvas-embed[data-canvas-doc]");
  const mounted: Array<[HTMLElement, ReturnType<typeof createRoot>]> = [];
  placeholders.forEach((ph) => {
    const docId = ph.dataset.canvasDoc ?? "";
    if (!docId) return;
    if (roots.has(ph)) return; // 已挂载
    const root = createRoot(ph);
    roots.set(ph, root);
    mounted.push([ph, root]);
    root.render(
      createElement(
        QueryClientProvider,
        { client: embedQueryClient },
        createElement(CanvasEmbed, {
          docId,
          kbId: opts.kbId,
          canEdit: opts.canEdit,
          publicToken: opts.publicToken,
          onNavigate: opts.onNavigate,
        }),
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

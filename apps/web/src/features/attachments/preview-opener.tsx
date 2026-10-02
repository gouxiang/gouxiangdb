// apps/web/src/features/attachments/preview-opener.tsx
// 预览弹窗的命令式入口：openFilePreview(file)。
//
// 为什么走命令式而不是 prop 逐层透传：预览的触发点分散在网格单元格、看板/画廊卡片、
// 抽屉编辑态、上传列表四处，其中网格的 CellRenderer 是**无 hook 的纯函数**（既有单测
// 直接调用它拿元素树），卡片/详情的渲染链路也没地方挂 modal state。命令式入口让这些
// 触发点只需一行 `openFilePreview(file)`，不必为了弹窗给整条链路加状态。
//
// 与 toast 同款的「全局单例宿主」形态：独立 createRoot，不进业务组件树，
// 因此不依赖任何 Provider（鉴权 token 从 zustand store 直接读，不经过 context）。

import { createRoot, type Root } from "react-dom/client";
import type { AttachmentDTO } from "@gx/shared-types";
import { FilePreviewModal } from "./FilePreviewModal";

let hostEl: HTMLDivElement | null = null;
let root: Root | null = null;

/** 关闭预览（弹窗自带的关闭按钮 / Esc / 点遮罩都走这里）。 */
export function closeFilePreview(): void {
  root?.render(<FilePreviewModal file={null} onClose={closeFilePreview} />);
}

/**
 * 打开某个附件的在线预览弹窗。
 * node 环境（单测 / SSR 快照）下 document 不存在，静默返回 —— 预览是纯浏览器能力，
 * 不该让服务端渲染或单测因为缺 DOM 而崩。
 */
export function openFilePreview(file: AttachmentDTO): void {
  if (typeof document === "undefined" || !file) return;
  if (!hostEl) {
    hostEl = document.createElement("div");
    hostEl.setAttribute("data-gx-attachment-preview", "");
    document.body.appendChild(hostEl);
  }
  if (!root) root = createRoot(hostEl);
  root.render(<FilePreviewModal file={file} onClose={closeFilePreview} />);
}

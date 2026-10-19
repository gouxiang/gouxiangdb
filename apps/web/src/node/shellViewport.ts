// apps/web/src/node/shellViewport.ts
// 桌面壳"原生应用手感"视口锁定（消除 WKWebView 整页橡皮筋/双向拖出空白）。
//
// 仅在物理运行于 Tauri 壳内（hasShell()，window.__TAURI_INTERNALS__.invoke 存在）时，
// 给 <html> 加 {@link SHELL_VIEWPORT_CLASS}；index.css 在该作用域把文档双向锁死、内部滚动
// 容器用 overscroll-behavior:contain 切断滚动链。浏览器 / fnOS / 服务器构建 hasShell()=false，
// 永不加此类，现网滚动行为逐字节不变（fail-closed）。
//
// 抽到独立模块而非写进 main.tsx：①纯逻辑可在无 jsdom 的 node 测试里用最小 document 桩验证；
// ②与壳检测 shellBridge 解耦，入参 document/inShell 皆可注入。

import { hasShell } from "./shellBridge";

/** 壳内固定视口标记类（仅 <html>）；与 index.css 选择器约定一致，改名需同步。 */
export const SHELL_VIEWPORT_CLASS = "gx-desktop-shell";

/** 测试/无 DOM 环境用的最小 document 形状（只要 documentElement.classList）。 */
export interface ViewportDocumentLike {
  documentElement: { classList: { add(c: string): void; remove(c: string): void } };
}

/**
 * 按是否在壳内增删 <html> 的视口锁定类。纯函数、不读全局、不抛错（doc 缺省直接返回）。
 */
export function applyShellViewportClass(
  doc: ViewportDocumentLike | undefined,
  inShell: boolean,
): void {
  if (!doc) return;
  const classList = doc.documentElement.classList;
  if (inShell) classList.add(SHELL_VIEWPORT_CLASS);
  else classList.remove(SHELL_VIEWPORT_CLASS);
}

/**
 * 应用入口最早调用：物理在壳内才锁定视口。SSR/node（无 document）零副作用。
 */
export function installShellViewport(): void {
  if (typeof document === "undefined") return;
  applyShellViewportClass(
    document as unknown as ViewportDocumentLike,
    hasShell(),
  );
}

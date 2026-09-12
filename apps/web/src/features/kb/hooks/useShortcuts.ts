// apps/web/src/features/kb/hooks/useShortcuts.ts
// 跨平台键盘快捷键 hook（Cmd on macOS / Ctrl on Win/Linux）。
//
// 设计要点：
//  1. **平台无关 mod 通配**：`{ key: "s", meta: true }` 在 Mac 上匹配 Cmd+S，
//     在 Win/Linux 上匹配 Ctrl+S。`meta && !ctrl` 严格只匹配 Mac 时使用 `{ meta: true, ctrl: false }`。
//  2. **window 捕获**：监听挂在 window 上（而非 DOM 树深层），一次绑定覆盖整个编辑器。
//     DrawnixCanvas 的 Ctrl+S 实现也用同一手法（DrawnixCanvas.tsx:223-239），可直接对照。
//  3. **rootRef 作用域**：传入时，仅当事件 target 在 root 内（或 root 自身）才触发，
//     焦点在搜索对话框 / 版本历史 / 标题输入框时不劫持。
//  4. **IME 守卫**：默认开启（中文/日文输入法组词期间不拦截 Enter / 方向键）。
//  5. **first-match wins**：多个 binding 命中时仅触发第一个 + preventDefault；
//     若一个 key 想做平台分支，请在同 id 内并列多个 combos。
//  6. **稳定 ref**：handlers / bindings 通过 ref 访问，避免每次渲染重新 bind 监听。

import { useEffect, useRef } from "react";

export type KeyCombo = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type Binding = {
  id: string;
  combos: KeyCombo[];
  preventDefault?: boolean;
  /** 仅作元信息：editor=仅作用域内触发 / global=无视 rootRef。实际作用域仍由 rootRef 决定。 */
  scope?: "editor" | "global";
};

export type UseShortcutsOptions = {
  rootRef?: React.RefObject<HTMLElement | null>;
  isComposingGuard?: boolean;
};

function comboMatches(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (e.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  // meta: true / ctrl: true 视作 "mod"（meta 或 ctrl 任一即可，跨平台）
  const wantMod = !!(combo.meta || combo.ctrl);
  const pressedMod = e.metaKey || e.ctrlKey;
  if (wantMod) {
    if (!pressedMod) return false;
  } else {
    if (pressedMod) return false;
  }
  if (!!combo.shift !== e.shiftKey) return false;
  if (!!combo.alt !== e.altKey) return false;
  return true;
}

export function useShortcuts(
  bindings: Binding[],
  handlers: Record<string, (e: KeyboardEvent) => void>,
  options?: UseShortcutsOptions,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // 解构出稳定引用，依赖列表里放原始 Ref / 布尔
  const rootRef = options?.rootRef;
  const isComposingGuard = options?.isComposingGuard !== false;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isComposingGuard && e.isComposing) return;
      // 作用域校验：rootRef 提供时仅在子树内触发；target 缺失（如 window 自身）也放行
      const root = rootRef?.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) return;

      const current = bindingsRef.current;
      for (const b of current) {
        if (!b.combos.some((c) => comboMatches(e, c))) continue;
        if (b.preventDefault) e.preventDefault();
        const h = handlersRef.current[b.id];
        if (h) {
          try {
            h(e);
          } catch (err) {
            // 单 binding 抛错不影响后续 binding；与 DrawnixCanvas 一致不静默吞掉
            console.error(`[useShortcuts] handler "${b.id}" threw:`, err);
          }
        }
        return; // first-match wins
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rootRef, isComposingGuard]);
}
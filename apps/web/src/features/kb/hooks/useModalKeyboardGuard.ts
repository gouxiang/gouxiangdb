// apps/web/src/features/kb/hooks/useModalKeyboardGuard.ts
// KB-EDITOR-ROUND-5 §2.6：弹窗键盘隔离。
//
// 根因：画布内弹出的编辑窗（DocEditModal/CanvasEditModal/EditorModal）即使 portal 到
// document.body，其 contentEditable/INPUT 内的按键仍会冒泡到 window，而 Plait/Drawnix 在
// window 上注册了 keydown 委托（ahooks useEventListener 默认 target=window），其"焦点在输入
// 控件"守卫只豁免 INPUT/TEXTAREA，不豁免 contentEditable；当画板上有选中几何图形时，
// Drawnix 热键（h/v/m/e/p/a/r/o/t）与 @plait/draw 的 withDrawHotkey 会对裸字母/数字
// preventDefault，表现为弹窗里快速打字大量丢字。
//
// 方案：在 window【捕获阶段】注册监听。两类处理：
//   1) 打字隔离：目标是"本弹窗内可编辑元素"且按键为【无修饰单字符键】时 stopPropagation，
//      阻止事件到达 Plait 的 window 监听器（裸字母被其切工具/吞字）。
//   2) 保存快捷键：传入 onSave 时，目标位于本弹窗内的 Cmd/Ctrl+S 一律
//      preventDefault + stopPropagation 并调 onSave。这必须在 window 捕获阶段做——
//      Drawnix 的"保存为 .drawnix"由每个 board 实例绑在 window【冒泡】末端的 globalKeyDown
//      （无焦点/只读守卫），弹窗又 portal 到 body、不在底层 .kb-canvas-wrap 子树内，
//      画布自身的 wrap capture 拦截收不到弹窗按键。只有在 window 捕获阶段抢先 stopPropagation
//      才能保证 mod+s 不穿透到背景画布触发文件下载。
// 刻意放行：Escape（弹窗关闭）、Enter/Backspace/Delete/方向/Tab、除 mod+s 外的修饰组合。
//
// 为什么用原生 window-capture + stopPropagation 而不是 React onKeyDownCapture：
// React 18 在 root 容器上委托合成事件；在弹窗 div 的 React capture 里 stopPropagation
// 会连带阻止编辑器 contentEditable 自身的 React onKeyDown（斜杠菜单/@提及等）。
// 原生 window-capture 位于 React root 监听器【之外且更早】，这里 stopPropagation 只拦截
// window 冒泡链上更后的其它 window 监听器（Plait），不影响 React root 收到事件。
// 浏览器默认插字在事件分发前已确定，打字隔离不 preventDefault，打字不受影响。

import { useEffect, useRef, type RefObject } from "react";

function isEditableTarget(t: EventTarget | null): t is HTMLElement {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  );
}

function isSaveHotkey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "s" || e.key === "S");
}

/**
 * @param modalRef 弹窗最外层容器 ref；只隔离发生在该容器内的按键。
 * @param active   弹窗是否挂载（默认 true）。
 * @param onSave   可选：弹窗内按 Cmd/Ctrl+S 时的保存动作。传入后该快捷键在 window 捕获
 *                 阶段被拦截（preventDefault 阻止浏览器保存对话框、stopPropagation 阻止
 *                 穿透到背景 Drawnix board），仅触发本回调。
 */
export function useModalKeyboardGuard(
  modalRef: RefObject<HTMLElement | null>,
  active = true,
  onSave?: () => void,
) {
  // onSave 用 ref 持有最新闭包，避免每次渲染重建监听
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!active) return;

    const inModal = (t: EventTarget | null): t is HTMLElement => {
      const root = modalRef.current;
      return !!root && t instanceof Node && root.contains(t);
    };

    const shouldIsolateTyping = (e: KeyboardEvent): boolean => {
      if (e.defaultPrevented) return false;
      // 任何修饰键组合都不走打字隔离（mod+s 由下面单独处理）
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      // 仅拦截无修饰单字符可打印键（含空格）；Enter/Backspace/Delete/方向/Tab/Esc 放行
      if (e.key.length !== 1) return false;
      if (!isEditableTarget(e.target)) return false;
      if (!inModal(e.target)) return false;
      return true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // 1) 保存快捷键：只要目标在弹窗内即拦截（不要求是可编辑元素——焦点可能停在顶栏按钮）
      if (onSaveRef.current && isSaveHotkey(e) && inModal(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        onSaveRef.current();
        return;
      }
      // 2) 打字隔离
      if (shouldIsolateTyping(e)) e.stopPropagation();
    };
    // keyup 同样隔离：部分 Plait 手势在 keyup 收尾（如工具切换的状态复位）。
    // mod+s 的 keyup 无需特殊处理（保存只在 keydown 触发），但要 stop 防止工具状态复位。
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSaveHotkey(e) && inModal(e.target)) {
        e.stopPropagation();
        return;
      }
      if (shouldIsolateTyping(e)) e.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [modalRef, active]);
}

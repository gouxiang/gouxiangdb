// apps/web/src/features/kb/canvas/board-guards.ts
// 板级事件守卫：把「plait 的板手势」在指定条件下短路掉（纯函数层，可单测）。
//
// 两条守卫，作用面不同：
//
// 1) installLinkBoardGuards —— **编辑态**专用。关联块卡片经 foreignObject 注入到 plait svg 内
//    （统一层级，见 LinkBlockForeignObject），卡片因此成为 plait 容器的事件后代。这里在事件目标
//    落在卡片 [data-gx-link-fo] 内时跳过【外层板】处理，避免：
//      - 点按卡片被当成框选/拖拽绘制/选中清空；
//      - 双击卡片进入 plait 文字编辑（卡片双击语义是"跳转"）；
//      - 在卡片重命名输入框或内嵌只读子画布中按键，误触发外层板删除/方向键移动/快捷键。
//    只短路板方法本身，不做 DOM stopPropagation —— React18 合成事件委托在根容器，
//    原生阻断会连卡片按钮的 React 事件一起杀死。
//
// 2) installPreviewBoardGuards —— **只读预览**专用（P0-② 残影）。
//    文档内嵌画布预览 / 版本快照预览是真实可交互的 Drawnix（readonly + allowViewInteraction），
//    但 DrawnixCanvas 是非受控组件：value 只在挂载时读一次，选区/拖拽这类瞬时状态既不回灌
//    也不会被清掉，一旦被起手就永久留在画面上（主理人截图里的红色大矩形残影）。
//    这里从源头短路一切板手势（pointerDown/Move/dblClick/键鼠），预览只剩
//    wheel 缩放平移（viewport-container 的原生监听，不经板方法）与命令式 fit/zoom 句柄 ——
//    交互上不再"能产生残留态"，比事后回灌重置可靠（FO 内 pointerup 可能丢失，见
//    LinkBlockForeignObject:261-265 的历史 bug）。

/** 板方法被守卫后仍然要保留的返回值语义：一律返回 undefined（原方法的返回值无人依赖）。 */
const GUARDED_METHODS = ["pointerDown", "pointerMove", "dblClick", "globalKeyDown", "keyDown"] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyBoard = any;

/** duck typing 取元素最近祖先：node 环境没有全局 Element，用 typeof 判断保证可单测 */
function closest(target: unknown, selector: string): unknown {
  const t = target as { closest?: (s: string) => unknown } | null;
  if (!t || typeof t.closest !== "function") return null;
  try {
    return t.closest(selector) ?? null;
  } catch {
    return null;
  }
}

function wrapContains(wrap: unknown, node: unknown): boolean {
  if (!wrap) return true; // 不限定 wrap 时视为命中
  const w = wrap as { contains?: (n: unknown) => boolean };
  if (typeof w.contains !== "function") return true;
  try {
    return !!w.contains(node);
  } catch {
    return false;
  }
}

function guard(board: AnyBoard, shouldSkip: (event: unknown) => boolean) {
  if (!board || board.__gxGuardsInstalled) return;
  board.__gxGuardsInstalled = true;
  for (const name of GUARDED_METHODS) {
    const original = board[name];
    if (typeof original !== "function") continue;
    board[name] = function guarded(event: unknown, ...rest: unknown[]) {
      if (shouldSkip(event)) return undefined;
      return original.call(board, event, ...rest);
    };
  }
}

/**
 * 编辑态：只跳过落在【本 wrap 内的关联卡】里的板手势，卡片自身的 React 交互照常。
 */
export function installLinkBoardGuards(board: AnyBoard, wrap: HTMLElement | null): void {
  guard(board, (event: unknown) => {
    const target = (event as { target?: unknown } | null)?.target;
    const fo = closest(target, "[data-gx-link-fo]");
    return !!fo && wrapContains(wrap, fo);
  });
}

/**
 * 只读预览：跳过**全部**板手势（P0-②）。预览不产生选区/拖拽/绘制态，就不会有残影。
 * wheel 缩放平移与命令式 BoardTransforms 不受影响（都不经过板方法）。
 */
export function installPreviewBoardGuards(board: AnyBoard): void {
  guard(board, () => true);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// apps/web/src/features/kb/canvas/CanvasZOrderMenu.tsx
// 画布统一图层管理入口（需求②③）：
//  - 编辑态在画布内右键 → 菜单给出「上移一层 / 下移一层 / 置于顶层 / 置于底层」；
//  - 作用对象 = board.children 顶层兄弟（基础几何、文字、图片、箭头/线条、思维导图整体、
//    嵌入的关联文档/画布块），全部走 plait 内置 ZIndexTransforms（进撤销栈、自动上云）；
//  - 右键空白外的对象时先做命中选中（selectElementAtClientPoint），再重排；
//  - 同套操作也可通过 NodeStyleBar 的「图层」入口与 ⌘ 快捷键触发；
//  - 菜单本身 portal 到 body（z-900 应用浮层），不进 .kb-canvas-wrap 裁剪层，因此嵌套画布内
//    的图层操作永远不会影响/遮挡外层顶部工具条（chrome 在每个 wrap 内固定 75 置顶）。

import { useEffect, useState } from "react";
import type { PlaitBoard } from "@plait/core";
import { ContextMenu, type ContextMenuItem, toast } from "../../../components/ui";
import { useCanvasBoard } from "./canvas-context";
import { applyZOrder, canApplyZOrder, selectElementAtClientPoint, type ZOrderAction } from "./canvas-ops";

const LABELS: Record<ZOrderAction, string> = {
  forward: "已上移一层",
  backward: "已下移一层",
  front: "已置于顶层",
  back: "已置于底层",
};
const AT_EDGE: Record<ZOrderAction, string> = {
  forward: "已在最顶层，无法再上移",
  front: "已在最顶层",
  backward: "已在最底层，无法再下移",
  back: "已在最底层",
};

function run(board: PlaitBoard, action: ZOrderAction) {
  const moved = applyZOrder(board, action);
  toast(moved ? LABELS[action] : AT_EDGE[action], moved ? "success" : "info");
}

export function CanvasZOrderMenu() {
  const rt = useCanvasBoard();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const board = rt?.board ?? null;
  const canEdit = !!rt?.ctx.canEdit;
  void rt?.frame; // 选区变化随帧重渲染，以刷新菜单可用态

  useEffect(() => {
    const wrap = rt?.container;
    const b = rt?.board;
    if (!wrap || !b || !canEdit) return;

    const onContextMenu = (e: MouseEvent) => {
      // 顶部/四角常驻工具条上的右键交给系统默认，不弹图层菜单
      if ((e.target as HTMLElement | null)?.closest?.(".island")) return;
      e.preventDefault();
      e.stopPropagation();
      // 命中对象则把它设为当前选区（addSelectedElement 只写 plait 实时选区 WeakMap，
      // 不发 op/onChange）；点空白保留既有选区。
      const hit = selectElementAtClientPoint(b, e.clientX, e.clientY);
      // 关键：选区已变但 React 快照（rt.selectedIds）不会自动更新——立即同步，使样式面板的
      // 显隐/锚点/元素集与本次右键选中同一真源（否则面板锚在旧元素、写入却落到新元素）。
      rt.refreshSelection();
      // 点空白且当前没有任何可重排选区时，不弹一个"四项全灰"的菜单（这就是"有时异常置灰"
      // 的来源：落空右键无选区）。命中对象时 canApplyZOrder 必为 true（顶层元素均可重排）。
      if (!hit && !canApplyZOrder(b)) return;
      setMenu({ x: e.clientX, y: e.clientY });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      let action: ZOrderAction | null = null;
      if (!e.altKey && e.key === "]") action = "forward";
      else if (!e.altKey && e.key === "[") action = "backward";
      else if (e.altKey && e.key === "]") action = "front";
      else if (e.altKey && e.key === "[") action = "back";
      if (!action) return;
      if (!canApplyZOrder(b)) return;
      e.preventDefault();
      e.stopPropagation();
      run(b, action);
    };

    wrap.addEventListener("contextmenu", onContextMenu, true);
    wrap.addEventListener("keydown", onKeyDown, true);
    return () => {
      wrap.removeEventListener("contextmenu", onContextMenu, true);
      wrap.removeEventListener("keydown", onKeyDown, true);
    };
  }, [rt?.container, rt?.board, canEdit]);

  if (!board || !canEdit || !menu) return null;

  const enabled = canApplyZOrder(board);
  const items: ContextMenuItem[] = [
    { kind: "item", label: "上移一层", icon: "bringForward", shortcut: "⌘]", disabled: !enabled, onClick: () => run(board, "forward") },
    { kind: "item", label: "下移一层", icon: "sendBackward", shortcut: "⌘[", disabled: !enabled, onClick: () => run(board, "backward") },
    { kind: "divider" },
    { kind: "item", label: "置于顶层", icon: "bringToFront", shortcut: "⌥⌘]", disabled: !enabled, onClick: () => run(board, "front") },
    { kind: "item", label: "置于底层", icon: "sendToBack", shortcut: "⌥⌘[", disabled: !enabled, onClick: () => run(board, "back") },
  ];

  // menuClassName="plait-board-attached"：菜单 portal 到 body，若不带 plait 官方豁免类，
  // 点击菜单项的 pointerup 会被 plait globalPointerUp 判为"板外点击"而在 onClick 前清空选区，
  // applyZOrder 读实时选区（WeakMap）得到空集 → 操作静默失效（toast 误报"已在最顶/底层"）。
  return (
    <ContextMenu
      open={!!menu}
      x={menu.x}
      y={menu.y}
      items={items}
      onClose={() => setMenu(null)}
      width={208}
      menuClassName="plait-board-attached"
    />
  );
}

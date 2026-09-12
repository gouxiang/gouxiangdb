// apps/web/src/features/kb/editor-history.ts
// 编辑器撤销/重做栈（Cmd/Ctrl+Z / Cmd+Shift+Z / Cmd+Y）。
//
// 设计要点：
//  1. **快照 dedup**：相邻相同状态不入栈，避免输入/光标抖动造成 undo 栈被噪声占满。
//  2. **CAP=100**：超长文档一次会话最多 100 步撤销，防止内存爆。
//  3. **新建即可用**：first push 由 WysiwygEditor 在挂载时执行（initial state），
//     确保 canUndo() 在用户首次输入后才返回 true，与 Notion / Obsidian 体验一致。
//  4. **不跨文档**：createEditorHistory 实例绑定到单个文档编辑会话，卸载即 GC。
//  5. **同步 API**：push/undo/redo 都是 O(1) 或 O(cap)，可直接在 keydown 处理同步执行。
//
// 与现有 `kb-history.ts`（如有）等无关；本模块刻意独立以避免循环依赖。

import type { Block } from "./blocks";

export interface EditorHistory {
  /** 记录一次状态变更；与上一次快照相同时为 no-op。 */
  push(blocks: Block[]): void;
  /**
   * 撤销一步。返回应回退到的 blocks；若没有可撤销项（undStack < 2）则返回 null。
   * 调用方应自行 setBlocks(result) 并更新 DOM，无需再次 push。
   */
  undo(): Block[] | null;
  /**
   * 重做一步。返回应前进到的 blocks；若没有可重做项则返回 null。
   */
  redo(): Block[] | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 清空所有栈（文档重载 / 切模式时调用） */
  clear(): void;
  /** 当前 undo 栈长度（诊断用） */
  readonly undoDepth: number;
}

export function createEditorHistory(cap = 100): EditorHistory {
  const undoStack: Block[][] = [];
  const redoStack: Block[][] = [];
  let lastSnapshot: string | null = null;

  return {
    push(blocks) {
      const snap = JSON.stringify(blocks);
      if (snap === lastSnapshot) return;
      undoStack.push(JSON.parse(snap));
      if (undoStack.length > cap) undoStack.shift();
      // 新编辑清空 redo 栈：与所有主流编辑器一致
      redoStack.length = 0;
      lastSnapshot = snap;
    },
    undo() {
      // undoStack 始终多保留一份"current"前的状态用于回退
      if (undoStack.length < 2) return null;
      const cur = undoStack.pop()!;
      redoStack.push(cur);
      const prev = undoStack[undoStack.length - 1]!;
      lastSnapshot = JSON.stringify(prev);
      return prev;
    },
    redo() {
      if (redoStack.length === 0) return null;
      const next = redoStack.pop()!;
      undoStack.push(next);
      lastSnapshot = JSON.stringify(next);
      return next;
    },
    canUndo: () => undoStack.length > 1,
    canRedo: () => redoStack.length > 0,
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      lastSnapshot = null;
    },
    get undoDepth() {
      return undoStack.length;
    },
  };
}
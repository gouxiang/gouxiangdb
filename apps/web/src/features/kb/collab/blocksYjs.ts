// apps/web/src/features/kb/collab/blocksYjs.ts
// 「自研 contentEditable + 扁平 Block[]」接 Yjs 的**绑定层**（阶段 2 底层，与 UI 解耦）。
// 本文件是唯一出口（single exit）：Y 结构与读写转换在同目录 blocksYjsState.ts，一并再导出。
//
// Y 结构照 DESIGN §13，不自创：
//   order  : Y.Array<string>   块 id 顺序
//   blocks : Y.Map<Y.Map>      id → 块元数据（type / checked / lang / variant / spans …）
//   texts  : Y.Map<Y.Text>     id → 块正文（字符级 CRDT，两人同改一块也不互相覆盖）
//
// 纪律（D6 UI 冻结 + 便于单测）：
//   · 不 import 任何 UI、**不碰 document / window**；仓库无 jsdom，也不许新装。
//   · 入 Y 一律最小前后缀差异，绝不整块替换；出 Y 一律最小补丁序列，由上层（阶段 2 接线）
//     热补 DOM 并修正光标 —— 这里只算补丁，不落 DOM。
//   · 组词（中文输入法）是本文件的**显式入口** beginComposition / enqueuePatch /
//     commitComposition：组词期间不入 Y，compositionend 一次性落。
//
// 要点：防整块替换的关键：本地差异以 shadow（本地已知文本）为基准，而非 Y 当前值 ——
//   若以 Y 当前值为基准，当远端在同一块别处改过，前后缀差异会把远端那一侧整段吞掉。

import * as Y from "yjs";
import { uid, type Block, type BlockType } from "@gx/blocks";
import {
  applyPatchToY,
  contentOf,
  createCollabBlocks,
  deltaToPatches,
  metaOfBlock,
  minimalDiff,
  textOf,
  type CollabBlocks,
  type MetaValue,
  type TextPatch,
} from "./blocksYjsState";

// 纯零件原样再导出，保证上层只认这一个入口
export * from "./blocksYjsState";

/** 某个块的补丁组；出 Y 的方向以此为交付单位 */
export interface TextPatchGroup {
  blockId: string;
  patches: TextPatch[];
}

/** 绑定会话：除 Y 结构外，还持有本地共识文本、写标记与组词状态 */
export interface BlocksBinding {
  y: CollabBlocks;
  /** id → 本地已知文本（shadow copy） */
  shadow: Map<string, string>;
  /** 本地写入统一打此 origin，patchesFromEvents 据此跳过自己的回声 */
  localOrigin: object;
  /** 正在组词的块 id；null = 未在组词 */
  composingId: string | null;
  /** 组词期间累积的本地文本 */
  pendingText: string | null;
  /** 组词期间被推迟的远端补丁（按到达顺序） */
  deferred: TextPatchGroup[];
}

export function bindBlocks(doc: Y.Doc = new Y.Doc()): BlocksBinding {
  return {
    y: createCollabBlocks(doc),
    shadow: new Map<string, string>(),
    localOrigin: { kind: "gx-local" },
    composingId: null,
    pendingText: null,
    deferred: [],
  };
}

/** 本地已知文本：shadow 优先，缺省回落 Y 现值 */
export function localText(binding: BlocksBinding, id: string): string {
  return binding.shadow.get(id) ?? textOf(binding.y, id);
}

export type EnqueueOutcome = "pushed" | "queued" | "unchanged";

export interface EnqueueResult {
  outcome: EnqueueOutcome;
  /** 实际写进 Y 的补丁（outcome = "pushed" 时非空） */
  patch: TextPatch | null;
}

/** 本地文本的唯一入口：非组词时立即以最小差异落 Y（并推进 shadow）；组词期间只累积最新
 *  文本、不写 Y —— 等 compositionend 由 commitComposition 一次性提交。 */
export function enqueuePatch(binding: BlocksBinding, id: string, next: string): EnqueueResult {
  if (binding.composingId === id) {
    binding.pendingText = next;
    return { outcome: "queued", patch: null };
  }
  const patch = minimalDiff(localText(binding, id), next);
  if (patch.remove === 0 && patch.insert === "") return { outcome: "unchanged", patch: null };
  applyPatchToY(binding.y, id, patch, binding.localOrigin);
  binding.shadow.set(id, next);
  return { outcome: "pushed", patch };
}

/* ---------------- 组词（中文输入法）三件套 ---------------- */

/** 开始组词：该块本地文本先不入 Y。上一轮未提交就切块时**显式报错**，不静默丢弃 */
export function beginComposition(binding: BlocksBinding, id: string): void {
  if (binding.composingId !== null && binding.composingId !== id) {
    throw new Error(`blocksYjs: 块 ${binding.composingId} 的组词尚未提交就切到了 ${id}`);
  }
  binding.composingId = id;
  binding.pendingText = null;
}

export interface CompositionCommit {
  /** 组词累积文本落 Y 时实际写入的补丁（已沿期间的远端改动做过位移）；无输入则为 null */
  local: TextPatch | null;
  /** 组词期间被推迟的远端补丁，按到达顺序，供上层在 DOM 上补应用 */
  remote: TextPatchGroup[];
}

/**
 * 把本地补丁沿一串远端补丁做位移（OT 变换）—— 组词提交必需。
 * 组词期间远端可能已在同块的别处改动，而本地差异是在「组词前共存文本」这套坐标里算出来的，
 * 若直接按原索引写入当前 Y，插进去的字会整体错位（等于把远端那一侧往后挤）。三种情形：
 *   远端完全在本地区间之前 → 本地索引按远端净增量平移；
 *   远端完全在本地区间之后 → 不动；
 *   两者区间相交 → 本地插入点夹到远端替换之后，且本地删除量作废（那一坨远端已经处理过）。
 */
export function rebasePatch(local: TextPatch, remote: readonly TextPatch[]): TextPatch {
  let { index, remove } = local;
  for (const r of remote) {
    if (r.index + r.remove <= index) index += r.insert.length - r.remove;
    else if (r.index >= index + remove) continue;
    else {
      index = r.index + r.insert.length;
      remove = 0;
    }
  }
  return { index, remove, insert: local.insert };
}

/** 提交组词：把累积的本地文本以最小差异一次性落 Y。差异基准仍是 shadow（组词前共识），
 *  远端改动因此不会被整段吞掉；写入前先沿期间到达的远端补丁做位移再落到当前 Y 上。
 *  上层约定：拿到返回值后先把 remote 补丁补到 DOM，再把最终 DOM 文本喂回 enqueuePatch 收口。 */
export function commitComposition(binding: BlocksBinding): CompositionCommit {
  const id = binding.composingId;
  if (id === null) throw new Error("blocksYjs: 当前没有正在组词的块");
  const pending = binding.pendingText;
  binding.composingId = null;
  binding.pendingText = null;
  const remoteForId = binding.deferred.filter((g) => g.blockId === id).flatMap((g) => g.patches);
  let local: TextPatch | null = null;
  if (pending !== null) {
    const raw = minimalDiff(localText(binding, id), pending);
    const patch = rebasePatch(raw, remoteForId);
    if (!(patch.remove === 0 && patch.insert === "")) {
      applyPatchToY(binding.y, id, patch, binding.localOrigin);
      binding.shadow.set(id, textOf(binding.y, id));
      local = patch;
    }
  }
  const remote = binding.deferred;
  binding.deferred = [];
  return { local, remote };
}

/* ---------------- Y → 本地：算出补丁序列 ---------------- */

function blockIdOfText(b: CollabBlocks, target: Y.Text): string | null {
  for (const [id, yt] of b.texts.entries()) if (yt === target) return id;
  return null;
}

/** Y 事件 → 可立即应用的补丁组（不含 DOM 操作）。① transaction.origin 是本地写入标记 →
 *  整批跳过（自己的回声，DOM 已最新）；② 非 Y.Text 事件（order / blocks 的结构性变动）
 *  不在本函数职责内，忽略；③ 该块正在组词 → 补丁排队（DOM 冻结）且不推进 shadow，
 *  等 commit 后由上层取走。 */
export function patchesFromEvents(
  binding: BlocksBinding,
  events: readonly unknown[],
  transaction?: Y.Transaction,
): TextPatchGroup[] {
  if (transaction && transaction.origin === binding.localOrigin) return [];
  const out: TextPatchGroup[] = [];
  for (const ev of events) {
    if (!(ev instanceof Y.YTextEvent)) continue;
    const id = blockIdOfText(binding.y, ev.target);
    if (id === null) continue;
    const patches = deltaToPatches(ev.delta);
    if (patches.length === 0) continue;
    if (binding.composingId === id) {
      const queued = binding.deferred.find((g) => g.blockId === id);
      if (queued) queued.patches = queued.patches.concat(patches);
      else binding.deferred.push({ blockId: id, patches });
      continue;
    }
    // 注意：observer 触发时 Y 已经是新值了，所以 shadow 必须直接取 Y 现值；
    // 若拿「Y 现值 + 再套用一次补丁」会双计（远端改动的字符被重复算一遍）。
    binding.shadow.set(id, textOf(binding.y, id));
    out.push({ blockId: id, patches });
  }
  return out;
}

/* ---------------- 结构性操作 ---------------- */

/** 插入块并返回 id。id 默认取自 @gx/blocks 的 uid() —— 与编辑器内 newBlock() 同一生成器，
 *  故语义一致、天然稳定，可直接作 Y 键（DESIGN §13-4）。 */
export function insertBlock(
  b: CollabBlocks,
  at: number,
  type: BlockType,
  partial: Partial<Block> = {},
  id: string = uid(),
): string {
  b.doc.transact(() => {
    const full: Block = { id, type, ...partial };
    const m = new Y.Map<MetaValue>();
    m.set("type", type);
    for (const [k, v] of Object.entries(metaOfBlock(full))) m.set(k, v);
    b.blocks.set(id, m);
    b.texts.set(id, new Y.Text(contentOf(full)));
    b.order.insert(Math.max(0, Math.min(at, b.order.length)), [id]);
  });
  return id;
}

/** 删除块：三处（order / blocks / texts）一起删，不留孤儿键 */
export function removeBlock(b: CollabBlocks, id: string): void {
  b.doc.transact(() => {
    b.blocks.delete(id);
    b.texts.delete(id);
    const idx = b.order.toArray().indexOf(id);
    if (idx >= 0) b.order.delete(idx, 1);
  });
}

/** 改块类型（列表项 ↔ 标题 ↔ 正文等，走与现在相同的语义：正文不动，只换 type） */
export function setBlockType(b: CollabBlocks, id: string, type: BlockType): void {
  const m = b.blocks.get(id);
  if (!m) throw new Error(`blocksYjs: 未知块 id ${id}`);
  m.set("type", type);
}

/** 写块元数据（checked / lang / variant / align / spans …） */
export function setBlockMeta(b: CollabBlocks, id: string, patch: Record<string, MetaValue>): void {
  const m = b.blocks.get(id);
  if (!m) throw new Error(`blocksYjs: 未知块 id ${id}`);
  b.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) m.set(k, v);
  });
}

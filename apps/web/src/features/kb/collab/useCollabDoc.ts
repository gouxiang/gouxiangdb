// apps/web/src/features/kb/collab/useCollabDoc.ts
// 阶段 2 · 文档协同的**唯一中间层**：把 useCollabSession 拿到的 Y.Doc 与绑定层（blocksYjs）
// 接起来，向上只暴露四件事：当前 Block[]、本地文本写入口、结构性操作入口、"被他人占用"查询。
// 编辑器与页面都**不直接碰 Yjs** —— 这是 D6（UI 冻结）能守住的前提：编辑器照旧只认 Block[]，
// 同步发生在它下面。
//
// 三条硬约束（来自 DESIGN §13.1，接线必须照做）：
//   ① 组词提交走 commitComposition + rebasePatch（绑定层内部已做 OT 位移），上层只负责把
//      返回的 remote 补丁补到 DOM、再把最终 DOM 文本回喂一次。
//   ② 本地 diff 的基准是 shadow（enqueuePatch / localText），绝不拿 Y 当前值当基准。
//   ③ 本地写入统一打 localOrigin，观察者据此跳过自己的回声。
//
// 未启用协同（doc 为 null / 未连通）时本 hook 返回空壳：所有写入口都是 no-op，
// 上层因此不需要写任何分支 —— 单机模式与引入前逐字一致。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Doc, Transaction } from "yjs";
import type { Block } from "@gx/blocks";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { splitPresence } from "../../collab/collab-peers";
import { onDocSynced } from "../../collab/collab-provider";
import { getLeaseRegistry, type LeaseHolder } from "../../collab/lease-registry";
import {
  applyPatchToY,
  beginComposition,
  bindBlocks,
  commitComposition,
  contentOf,
  enqueuePatch,
  hydrateBlocks,
  insertBlock,
  metaOf,
  metaOfBlock,
  minimalDiff,
  patchesFromEvents,
  removeBlock,
  seedBlocks,
  setBlockMeta,
  setBlockType,
  textOf,
  type BlocksBinding,
  type CompositionCommit,
  type EnqueueResult,
  type TextPatchGroup,
} from "./blocksYjs";

export interface UseCollabDocOptions {
  /** useCollabSession 的 doc；null = 未启用协同。 */
  doc: Doc | null;
  /** 连通才算启用（未连通一律按单机跑，行为与引入前一致）。 */
  active: boolean;
  entries: readonly CollabPresenceEntry[];
  selfId: string | null;
  /** 播种用的初始 Block[]；只在首次建绑定时读一次，之后不再跟随。 */
  initialBlocks: readonly Block[];
}

type Listener<T> = (payload: T) => void;

export interface CollabDoc {
  /** 未启用协同时恒 null；上层据此判定"是否走协同分支"。 */
  binding: BlocksBinding | null;
  /** Y 侧的当前 Block[] 快照；未启用为 null。 */
  blocks: Block[] | null;
  /** 每次 Y 变更自增，供上层作依赖。 */
  version: number;
  /** 本地文本的唯一入口；组词期间由绑定层排队，不落 Y。块不在 Y 里（未播种/远端结构）→ null。 */
  writeText(id: string, next: string): EnqueueResult | null;
  beginComposition(id: string | null): void;
  /** 返回 { local, remote }；未组词返回 null。 */
  commitComposition(): CompositionCommit | null;
  /** 本地 Block[] → Y：增删改块 / 类型 / 元数据 / 正文，幂等。整包打 localOrigin。 */
  syncStructure(blocks: readonly Block[]): void;
  /** 订阅远端文本补丁（出 Y 方向）；返回取消订阅。 */
  onRemoteText(cb: Listener<TextPatchGroup[]>): () => void;
  /** 订阅远端结构变更（Y → Block[]）；返回取消订阅。 */
  onRemoteStructure(cb: Listener<Block[]>): () => void;
  /** 该块正被他人占用时返回占用者，否则 null（自己占自己不算）。 */
  heldBy(id: string): LeaseHolder | null;
}

/** 房间里有他人时，先等一小会儿让内容同步过来，别抢着播种（否则两边各播一份 = 内容重复）。 */
export const ADOPT_WAIT_MS = 1_200;
/**
 * 播种前置：首次 sync 完成的最长等待（超时兜底）。
 *
 * 「连上」不等于「内容到了」——WebSocket 打开到收到 sync step2 之间有一段空窗，此刻
 * Y 里 order 仍是空的。播种逻辑若在这一刻判定「房间里没人、Y 是空的」就会各播一份，
 * 真机结果是正文直接翻成两份（两个块并存，各自的改动只会落到自己那一份上）。
 * 故播种必须等第一次 sync 落地；超时才放行，保证协同连不上时退化成单机也不卡死。
 */
export const SEED_SYNC_GATE_MS = 3_000;

/**
 * 本地 Block[] → Y 的对账（独立导出，便于脱离 React 单测）：
 * 缺的块补、多出的块删、类型/元数据/正文按最小差异对齐，次序不同且集合相同时重写 order。
 * 整包打 localOrigin —— 观察者据此判定"这是我自己的回声"，不再回流（否则会与远端改动互踢）。
 */
export function syncStructureToY(binding: BlocksBinding, blocks: readonly Block[]): void {
  const y = binding.y;
  y.doc.transact(() => {
    const want = blocks.map((b) => b.id);
    const have = y.order.toArray();
    for (const id of have) if (!want.includes(id)) removeBlock(y, id);
    blocks.forEach((b, i) => {
      if (!y.blocks.has(b.id)) {
        // 传整个 Block 而不是只传元数据：insertBlock 的 partial 同时用于取正文（contentOf），
        // 只给 metaOfBlock(b) 会让新块的正文丢成空串。
        insertBlock(y, i, b.type, b, b.id);
        return;
      }
      const meta = metaOf(y, b.id);
      if (meta.type !== b.type) setBlockType(y, b.id, b.type);
      const nextText = contentOf(b);
      const cur = textOf(y, b.id);
      if (cur !== nextText) applyPatchToY(y, b.id, minimalDiff(cur, nextText));
      for (const [k, v] of Object.entries(metaOfBlock(b))) {
        if (meta[k] !== v) setBlockMeta(y, b.id, { [k]: v });
      }
    });
    // 顺序只在"集合相同、次序不同"时重写（纯移动），避免增删场景误伤并发
    const now = y.order.toArray();
    if (now.length === want.length && now.join("\u0000") !== want.join("\u0000")) {
      for (let i = now.length - 1; i >= 0; i -= 1) y.order.delete(i, 1);
      y.order.insert(0, want);
    }
  }, binding.localOrigin);
}

export function useCollabDoc(opts: UseCollabDocOptions): CollabDoc {
  const { doc, active, entries, selfId } = opts;
  const initialRef = useRef(opts.initialBlocks);
  const [version, setVersion] = useState(0);
  const textSubs = useRef<Set<Listener<TextPatchGroup[]>>>(new Set());
  const structSubs = useRef<Set<Listener<Block[]>>>(new Set());

  const peerCount = useMemo(() => splitPresence(entries, selfId).peers.length, [entries, selfId]);
  const binding = useMemo(() => (doc && active ? bindBlocks(doc) : null), [doc, active]);

  // 播种前置闸门：首次 sync 完成（或超时）之前一律不播种，避免在空窗期重复播种。
  const [syncReady, setSyncReady] = useState(false);
  useEffect(() => {
    if (!doc) return;
    const off = onDocSynced(doc, () => setSyncReady(true));
    const timer = setTimeout(() => setSyncReady(true), SEED_SYNC_GATE_MS);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [doc]);

  // 播种：Y 为空且房间里没别人 → 用本地初始内容铺一遍（幂等）；已有内容 → 采纳，不播种。
  const seeded = useRef(false);
  useEffect(() => {
    if (!binding || !syncReady || seeded.current) return;
    if (binding.y.order.length > 0) {
      seeded.current = true;
      return;
    }
    const timer = setTimeout(
      () => {
        if (seeded.current || binding.y.order.length > 0) {
          seeded.current = true;
          return;
        }
        seedBlocks(binding.y, initialRef.current.slice());
        seeded.current = true;
        setVersion((v) => v + 1);
      },
      peerCount > 0 ? ADOPT_WAIT_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [binding, peerCount, syncReady]);

  // 观察者：文本补丁 → onRemoteText；结构/元数据变更 → onRemoteStructure。
  // 本地写入一律带 localOrigin，两条链路都据此跳过自己的回声。
  useEffect(() => {
    if (!binding) return;
    const y = binding.y;
    const onText = (events: readonly unknown[], tr: Transaction): void => {
      const groups = patchesFromEvents(binding, events, tr);
      if (groups.length === 0) return;
      setVersion((v) => v + 1);
      for (const cb of textSubs.current) cb(groups);
    };
    const onStruct = (_events: unknown, tr: Transaction): void => {
      if (tr.origin === binding.localOrigin) return;
      setVersion((v) => v + 1);
      const next = hydrateBlocks(y);
      for (const cb of structSubs.current) cb(next);
    };
    y.texts.observeDeep(onText);
    y.order.observe(onStruct);
    y.blocks.observeDeep(onStruct);
    return () => {
      y.texts.unobserveDeep(onText);
      y.order.unobserve(onStruct);
      y.blocks.unobserveDeep(onStruct);
    };
  }, [binding]);

  const writeText = useCallback(
    (id: string, next: string): EnqueueResult | null => {
      if (!binding || !binding.y.texts.has(id)) return null;
      return enqueuePatch(binding, id, next);
    },
    [binding],
  );

  const begin = useCallback(
    (id: string | null): void => {
      if (!binding || id === null || !binding.y.texts.has(id)) return;
      if (binding.composingId === id) return;
      // 上一轮异常未提交（切块 / 焦点跳走）：先收口再开新一轮，绝不静默丢弃。
      if (binding.composingId !== null) commitComposition(binding);
      beginComposition(binding, id);
    },
    [binding],
  );

  const commit = useCallback((): CompositionCommit | null => {
    if (!binding || binding.composingId === null) return null;
    return commitComposition(binding);
  }, [binding]);

  const syncStructure = useCallback(
    (blocks: readonly Block[]): void => {
      if (!binding) return;
      syncStructureToY(binding, blocks);
    },
    [binding],
  );

  const onRemoteText = useCallback((cb: Listener<TextPatchGroup[]>): (() => void) => {
    textSubs.current.add(cb);
    return () => {
      textSubs.current.delete(cb);
    };
  }, []);

  const onRemoteStructure = useCallback(
    (cb: Listener<Block[]>): (() => void) => {
      structSubs.current.add(cb);
      // ★ 订阅即回放一次当前状态：后到的客户端必须先把自己本地的块 id 对齐到 Y。
      //   块 id 由 mdToBlocks 随机生成、两端不同，若不对齐，之后到达的文本补丁会因为
      //   "本地没有这个块 id" 被整批丢弃 —— 表现为"看不到别人的字，但别人的新块能过来"。
      if (binding) cb(hydrateBlocks(binding.y));
      return () => {
        structSubs.current.delete(cb);
      };
    },
    [binding],
  );

  const heldBy = useCallback((id: string): LeaseHolder | null => {
    const holder = getLeaseRegistry().holderOf(id);
    return holder && !holder.self ? holder : null;
  }, []);

  // version 是「Y 变了」的失效信号，闭包里读不到但必须参与依赖，否则快照会停滞
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 为失效信号
  const blocks = useMemo(() => (binding ? hydrateBlocks(binding.y) : null), [binding, version]);

  return {
    binding,
    blocks,
    version,
    writeText,
    beginComposition: begin,
    commitComposition: commit,
    syncStructure,
    onRemoteText,
    onRemoteStructure,
    heldBy,
  };
}

// apps/web/src/features/kb/embed-depth.ts
// 文档↔画布互嵌的递归防护（P2-A）：单一真源在这里，渲染链上的每个节点都向它问路。
//
// 背景（实证）：两条互嵌链都存在自引用可能——
//   doc→canvas：renderMarkdown 产出 .md-canvas-embed[data-canvas-doc] → enhanceCanvasEmbeds
//                挂载 CanvasEmbed → 画布里的关联块 RefEmbedCard → RefEmbedBody →
//                内层 renderMarkdown → 再次 enhanceCanvasEmbeds（回到链首）；
//   canvas→doc：RefEmbedBody 直接渲染被关联 markdown，同上。
// 原先唯一的终止条件是「嵌套层不传 canEdit」，深度没有任何上限，也没有环检测：
// A 嵌 B、B 再嵌 A 会稳定地一层层往下挂载，直到把线程压死。
//
// 两条防护，缺一不可：

import { createContext, useContext } from "react";

/**
 * 最大嵌套层数：宿主自层不计入，向外最多再展开 3 层嵌入。
 * 为什么是 3：画布内的关联卡本身已是 380×300 的小框，第 4 层的可视面积不足一屏的 1/16，
 * 预览再有意义也不可能看清，不如降级成一张能点进去的链接卡。
 */
export const MAX_EMBED_DEPTH = 3;

/** 渲染链：已展开的层数 + 链上出现过的实体 id（含宿主自身）。只读，每次派生都换新集合。 */
export interface EmbedChain {
  depth: number;
  ancestorDocIds: ReadonlySet<string>;
}

/** 根链：宿主自己是第 0 层，祖先集合为空。 */
export const ROOT_EMBED_CHAIN: EmbedChain = {
  depth: 0,
  ancestorDocIds: new Set<string>(),
};

export type EmbedPlan =
  /** 可以继续渲染：chain 是「在 target 内部继续渲染时」应持有的链（已含 target 自身）。 */
  | { kind: "render"; chain: EmbedChain }
  /** 成环：target 已经出现在祖先链上，再渲染就是无限递归。 */
  | { kind: "cycle" }
  /** 超限：超过 MAX_EMBED_DEPTH 层。 */
  | { kind: "depth" };

/**
 * 把宿主实体并入祖先集合：宿主 markdown 里若嵌了指向宿主自身的画布，会被环检测直接拦下。
 * 未提供宿主 id（例如公开分享页的子树根节点没有稳定 id）时原样返回。
 */
export function chainWithSelf(
  hostDocId: string | undefined,
  base: EmbedChain = ROOT_EMBED_CHAIN,
): EmbedChain {
  if (!hostDocId || base.ancestorDocIds.has(hostDocId)) return base;
  return {
    depth: base.depth,
    ancestorDocIds: new Set([...base.ancestorDocIds, hostDocId]),
  };
}

/**
 * 唯一判定入口：能不能把 targetDocId 渲染进当前链。
 * 顺序是刻意的——环优先于深度：成环是「无论多深都错」，超限是「再深一点就错」，
 * 先把无条件错误的分支吃掉，降级文案才能准确（循环的锅不该甩给嵌套层数）。
 */
export function planEmbed(targetDocId: string, chain: EmbedChain): EmbedPlan {
  if (chain.ancestorDocIds.has(targetDocId)) return { kind: "cycle" };
  if (chain.depth >= MAX_EMBED_DEPTH) return { kind: "depth" };
  return {
    kind: "render",
    chain: {
      depth: chain.depth + 1,
      ancestorDocIds: new Set([...chain.ancestorDocIds, targetDocId]),
    },
  };
}

/**
 * 链沿组件树向下传递的载体（独立 root 由 enhanceCanvasEmbeds 显式包 Provider，
 * 详见 enhanceEmbeds.ts）——中间那些只读渲染层（DrawnixCanvas / overlay / 适配层）
 * 不必逐个加 props，也不必知道 depth 的存在。
 */
export const EmbedChainContext = createContext<EmbedChain>(ROOT_EMBED_CHAIN);

/** 当前所处的嵌入链；不在任何链上时（顶层主画布）即根链。 */
export function useEmbedChain(): EmbedChain {
  return useContext(EmbedChainContext);
}

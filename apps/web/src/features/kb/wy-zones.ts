// apps/web/src/features/kb/wy-zones.ts
// 富文本「行间插入热区」的判定 —— 从 WysiwygEditor 抽出的纯函数层，便于单测锁行为。
//
// P0-① 真回归：此前热区只在「邻块也是占用型/原子型」或「首/尾块」时渲染，
// 嵌入块（图片/画布/代码块/callout…）紧邻普通段落时上下热区都不存在，
// insertParagraphBefore/After 永远触发不到 → 表现为「内容上/下没有空行就插不进去」。
//
// 修法：把判据从「邻块是不是占用型」换成「邻块是否已经提供了可输入的空位」——
// 只有邻块是**可编辑且为空**的块（等价已经有一个空行）才省掉那一侧的热区；
// 邻块是有内容的普通段落时保留热区，用户才能在组件与正文之间插进去。
import type { Block, BlockType } from "@gx/blocks";

/**
 * 原子块：渲染为不可编辑的预览（图片/视频/音频/PDF/附件/分割线/分页符）。
 * 这类块无法容纳光标，统一走"点击选中 → Delete/Backspace 删除 / 回车在下方插入空段落"交互，
 * 与 Notion / NocoDB 文档的媒体块行为一致。
 */
export const ATOMIC_TYPES: ReadonlySet<BlockType> = new Set([
  "image", "video", "audio", "pdf", "attachment", "hr", "pagebreak",
]);

/**
 * 占用型块：在编辑器中**不能承载光标**但本身可含可编辑子区
 * （callout/toggle 的 body/code/math/table），仍需要"前/后自动空段"保证光标自由进出。
 * 与纯原子块区别：占用型块有可编辑子区，原子块完全没有。
 */
export const OCCUPY_TYPES: ReadonlySet<BlockType> = new Set([
  "callout", "toggle", "code", "math", "table",
  ...ATOMIC_TYPES,
]);

/** 是否需要"自动补空段 + 上下点击热区"：所有占用型 + 原子型 */
export function needsEmptyPair(type: BlockType): boolean {
  return OCCUPY_TYPES.has(type);
}

/**
 * 邻块是否已经提供「可直接输入」的空位：可编辑块且内容为空。
 * 占用型/原子型不含光标，哪怕 text 为空也不算空位（点不进去，仍要热区）。
 */
export function hasTypingRoom(b: Block | undefined): boolean {
  if (!b) return false;
  if (needsEmptyPair(b.type)) return false;
  return (b.text ?? "").trim() === "";
}

/**
 * 某个占用型/原子型块两侧要不要渲染插入热区。
 *
 * 误触控制（"别造成全屏误触"）：热区只在**占用型/原子型块的紧邻侧**出现（宽度受块容器
 * 限制，高度 6px，hover 才出提示线），两个普通段落之间永远不会出现热区 —— 只有碰到
 * 不能承载光标的组件时才让出那一条 6px，不是全屏铺热区。
 */
export function zoneFlags(args: {
  prev: Block | undefined;
  next: Block | undefined;
  isFirst: boolean;
  isLast: boolean;
}): { showPrev: boolean; showNext: boolean } {
  const { prev, next, isFirst, isLast } = args;
  return {
    // 首块之前 / 末块之后恒给热区：那一侧没有邻块可落脚，否则光标进不去
    showPrev: isFirst || (!!prev && !hasTypingRoom(prev)),
    showNext: isLast || (!!next && !hasTypingRoom(next)),
  };
}

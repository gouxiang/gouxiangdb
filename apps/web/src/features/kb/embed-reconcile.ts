// apps/web/src/features/kb/embed-reconcile.ts
// 知识库文档内嵌画布/数据表的「远端结构回放」防丢兜底（P0 数据丢失修复 B）。
//
// 背景（事故链路）：
//   协同中间层 useCollabDoc 的 onRemoteStructure 在「订阅即回放」（重连/重绑定）以及远端
//   实时结构变更时，都会把 Y.Doc 水化出的 blocks 整块交回编辑器；此前编辑器无条件用它替换
//   本地 blocks 并 onChange 出 markdown。若此刻 Y 里缺了本地刚插入、尚未同步上去的画布/表格
//   围栏块，该嵌入引用就会被静默抹掉，持久化后永久丢失（普通文字块因 Y 中齐全而幸存）。
//
// 为什么不用块 id 判别：
//   块 id 由 mdToBlocks 内 uid() 随机生成，两端天然不一致；而 code 围栏体内的画布 docId、
//   数据表 tableId/viewId 是跨端稳定身份。因此以「围栏 lang + 体内稳定 id」编码出的 EmbedKey
//   作为对账键，与具体块 id 解耦。
//
// 保守策略（数据安全优先）：
//   · 只做「结构对齐」——本地存在、incoming 缺失的嵌入块，克隆后追加回 incoming 末尾；
//   · 绝不回写 Y：回写会与对端互相踢结构、引发回放风暴，保数据只在本地编辑器侧兜底；
//   · 克隆块换发新 uid()，避免与 incoming 既有块 id 撞键；
//   · 本地主动删除不会被复活：本地删除走 emit→syncStructure（带 localOrigin），结构观察者对
//     localOrigin 早退、不回流 onRemoteStructure，且删除后 blocksRef 已不含该块，本地键集合
//     里自然没有它，reconcile 无从恢复。
//
// 纯函数：不依赖 React / DOM，可在 node 环境直接单测。

import { uid, type Block } from "@gx/blocks";

/** 嵌入块的稳定身份键（字符串别名，便于在调用侧以普通集合传递与断言）。 */
export type EmbedKey = string;

/** 嵌入围栏的两种 lang 标记，与 mentions.ts / WysiwygEditor 插入协议保持一致。 */
const CANVAS_LANG = "canvas-embed";
const TABLE_LANG = "table-embed";

/**
 * 计算单个 code 型嵌入块的稳定身份键；非嵌入块或体内 id 缺失（空围栏）返回 null。
 * - 画布：`canvas:${docId}`
 * - 数据表：`table:${tableId}:${viewId?}`（体内按空白切分、过滤空段后以冒号连接；
 *   无 viewId 时仅 `table:${tableId}`）
 */
export function embedKeyOf(block: Block): EmbedKey | null {
  if (block.type !== "code") return null;
  const body = (block.code ?? "").trim();
  if (block.lang === CANVAS_LANG) {
    // 空 docId 的损坏围栏不计入身份，交给渲染层失效卡处理，避免污染对账集合。
    if (!body) return null;
    return `canvas:${body}`;
  }
  if (block.lang === TABLE_LANG) {
    const segments = body.split(/\s+/).filter(Boolean);
    // 第一段 tableId 缺失视为损坏围栏，不参与对账。
    if (segments.length === 0) return null;
    return `table:${segments.join(":")}`;
  }
  return null;
}

/**
 * 收集一批块中全部有效嵌入块的稳定身份键（去重、按首次出现顺序）。
 */
export function collectEmbedKeys(blocks: readonly Block[]): Set<EmbedKey> {
  const keys = new Set<EmbedKey>();
  for (const block of blocks) {
    const key = embedKeyOf(block);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * 远端结构回放兜底：把「本地有、incoming 缺失」的嵌入块克隆补回 incoming。
 *
 * @param local    编辑器当前 blocks（本地真相，含可能尚未同步到 Y 的新嵌入块）
 * @param incoming 协同层从 Y 水化、即将整块替换本地的 blocks
 * @returns blocks  对齐后的块序列（无缺失时原样返回 incoming 引用，避免无谓重渲染）
 *          recovered 本次被补回的嵌入键列表（空数组表示没有触发任何恢复）
 */
export function reconcileRemoteBlocks(
  local: readonly Block[],
  incoming: Block[],
): { blocks: Block[]; recovered: EmbedKey[] } {
  const incomingKeys = collectEmbedKeys(incoming);
  const recovered: EmbedKey[] = [];
  // 待追加的克隆块；仅在确有缺失时才组装新数组，保证「无丢失原样返回」。
  const clones: Block[] = [];
  // 同一稳定键只恢复一次：去重锚定本地首个匹配块，重复嵌入至少保底一份，绝不整片丢失。
  const handled = new Set<EmbedKey>();

  for (const block of local) {
    const key = embedKeyOf(block);
    if (key === null) continue;
    if (incomingKeys.has(key) || handled.has(key)) continue;
    handled.add(key);
    // 换发新 id 的浅克隆：保留 lang/code 等围栏协议字段，仅替换随机块身份。
    clones.push({ ...block, id: uid() });
    recovered.push(key);
  }

  if (clones.length === 0) return { blocks: incoming, recovered };
  return { blocks: [...incoming, ...clones], recovered };
}

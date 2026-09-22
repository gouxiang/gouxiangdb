// apps/api/src/collab/docMerge.ts
// 「外部整篇覆盖写」打进在线房间：三方归并（base / mine / next）后落成一次 Y 更新并广播。
//
// 用在两处（同一套语义，DESIGN §3.2 + §3.3）：
//   · 房间在线时的 HTTP PUT / MCP 写：next = 本次写入的整篇内容；
//   · 冷归结撞 VersionConflictError：next = 库里被别人推进过的内容。
//
// 为什么必须三方而不是「拿 next 直接盖」：
//   mine（Y 现值）= base + 在线编辑。若把 base→next 的差异盲打到 mine 上，当 next 已经包含
//   在线编辑（客户端 autosave PUT 的正是它看到的全文）时会**重复插入一遍**。故逐块、逐字段
//   按 base 判定「谁动过」：
//     外部没动 -> 保留 mine（在线编辑优先）
//     我没动   -> 采纳 next
//     两边都动 -> 按 base 的最小差异区域替换（区域外的在线编辑照常保留）
//
// 已知限制：块级按【位置】对齐（base / mine / next 都源自同一篇文档）；并发插入或删除块时
// 位置会错位，错位的块按「next 为准」收敛 —— 不丢内容，但可能不合意。块内是字符级 CRDT，
// Yjs 自行合并。

import { uid, type Block } from "@gx/blocks";
import {
  applyPatchToY,
  assignMeta,
  contentFieldOf,
  contentOf,
  hydrateDocBlocks,
  insertBlock,
  metaOfBlock,
  minimalDiff,
  removeBlock,
  textOf,
  type DocBlocks,
  type MetaValue,
} from "./docYjs.js";

/** 服务端自身写入的 Y 事务标记（不是连接：handleDocUpdate 据此不认它是某个人的编辑）。 */
export const COLLAB_SERVER_ORIGIN = { kind: "gx-collab-server" };

/**
 * 三方归并：base = 房间基线内容，mine = Y 现值，next = 外部整篇内容。
 * 返回待落到 Y 的 Block[]；能沿用 Y 现块 id 的一律沿用（保住 Yjs 的字符级历史）。
 */
export function mergeBlocks(
  base: readonly Block[],
  mine: readonly Block[],
  next: readonly Block[],
): Block[] {
  const out: Block[] = [];
  const n = Math.max(base.length, next.length);
  for (let i = 0; i < n; i += 1) {
    const b = base[i];
    const nxt = next[i];
    const m = mine[i];
    // next 是整篇覆盖：它比 base 短的尾部块一律丢弃（外部删掉了）。
    if (!nxt) continue;
    const id = m?.id ?? uid();
    // base 没有这一位 = 外部新增的块：整体采纳。
    if (!b) {
      out.push({ ...nxt, id });
      continue;
    }
    // 外部没动这一块：保留 Y 现值（在线编辑优先），连 id 一起沿用。
    if (sameBlock(b, nxt)) {
      out.push(m ? { ...m, id: m.id } : { ...nxt, id });
      continue;
    }
    out.push(mergeOneBlock(b, m, nxt, id));
  }
  return out;
}

/** 外部确实改了这一块：类型 / 元数据 / 正文各自按「base 是否被外部改动」择一。 */
function mergeOneBlock(b: Block, m: Block | undefined, nxt: Block, id: string): Block {
  // 类型：外部没换类型 -> 保留在线侧的类型（例如有人把段落改成了标题）
  const type = b.type === nxt.type && m ? m.type : nxt.type;
  const out: Block = { id, type };
  const bMeta = metaOfBlock(b);
  const mMeta = m ? metaOfBlock(m) : {};
  const nMeta = metaOfBlock(nxt);
  const keys = new Set([...Object.keys(bMeta), ...Object.keys(mMeta), ...Object.keys(nMeta)]);
  for (const key of keys) {
    const external = nMeta[key];
    const local = mMeta[key];
    const chosen: MetaValue | undefined = sameValue(bMeta[key], external) ? local : external;
    if (chosen !== undefined) assignMeta(out, key, chosen);
  }
  const field = contentFieldOf(type);
  if (field) out[field] = mergeText(contentOf(b), m ? contentOf(m) : "", contentOf(nxt));
  return out;
}

/**
 * 三方文本合并：
 *   mine === next  -> 已经一致（含「next 已包含我的编辑」），原样保留；
 *   base === mine  -> 我没动，直接采纳 next；
 *   base === next  -> 外部没动，保留 mine；
 *   其余           -> 取 base→next 的差异区域替换 mine 的同一区域（区域外的我的编辑保留）。
 */
export function mergeText(base: string, mine: string, next: string): string {
  if (mine === next) return mine;
  if (base === mine) return next;
  if (base === next) return mine;
  const lead = commonPrefix(base, next);
  const tail = commonSuffix(base, next, lead);
  const region = next.slice(lead, next.length - tail);
  const head = mine.slice(0, lead);
  const foot = mine.slice(Math.max(lead, mine.length - tail));
  return head + region + foot;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: string, b: string, lead: number): number {
  const max = Math.min(a.length - lead, b.length - lead);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function sameBlock(a: Block, b: Block): boolean {
  if (a.type !== b.type || contentOf(a) !== contentOf(b)) return false;
  const am = metaOfBlock(a);
  const bm = metaOfBlock(b);
  for (const k of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    if (!sameValue(am[k], bm[k])) return false;
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && a !== null && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * 把「外部整篇内容」作为一次 CRDT 更新打进房间：三方归并 -> 对账写 Y -> 由 update 事件广播。
 * 调用方负责把 updatedBy 归属写进 room.lastEditorUserId（本事务的 origin 不是连接）。
 */
export function applyDocUpdateToY(
  b: DocBlocks,
  base: readonly Block[],
  next: readonly Block[],
  origin: unknown = COLLAB_SERVER_ORIGIN,
): void {
  const merged = mergeBlocks(base, hydrateDocBlocks(b), next);
  b.doc.transact(() => {
    syncDocBlocksToY(b, merged);
  }, origin);
}

/** 对账：把 Y 收敛到给定 Block[]（缺的补、多的删、正文走最小差异而非整块替换）。 */
export function syncDocBlocksToY(b: DocBlocks, target: readonly Block[]): void {
  const want = new Set(target.map((x) => x.id));
  for (const id of b.order.toArray()) {
    if (!want.has(id)) removeBlock(b, id);
  }
  target.forEach((block, i) => {
    const m = b.blocks.get(block.id);
    if (!m) {
      insertBlock(b, i, block, block.id);
      return;
    }
    if (m.get("type") !== block.type) m.set("type", block.type);
    for (const [k, v] of Object.entries(metaOfBlock(block))) {
      if (!sameValue(m.get(k), v)) m.set(k, v);
    }
    const wanted = contentOf(block);
    const cur = textOf(b, block.id);
    if (cur !== wanted) applyPatchToY(b, block.id, minimalDiff(cur, wanted));
  });
  const now = b.order.toArray();
  const ids = target.map((x) => x.id);
  if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
    for (let i = now.length - 1; i >= 0; i -= 1) b.order.delete(i, 1);
    if (ids.length > 0) b.order.insert(0, ids);
  }
}

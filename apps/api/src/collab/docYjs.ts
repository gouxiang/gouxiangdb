// apps/api/src/collab/docYjs.ts
// 服务端对「文档 Y 结构」的读写镜像 —— 与前端 apps/web/src/features/kb/collab/blocksYjsState.ts
// 同构：Y 顶层键名、正文落 Block 的哪个字段、元数据白名单，三处必须逐字一致。
// 漂移防线见 __tests__/docYjs-parity.test.ts：拿前端源码与前端实现逐项对拍，不一致即红。
//
// 为什么服务端要解析 Y（与 attach.ts「转发层不解析内容」不冲突）：冷归结必须把 Y.Doc 还原成
// Block[]，才能经 @gx/blocks 的 blocksToMd 落进既有写事务 saveDocContentTx（DESIGN §2.3、
// §3.7.1）。解析面只在本文件与 docMerge.ts，转发层仍是黑盒。
//
// 本文件只依赖 yjs 与 @gx/blocks —— 不碰 DOM、不碰 HTTP，可独立单测。

import * as Y from "yjs";
import {
  CALLOUT_VARIANTS,
  blocksToMd,
  mdToBlocks,
  uid,
  type Block,
  type BlockType,
  type CalloutVariant,
} from "@gx/blocks";

/** Y 顶层键名。**改这里必须同步改前端 createCollabBlocks**（parity 测试守着）。 */
export const Y_ORDER_KEY = "order";
export const Y_BLOCKS_KEY = "blocks";
export const Y_TEXTS_KEY = "texts";

/** 允许进块元数据的值：标量 + 纯 JSON 对象（spans）。 */
export type MetaValue = string | number | boolean | null | Record<string, unknown>;

/** 文档房间的 Y 结构（与前端 CollabBlocks 同形）。 */
export interface DocBlocks {
  doc: Y.Doc;
  /** 块 id 顺序。 */
  order: Y.Array<string>;
  /** id → 块元数据（type / checked / lang / variant / spans …）。 */
  blocks: Y.Map<Y.Map<MetaValue>>;
  /** id → 块正文（字符级 CRDT）。 */
  texts: Y.Map<Y.Text>;
}

/**
 * 每种块类型的「正文」落在 Block 的哪个字段。
 * **改这里必须同步改前端 CONTENT_FIELD**（parity 测试守着）。
 */
export const CONTENT_FIELD: Partial<Record<BlockType, "text" | "code" | "formula" | "raw">> = {
  p: "text",
  h1: "text",
  h2: "text",
  h3: "text",
  h4: "text",
  h5: "text",
  h6: "text",
  ul: "text",
  ol: "text",
  task: "text",
  quote: "text",
  callout: "text",
  toggle: "text",
  code: "code",
  math: "formula",
  raw: "raw",
};

/**
 * 进块元数据的白名单字段（正文与 rows 不在其中：正文进 Y.Text）。
 * **改这里必须同步改前端 META_KEYS**（parity 测试守着）。
 */
export const META_KEYS = ["checked", "lang", "variant", "summary", "src", "alt", "name", "align", "spans"] as const;

/** 某类型的正文落在 Block 的哪个字段；无正文的类型（hr / 媒体块等）返回 undefined。 */
export function contentFieldOf(type: BlockType): "text" | "code" | "formula" | "raw" | undefined {
  return CONTENT_FIELD[type];
}

/** 取块正文；无正文的类型返回空串。 */
export function contentOf(block: Block): string {
  const field = CONTENT_FIELD[block.type];
  return field ? (block[field] ?? "") : "";
}

/** 从 Block 拷出要进 Y 的元数据（只拷白名单且非 undefined 的字段）。 */
export function metaOfBlock(block: Block): Record<string, MetaValue> {
  const source: Record<string, unknown> = { ...block };
  const out: Record<string, MetaValue> = {};
  for (const key of META_KEYS) {
    const v = source[key];
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "object") {
      out[key] = v as MetaValue;
    }
  }
  return out;
}

/** 把一条元数据写回 Block；非白名单键忽略（Y 里多出来的字段不污染 Block[]）。 */
export function assignMeta(block: Block, key: string, value: MetaValue): void {
  switch (key) {
    case "checked":
      block.checked = value === true;
      return;
    case "lang":
    case "summary":
    case "src":
    case "alt":
    case "name":
      if (typeof value === "string") {
        if (key === "lang") block.lang = value;
        else if (key === "summary") block.summary = value;
        else if (key === "src") block.src = value;
        else if (key === "alt") block.alt = value;
        else block.name = value;
      }
      return;
    case "variant":
      if (typeof value === "string" && (CALLOUT_VARIANTS as readonly string[]).includes(value)) {
        block.variant = value as CalloutVariant;
      }
      return;
    case "align":
      if (value === "left" || value === "center" || value === "right" || value === null) block.align = value;
      return;
    case "spans":
      if (typeof value === "object" && value !== null) block.spans = value as Block["spans"];
      return;
    default:
      return;
  }
}

/** 取一个 Y.Doc 的文档块三件套（懒建，与前端 createCollabBlocks 同键名）。 */
export function docBlocksOf(doc: Y.Doc): DocBlocks {
  return {
    doc,
    order: doc.getArray<string>(Y_ORDER_KEY),
    blocks: doc.getMap<Y.Map<MetaValue>>(Y_BLOCKS_KEY),
    texts: doc.getMap<Y.Text>(Y_TEXTS_KEY),
  };
}

/** 房间是否已播种（order 为空 = 客户端还没把内容铺进来；此时绝不写空内容回主库）。 */
export function hasBlocks(b: DocBlocks): boolean {
  return b.order.length > 0;
}

export function textOf(b: DocBlocks, id: string): string {
  return b.texts.get(id)?.toString() ?? "";
}

function metaOf(b: DocBlocks, id: string): Record<string, MetaValue> {
  const out: Record<string, MetaValue> = {};
  const m = b.blocks.get(id);
  if (!m) return out;
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

/** Y.Doc → Block[]：顺序取自 order，正文与元数据按 block id 对位。 */
export function hydrateDocBlocks(b: DocBlocks): Block[] {
  const out: Block[] = [];
  for (const id of b.order.toArray()) {
    const meta = metaOf(b, id);
    const rawType = meta["type"];
    const type: BlockType = typeof rawType === "string" && rawType !== "" ? (rawType as BlockType) : "p";
    const block: Block = { id, type };
    for (const [k, v] of Object.entries(meta)) {
      if (k !== "type") assignMeta(block, k, v);
    }
    const field = contentFieldOf(type);
    if (field) block[field] = textOf(b, id);
    out.push(block);
  }
  return out;
}

/** 插入块并返回 id（前端 insertBlock 同语义）。 */
export function insertBlock(b: DocBlocks, at: number, block: Block, id: string = uid()): string {
  const m = new Y.Map<MetaValue>();
  m.set("type", block.type);
  for (const [k, v] of Object.entries(metaOfBlock(block))) m.set(k, v);
  b.blocks.set(id, m);
  b.texts.set(id, new Y.Text(contentOf(block)));
  b.order.insert(Math.max(0, Math.min(at, b.order.length)), [id]);
  return id;
}

/** 删除块：三处（order / blocks / texts）一起删，不留孤儿键。 */
export function removeBlock(b: DocBlocks, id: string): void {
  b.blocks.delete(id);
  b.texts.delete(id);
  const idx = b.order.toArray().indexOf(id);
  if (idx >= 0) b.order.delete(idx, 1);
}

/** 最小前后缀差异：把 prev 变成 next 的单条补丁（单字符增删改只产生一条 op）。 */
export function minimalDiff(prev: string, next: string): TextPatch {
  let lead = 0;
  const maxLead = Math.min(prev.length, next.length);
  while (lead < maxLead && prev[lead] === next[lead]) lead += 1;
  let tail = 0;
  const maxTail = Math.min(prev.length - lead, next.length - lead);
  while (tail < maxTail && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { index: lead, remove: prev.length - lead - tail, insert: next.slice(lead, next.length - tail) };
}

/** 一次最小文本补丁：从 index 起删除 remove 个字符、再原位插入 insert。 */
interface TextPatch {
  index: number;
  remove: number;
  insert: string;
}

/** 把单条补丁写进 Y.Text（字符级；delete/insert 都只作用于差异段）。 */
export function applyPatchToY(b: DocBlocks, id: string, patch: TextPatch): void {
  const yt = b.texts.get(id);
  if (!yt) throw new Error(`docYjs: 未知块 id ${id}`);
  if (patch.remove === 0 && patch.insert === "") return;
  b.doc.transact(() => {
    if (patch.remove > 0) yt.delete(patch.index, patch.remove);
    if (patch.insert !== "") yt.insert(patch.index, patch.insert);
  });
}

/** Block[] → Markdown（唯一序列化出口，与 MCP / 前端共用同一真源）。 */
export function blocksToMarkdown(blocks: Block[]): string {
  return blocksToMd(blocks);
}

/** Markdown → Block[]（唯一解析入口）。 */
export function markdownToBlocks(md: string): Block[] {
  return mdToBlocks(md);
}

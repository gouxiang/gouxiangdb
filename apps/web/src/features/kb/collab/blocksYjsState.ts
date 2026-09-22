// apps/web/src/features/kb/collab/blocksYjsState.ts
// 绑定层的**叶子模块**：Y 结构的定义与「Block[] ↔ Y」读写转换、差异与补丁。
// 不 import 上层、不碰 DOM —— 便于独立单测；出口统一由 blocksYjs.ts 再导出。
//
// 本文件只依赖 yjs 与 @gx/blocks，绝不需要「DOM 才有的东西」（仓库无 jsdom，也不许新装）。

import * as Y from "yjs";
import { CALLOUT_VARIANTS, type Block, type BlockType, type CalloutVariant } from "@gx/blocks";

/** 允许进块元数据的值：标量 + 纯 JSON 对象（如 spans） */
export type MetaValue = string | number | boolean | null | Record<string, unknown>;

/** 一次最小文本补丁：从 index 起删除 remove 个字符、再原位插入 insert */
export interface TextPatch {
  index: number;
  remove: number;
  insert: string;
}

/** Y.Text 事件的 delta 操作（Quill Delta 形状，只取 string / retain / delete 三种） */
export interface DeltaOp {
  retain?: number;
  insert?: unknown;
  delete?: number;
}

export interface CollabBlocks {
  doc: Y.Doc;
  order: Y.Array<string>; // 块 id 顺序
  blocks: Y.Map<Y.Map<MetaValue>>; // id → 块元数据
  texts: Y.Map<Y.Text>; // id → 块正文（字符级 CRDT）
}

/* ---------------- ① Block 字段 ↔ Y 元数据对照 ---------------- */

/** 每种块类型的「正文」落在 Block 的哪个字段；hydrate / seed 两端共用，避免语义漂移 */
const CONTENT_FIELD: Partial<Record<BlockType, "text" | "code" | "formula" | "raw">> = {
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

/** 进块元数据的白名单字段（正文与 rows 不在其中：正文进 Y.Text，rows 见「未处理」说明） */
const META_KEYS = ["checked", "lang", "variant", "summary", "src", "alt", "name", "align", "spans"] as const;

export function contentOf(block: Block): string {
  const field = CONTENT_FIELD[block.type];
  return field ? (block[field] ?? "") : "";
}

/** 某类型的正文落在 Block 的哪个字段；无正文的类型（hr / 媒体块等）返回 undefined */
export function contentFieldOf(type: BlockType): "text" | "code" | "formula" | "raw" | undefined {
  return CONTENT_FIELD[type];
}

/** 从 Block 拷出要进 Y 的元数据（只拷白名单且非 undefined 的字段） */
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

/** 把一条元数据写回 Block；非白名单键忽略（Y 里多出来的字段不污染 Block[]） */
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

/* ---------------- ② 初始化 / hydrate / seed ---------------- */

export function createCollabBlocks(doc: Y.Doc = new Y.Doc()): CollabBlocks {
  return {
    doc,
    order: doc.getArray<string>("order"),
    blocks: doc.getMap<Y.Map<MetaValue>>("blocks"),
    texts: doc.getMap<Y.Text>("texts"),
  };
}

export function textOf(b: CollabBlocks, id: string): string {
  return b.texts.get(id)?.toString() ?? "";
}

export function metaOf(b: CollabBlocks, id: string): Record<string, MetaValue> {
  const out: Record<string, MetaValue> = {};
  const m = b.blocks.get(id);
  if (!m) return out;
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

/** Y.Doc → Block[]：顺序取自 order，正文与元数据按 block id 对位 */
export function hydrateBlocks(b: CollabBlocks): Block[] {
  const out: Block[] = [];
  for (const id of b.order.toArray()) {
    const meta = metaOf(b, id);
    const type: BlockType = typeof meta.type === "string" && meta.type !== "" ? (meta.type as BlockType) : "p";
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

export interface SeedResult {
  /** 本次新建的块 id（幂等：重复调用应为空数组） */
  added: string[];
  /** 已存在、但正文被最小差异补齐的块 id */
  patched: string[];
}

/** Block[] → Y 初始状态。**幂等**：已存在的 id 不再重建、不覆盖元数据、不重复入 order，
 *  仅补齐缺失项；正文不一致时走最小差异而非重写。 */
export function seedBlocks(b: CollabBlocks, blocks: Block[]): SeedResult {
  const added: string[] = [];
  const patched: string[] = [];
  const order = b.order.toArray();
  b.doc.transact(() => {
    blocks.forEach((block, i) => {
      if (!b.blocks.has(block.id)) {
        const m = new Y.Map<MetaValue>();
        m.set("type", block.type);
        for (const [k, v] of Object.entries(metaOfBlock(block))) m.set(k, v);
        b.blocks.set(block.id, m);
        added.push(block.id);
      }
      const wanted = contentOf(block);
      if (!b.texts.has(block.id)) {
        b.texts.set(block.id, new Y.Text(wanted));
      } else if (textOf(b, block.id) !== wanted) {
        applyPatchToY(b, block.id, minimalDiff(textOf(b, block.id), wanted));
        patched.push(block.id);
      }
      if (!order.includes(block.id)) {
        b.order.insert(Math.min(i, order.length), [block.id]);
        order.push(block.id);
      }
    });
  });
  return { added, patched };
}

/* ---------------- ③ 最小差异 / 补丁 / delta 换算 ---------------- */

/** 最小前后缀差异：把 prev 变成 next 的**单条**补丁。单字符增删改只产生一条 op，
 *  绝不退化成整块替换。 */
export function minimalDiff(prev: string, next: string): TextPatch {
  let lead = 0;
  const maxLead = Math.min(prev.length, next.length);
  while (lead < maxLead && prev[lead] === next[lead]) lead += 1;
  let tail = 0;
  const maxTail = Math.min(prev.length - lead, next.length - lead);
  while (tail < maxTail && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { index: lead, remove: prev.length - lead - tail, insert: next.slice(lead, next.length - tail) };
}

/** 把补丁应用到一段文本（Y → 本地这条链路上算新值，上层可直接复用） */
export function applyPatchToText(prev: string, patch: TextPatch): string {
  return prev.slice(0, patch.index) + patch.insert + prev.slice(patch.index + patch.remove);
}

/** 把单条补丁写进 Y.Text（字符级；delete/insert 都只作用于差异段） */
export function applyPatchToY(b: CollabBlocks, id: string, patch: TextPatch, origin: unknown = null): void {
  const yt = b.texts.get(id);
  if (!yt) throw new Error(`blocksYjs: 未知块 id ${id}`);
  if (patch.remove === 0 && patch.insert === "") return;
  b.doc.transact(() => {
    if (patch.remove > 0) yt.delete(patch.index, patch.remove);
    if (patch.insert !== "") yt.insert(patch.index, patch.insert);
  }, origin);
}

/** Y.Text 事件的 delta → 最小补丁序列（供上层热补 DOM）。坐标随遍历演化（相邻补丁按序叠加
 *  即得目标文本）；Yjs 对一次替换常产出紧邻的 {delete}+{insert} 两条 op，这里合并成一次
 *  替换，避免上层删一次再插一次。 */
export function deltaToPatches(delta: readonly DeltaOp[]): TextPatch[] {
  const out: TextPatch[] = [];
  let consumed = 0; // 已消费的旧文字符数
  let removed = 0; // 其中被删掉的部分
  let added = 0; // 已插入的字符数
  for (const op of delta) {
    const pos = consumed - removed + added;
    if (typeof op.retain === "number") {
      consumed += op.retain;
      continue;
    }
    if (typeof op.delete === "number") {
      pushPatch(out, { index: pos, remove: op.delete, insert: "" });
      consumed += op.delete;
      removed += op.delete;
      continue;
    }
    if (op.insert !== undefined) {
      if (typeof op.insert !== "string") throw new Error("blocksYjs: 块正文不支持非字符串插入");
      pushPatch(out, { index: pos, remove: 0, insert: op.insert });
      added += op.insert.length;
      continue;
    }
  }
  return out;
}

function pushPatch(out: TextPatch[], patch: TextPatch): void {
  const last = out[out.length - 1];
  if (last && last.index === patch.index && last.insert === "" && patch.remove === 0 && patch.insert !== "") {
    out[out.length - 1] = { index: last.index, remove: last.remove, insert: patch.insert };
    return;
  }
  out.push(patch);
}

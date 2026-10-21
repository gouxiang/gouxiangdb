// apps/web/src/features/kb/collab/canvasYjsState.ts
// 画布协同绑定层的**叶子模块（阶段 A：纯映射，零 DOM / 零 React / 零网络）**：
// Y 结构定义与「PlaitElement[] ↔ Y」读写转换、增量对账、最小文本补丁。
//
// ★★ 本文件是服务端 apps/api/src/collab/canvasFlush.ts 的【逐字镜像】★★
// Y 三键 / key 前缀规则 / 类型白名单 / 文本拆出规则 / 规范化深比 / 增量对账顺序，
// 任何一处漂移都会让冷归结把协同画布序列化成另一块板。跨端一致性由
// apps/api/src/collab/__tests__/canvasYjs-parity.test.ts 锁死（源码静态对拍 + 字节级对拍）。
//
// 与服务端的唯一有意差异：
//   - 新元素 key 前缀由调用方传入 clientId（前端是创建者 yjs clientID/会话 id），
//     服务端注入/归并用固定 "server"；parity 测试传 "server" 时两边逐字节一致。
//   - 不 import @gx/canvas（web 包未链接它，阶段 A 零依赖改动），isPlainObject 在本文件
//     内按 packages/canvas/src/shared.ts 逐字复刻，parity 测试对拍两者行为一致。
//
// 只依赖 yjs，绝不碰 DOM（仓库无 jsdom，也不许新装）。

import * as Y from "yjs";

/* ================================ Y 键名契约（与 canvasFlush.ts 逐字相同） ================================ */

/** Y 顶层键：图层序（完整 key 数组）。字面量必须等于服务端 Y_CANVAS_ORDER_KEY。 */
export const Y_CANVAS_ORDER_KEY = "order";
/** Y 顶层键：完整 key（带 clientId 前缀）-> 图元属性 Y.Map。等于服务端 Y_CANVAS_ELEMENTS_KEY。 */
export const Y_CANVAS_ELEMENTS_KEY = "elements";
/** Y 顶层键：完整 key -> 图元内文本 Y.Text。等于服务端 Y_CANVAS_TEXTS_KEY。 */
export const Y_CANVAS_TEXTS_KEY = "texts";

/**
 * 已知 PlaitElement.type 白名单（镜像服务端 KNOWN_ELEMENT_TYPES，DESIGN §11 补丁③）。
 * geometry/text/image/table/swimlane/arrow-line/vector-line（@plait/draw）
 * mind/mind_child/mindmap（@plait/mind）。其余（含未来插件类型）还原时跳过，避免前端崩板。
 */
export const KNOWN_ELEMENT_TYPES = new Set([
  "geometry",
  "text",
  "image",
  "table",
  "swimlane",
  "arrow-line",
  "vector-line",
  "mind",
  "mind_child",
  "mindmap",
]);

/* ================================ 结构句柄 ================================ */

export interface CollabCanvas {
  doc: Y.Doc;
  /** 图层序：每项是图元在 elements/texts 中的完整 key，数组序 = 图层顺序。 */
  order: Y.Array<string>;
  /** 完整 key -> 图元属性 Y.Map（键 = PlaitElement 属性名，值为整值 JSON）。 */
  elements: Y.Map<Y.Map<unknown>>;
  /** 完整 key -> 图元内标准单段文本（字符级 CRDT）。 */
  texts: Y.Map<Y.Text>;
}

/** 取画布 Y 三件套（懒建同键名；键名与服务端逐字一致）。 */
export function createCollabCanvas(doc: Y.Doc = new Y.Doc()): CollabCanvas {
  return {
    doc,
    order: doc.getArray<string>(Y_CANVAS_ORDER_KEY),
    elements: doc.getMap<Y.Map<unknown>>(Y_CANVAS_ELEMENTS_KEY),
    texts: doc.getMap<Y.Text>(Y_CANVAS_TEXTS_KEY),
  };
}

/* ================================ key 规则（镜像 businessIdOf / SERVER 前缀） ================================ */

/** 拼完整 key：`${clientId}:${businessId}`（A10：裸 id 跨板碰撞，必须带创建者前缀）。 */
export function elementKey(clientId: string, businessId: string): string {
  return `${clientId}:${businessId}`;
}

/** 从完整 key 剥出业务 id（取最后一个冒号之后；clientId/id 均不含冒号）。 */
export function businessIdFromKey(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

/* ================================ 通用形状（逐字复刻 @gx/canvas shared.ts） ================================ */

/** 普通对象（非数组、非 null）。与 packages/canvas/src/shared.ts 的 isPlainObject 逐字相同。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ================================ Y -> PlaitElement[]（镜像 readBoardFromY/hydrateElement） ================================ */

/** Y 叶子值（可能是嵌套 CRDT 类型）转普通 JSON。 */
function toPlain(v: unknown): unknown {
  return v instanceof Y.AbstractType ? v.toJSON() : v;
}

function isSkeleton(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !Array.isArray(v);
}

/** 从 texts Y.Map 取 Y.Text 纯文本回填元素 text 字段（镜像 canvasFlush.applyYText）。 */
export function applyYText(
  el: Record<string, unknown>,
  rawSkeleton: unknown,
  yt: Y.Text | undefined,
): void {
  if (!yt) {
    // 文本未被 Y.Text 接管（非标准段落）：属性 map 里是什么就保留什么。
    if (rawSkeleton !== undefined) el.text = toPlain(rawSkeleton);
    return;
  }
  const plain = yt.toString();
  if (isSkeleton(rawSkeleton)) {
    const out: Record<string, unknown> = {};
    if (typeof rawSkeleton["type"] === "string") out["type"] = rawSkeleton["type"];
    if (rawSkeleton["align"] !== undefined) out["align"] = rawSkeleton["align"];
    out["children"] = [{ text: plain }];
    el.text = out;
  } else {
    el.text = { type: "paragraph", children: [{ text: plain }] };
  }
}

/** 单个图元 Y.Map -> PlaitElement；坏 / 未知类型返回 null（调用方跳过，不整批失败）。 */
export function hydrateElement(
  key: string,
  m: unknown,
  texts: Y.Map<Y.Text>,
): Record<string, unknown> | null {
  if (!(m instanceof Y.Map)) return null;
  const el: Record<string, unknown> = {};
  const rawText = m.get("text");
  for (const [k, v] of m.entries()) {
    // 文本真源在 texts（Y.Text）；属性 map 里只可能留段落骨架，最后统一处理。
    if (k !== "text") el[k] = toPlain(v);
  }
  // 业务 id：属性 map 自带（plait 必需字段）优先；缺失才从完整 key 剥前缀恢复（A10）。
  const id = typeof el["id"] === "string" && el["id"] ? (el["id"] as string) : businessIdFromKey(key);
  if (!id) return null;
  el["id"] = id;
  const type = el["type"];
  if (typeof type !== "string" || !KNOWN_ELEMENT_TYPES.has(type)) return null;
  applyYText(el, rawText, texts.get(key));
  return el;
}

/** 取画布 Y 三件套并还原 PlaitElement[]（镜像 canvasFlush.readBoardFromY）。 */
export function yToBoard(b: CollabCanvas): { elements: Record<string, unknown>[]; dropped: number } {
  const elements: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const key of b.order.toArray()) {
    if (typeof key !== "string") {
      dropped += 1;
      continue;
    }
    const el = hydrateElement(key, b.elements.get(key), b.texts);
    if (el) elements.push(el);
    else dropped += 1;
  }
  return { elements, dropped };
}

/* ================================ PlaitElement[] -> Y（镜像 syncBoardToY/upsertElementY） ================================ */

/**
 * 标准单 leaf 段落判定（镜像 canvasFlush.asSingleLeafText，派工称 singleLeafParagraph）：
 * 对象 + children 恰好 1 个对象 leaf + leaf 仅有字符串 text 键。
 * 多段 / 带 bold 等 marks / 非对象 text 一律返回 null（不拆，整值 LWW，往返无损）。
 */
export function singleLeafParagraph(t: unknown): string | null {
  if (!isPlainObject(t) || !Array.isArray(t["children"]) || t["children"].length !== 1) return null;
  const leaf = t["children"][0];
  if (!isPlainObject(leaf) || typeof leaf["text"] !== "string") return null;
  // 带 bold/italic 等 marks 不拆（避免 Y.Text 纯文本丢样式）。
  if (!Object.keys(leaf).every((k) => k === "text")) return null;
  return leaf["text"];
}

/**
 * 把一个 PlaitElement 拆成 { attr, text? }（镜像 canvasFlush.splitElementText）：
 * 标准单段文本 -> 属性 map 留段落骨架（type/align），文本交 Y.Text；其余原样不拆（往返无损）。
 */
export function splitElementText(el: Record<string, unknown>): {
  attr: Record<string, unknown>;
  text?: string;
} {
  const t = el["text"];
  const leafText = singleLeafParagraph(t);
  if (leafText !== null && isPlainObject(t)) {
    const attr: Record<string, unknown> = { ...el };
    const skel: Record<string, unknown> = {};
    if (typeof t["type"] === "string") skel["type"] = t["type"];
    if (t["align"] !== undefined) skel["align"] = t["align"];
    if (Object.keys(skel).length > 0) attr["text"] = skel;
    else delete attr["text"];
    return { attr, text: leafText };
  }
  return { attr: { ...el } };
}

/** 普通 JSON 属性 -> 新 Y.Map（嵌套对象/数组作 JSON 整值，A9 图形级 LWW）。 */
function jsonToYMap(attr: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(attr)) m.set(k, v);
  return m;
}

/** 最小前后缀差异（镜像 canvasFlush.minimalTextDiff / blocksYjsState.minimalDiff）：prev -> next 的单条补丁。 */
export function minimalTextDiff(prev: string, next: string): {
  index: number;
  remove: number;
  insert: string;
} {
  let lead = 0;
  const maxLead = Math.min(prev.length, next.length);
  while (lead < maxLead && prev[lead] === next[lead]) lead += 1;
  let tail = 0;
  const maxTail = Math.min(prev.length - lead, next.length - lead);
  while (tail < maxTail && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { index: lead, remove: prev.length - lead - tail, insert: next.slice(lead, next.length - tail) };
}

/** 规范化深比（数组保序、对象按键排序），不受 JSON 键序影响（镜像 canvasFlush.canonical）。 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function samePlain(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** 把一个 PlaitElement 增量对账进既有 / 新建的属性 Y.Map 与 Y.Text（不整值重建；镜像 upsertElementY）。 */
function upsertElementY(
  elements: Y.Map<Y.Map<unknown>>,
  texts: Y.Map<Y.Text>,
  key: string,
  raw: Record<string, unknown>,
): boolean {
  const { attr, text } = splitElementText(raw);
  let m = elements.get(key);
  let created: boolean;
  if (!(m instanceof Y.Map)) {
    m = jsonToYMap(attr);
    elements.set(key, m);
    created = true;
  } else {
    created = false;
    // 增量 set：删掉目标里已不存在的键，再逐个对账（规范化深比，免疫键序）。
    const wantKeys = new Set(Object.keys(attr));
    for (const k of [...m.keys()]) if (!wantKeys.has(k)) m.delete(k);
    for (const [k, v] of Object.entries(attr)) {
      if (!samePlain(m.get(k), v)) m.set(k, v);
    }
  }
  if (text !== undefined) {
    const yt = texts.get(key);
    if (yt) {
      const cur = yt.toString();
      if (cur !== text) {
        const patch = minimalTextDiff(cur, text);
        if (patch.remove > 0) yt.delete(patch.index, patch.remove);
        if (patch.insert !== "") yt.insert(patch.index, patch.insert);
      }
    } else {
      texts.set(key, new Y.Text(text));
    }
  } else {
    // 孤儿剪枝（DESIGN §3.6）：目标元素不再有标准段落文本时删残留 Y.Text，否则 hydrate 会复活旧文本。
    texts.delete(key);
  }
  return created;
}

/**
 * 对账写 Y（镜像 canvasFlush.syncBoardToY，仅把 "server" 前缀换成调用方 clientId）：
 * 把给定 PlaitElement[] 收敛进画布 Y 结构（缺的补、多的删、顺序对齐、正文最小差异补丁）。
 * 已在 Y 中的元素沿用其完整 key（按属性 map 的业务 id 反查，保住 Y.Text 字符级历史）；
 * 新元素用 `${clientId}:${id}`。非规范元素（非对象 / 无字符串 id）不进 Y。
 *
 * 幂等：对同一 board 重复调用不再建键、不改顺序、不发多余更新。
 * @returns upserted 本次【新建属性 Y.Map】的元素数（已存在元素的属性/文本对账不计）。
 */
export function boardToY(
  b: CollabCanvas,
  board: readonly unknown[],
  opts: { clientId: string },
): { upserted: number } {
  const { clientId } = opts;

  // 业务 id -> 现有完整 key（属性 map 里的 id 才是业务真源）。
  const existingKey = new Map<string, string>();
  for (const key of b.order.toArray()) {
    const m = b.elements.get(key);
    const id = m instanceof Y.Map ? m.get("id") : undefined;
    if (typeof id === "string") existingKey.set(id, key);
  }

  // 目标顺序（完整 key）；非规范元素无法进 Y（它们本就不是前端 CRDT 产物），跳过。
  const wantKeys: string[] = [];
  const wantKeySet = new Set<string>();
  for (const raw of board) {
    if (!isPlainObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) continue;
    const id = raw["id"] as string;
    const key = existingKey.get(id) ?? elementKey(clientId, id);
    wantKeys.push(key);
    wantKeySet.add(key);
  }

  let upserted = 0;
  b.doc.transact(() => {
    for (const key of b.order.toArray()) {
      if (!wantKeySet.has(key)) {
        b.elements.delete(key);
        b.texts.delete(key);
      }
    }
    board.forEach((raw) => {
      if (!isPlainObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) return;
      const key = existingKey.get(raw["id"] as string) ?? elementKey(clientId, raw["id"] as string);
      if (upsertElementY(b.elements, b.texts, key, raw)) upserted += 1;
    });
    const now = b.order.toArray();
    if (now.length !== wantKeys.length || now.some((k, i) => k !== wantKeys[i])) {
      b.order.delete(0, b.order.length);
      if (wantKeys.length > 0) b.order.insert(0, wantKeys);
    }
  });
  return { upserted };
}

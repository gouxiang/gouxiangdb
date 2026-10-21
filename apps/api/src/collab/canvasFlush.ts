// apps/api/src/collab/canvasFlush.ts
// 画布房间的冷归结（DESIGN §2.3 冷档 + §6 画布 CRDT 映射 + §11 定稿 + §12-A9/A10 + §3.7）。
//
// 归结路径只有一条：Y.Doc -> PlaitElement[] -> JSON.stringify
//   -> withWriteTx("collab.flush.canvas") 内的 saveDocContentTx（既有唯一写事务，
//      与 REST PUT / MCP canvas.commit_elements 同一事务体，见 canvasWrite.tools.ts:71-86）。
// 自动快照 / 检索 outbox / nav 对账 / contentVersion+1 / updatedBy 全部照旧生效。
//
// ★★ Y 结构契约（与前端画布 Yjs binding 跨刀对齐，逐字不得漂移；DESIGN §6/§11/A10 定稿）★★
//   一个画布房间一个 Y.Doc，顶层三个键（与 doc 房间的 order/blocks/texts 同构风格）：
//     order:    Y.Array<string>   图层序；每项是图元在 elements/texts 中的【完整 key】，
//                                  数组序 = 图层顺序（定稿：Y.Array 承载顺序，绕开 plait path 寻址）。
//     elements: Y.Map<Y.Map>      key = `${creatorClientId}:${PlaitElement.id}`（A10：裸 5 字符
//                                  随机 id 跨板碰撞约 1%，必须带创建者 clientId 前缀）；
//                                  value 是图元属性 Y.Map，键 = PlaitElement 的属性名，值为普通
//                                  JSON 标量/对象/数组（整值 LWW，A9/D5：位置/颜色等允许覆盖）。
//                                  属性里必须带业务 id（PlaitElement.id 必需字段）与 type。
//     texts:    Y.Map<Y.Text>     key 同 elements 的完整 key；图元内文本（字符级 CRDT，A9）。
//                                  还原时回填到元素的 text（slate ParagraphElement）：
//                                  { type?:"paragraph", align?, children:[{ text: <Y.Text 纯文本> }] }。
//   服务端自身写入（REST 注入 / 冲突归并的外部元素）统一用 SERVER_CLIENT_PREFIX 前缀。
//
// 文本拆出规则（board JSON -> Y，见 splitElementText）：仅【单段单 leaf、leaf 只有 text 键】
//   的标准段落拆成 Y.Text + 段落骨架（type/align 留在属性 map）；多段 / 带 bold 等 marks /
//   非对象 text 一律不拆，原样留在属性 map（整值 LWW）——保证 Y -> JSON 往返无损，不丢样式。
//
// 未知图元类型（DESIGN §11 补丁③）：Y 还原时做类型白名单【过滤】，坏元素只跳过、不拖垮整批；
//   库内已存在的未知类型元素（冲突归并读到）原样保留，读侧宽容、不丢存量。
//
// 四条铁律与 docFlush 完全一致：
//   ① 无最后编辑者不归结（kb_docs.updatedBy 非空，无 "system" 哨兵）；
//   ② 一律 withWriteTx 入队，禁止裸定时器直写 prisma；
//   ③ 失败保留 dirty/coldDirty + 指数退避 + 显式日志，不静默；
//   ④ VersionConflict 不是终态：重读库内容三方归并回 Y、推进 baseVersion 后重试一次。

import { parseBoardContent, isPlainObject } from "@gx/canvas";
import * as Y from "yjs";
import { parseCollabRoomId } from "@gx/shared-types";
import { prisma, withWriteTx } from "../db.js";
import { buildSearchText } from "../domain/kb.js";
import { saveDocContentTx, VersionConflictError } from "../domain/kbDocWrite.js";
import { registerRoomFlusher, type CollabRoom } from "./room.js";

/* ================================ Y 键名契约 ================================ */

/** Y 顶层键：图层序（完整 key 数组）。改这里必须同步改前端画布 Yjs binding。 */
export const Y_CANVAS_ORDER_KEY = "order";
/** Y 顶层键：业务 id -> 图元属性 Y.Map（完整 key 带 clientId 前缀）。 */
export const Y_CANVAS_ELEMENTS_KEY = "elements";
/** Y 顶层键：业务 id -> 图元内文本 Y.Text（key 与 elements 相同）。 */
export const Y_CANVAS_TEXTS_KEY = "texts";

/** 服务端自身写入 Y 时使用的 creatorClientId（REST 注入 / 冲突归并）。 */
export const SERVER_CLIENT_PREFIX = "server";

/**
 * 已知 PlaitElement.type 白名单（DESIGN §11 补丁③ 的"类型白名单过滤"）。
 * 来源（已核实 plait 0.89.2 类型定义与前端 features/kb/canvas/types.ts）：
 *   geometry / text / image / table / swimlane（@plait/draw）、
 *   arrow-line / vector-line（@plait/draw）、mind / mind_child / mindmap（@plait/mind）。
 * 其余（含未来插件类型）一律视为未知：Y 还原时跳过，避免前端渲染层
 * "can not resolve plugin element component type" 崩板。
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

/* ================================ 归结结果/退避（与 docFlush 同形） ================================ */

interface CanvasFlushResult {
  status: "written" | "unchanged" | "skipped" | "deferred";
  contentVersion: number | null;
  snapshotted: boolean;
  reason: string;
}

/** 冲突后最多重试一次（§3.2）。 */
const MAX_ATTEMPTS = 2;
/** 失败退避阶梯（§3.7.4）；房间已空置或关闭时强制落盘，不看退避。 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

interface RetryState {
  fails: number;
  nextAt: number;
}

/** 退避状态跟着房间对象走（房间销毁即回收，不留 Map 泄漏）。 */
const retries = new WeakMap<CollabRoom, RetryState>();

function retryOf(room: CollabRoom): RetryState {
  const cur = retries.get(room);
  if (cur) return cur;
  const fresh: RetryState = { fails: 0, nextAt: 0 };
  retries.set(room, fresh);
  return fresh;
}

function noteFailure(room: CollabRoom): void {
  const st = retryOf(room);
  const wait = BACKOFF_MS[Math.min(st.fails, BACKOFF_MS.length - 1)];
  st.fails += 1;
  st.nextAt = Date.now() + wait;
  // 保留 dirty / coldDirty：下一轮 tick / 空置会再试（§3.7.4 失败不得静默）。
  room.dirty = true;
  room.coldDirty = true;
  console.error(
    `[collab] canvas flush failed room=${room.roomId} consecutive=${st.fails} retryInMs=${wait}`,
  );
}

function skipped(reason: string, contentVersion: number | null = null): CanvasFlushResult {
  return { status: "skipped", contentVersion, snapshotted: false, reason };
}

/* ================================ Y -> PlaitElement[] ================================ */

/** Y 叶子值（可能是嵌套 CRDT 类型）转普通 JSON。 */
function toPlain(v: unknown): unknown {
  return v instanceof Y.AbstractType ? v.toJSON() : v;
}

/** 从完整 key `${creatorClientId}:${id}` 剥出业务 id（取最后一个冒号之后；clientId/id 均不含冒号）。 */
export function businessIdOf(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

function isSkeleton(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !Array.isArray(v);
}

/** 从 texts Y.Map 取 Y.Text 纯文本回填元素 text 字段（见文件头契约）。 */
function applyYText(
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
function hydrateElement(
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
  const id = typeof el["id"] === "string" && el["id"] ? (el["id"] as string) : businessIdOf(key);
  if (!id) return null;
  el["id"] = id;
  const type = el["type"];
  if (typeof type !== "string" || !KNOWN_ELEMENT_TYPES.has(type)) return null;
  applyYText(el, rawText, texts.get(key));
  return el;
}

export interface CanvasBoard {
  /** 图层序（完整 key）。 */
  order: Y.Array<string>;
  elements: Y.Map<Y.Map<unknown>>;
  texts: Y.Map<Y.Text>;
  /** 还原并白名单过滤后的 PlaitElement[]（顺序按 order）。 */
  board: Record<string, unknown>[];
  /** 被跳过的坏 / 未知元素个数（排障用）。 */
  dropped: number;
}

/** 取画布 Y 三件套并还原 PlaitElement[]（懒建同键名，与前端 binding 一致）。 */
export function readBoardFromY(doc: Y.Doc): CanvasBoard {
  const order = doc.getArray<string>(Y_CANVAS_ORDER_KEY);
  const elements = doc.getMap<Y.Map<unknown>>(Y_CANVAS_ELEMENTS_KEY);
  const texts = doc.getMap<Y.Text>(Y_CANVAS_TEXTS_KEY);
  const board: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const key of order.toArray()) {
    if (typeof key !== "string") {
      dropped += 1;
      continue;
    }
    const el = hydrateElement(key, elements.get(key), texts);
    if (el) board.push(el);
    else dropped += 1;
  }
  return { order, elements, texts, board, dropped };
}

/* ================================ PlaitElement[] -> Y（注入 / 冲突归并用） ================================ */

/** 标准单 leaf 段落判定：对象 + children 恰好 1 个对象 leaf + leaf 仅有字符串 text 键。 */
function asSingleLeafText(t: unknown): string | null {
  if (!isPlainObject(t) || !Array.isArray(t["children"]) || t["children"].length !== 1) return null;
  const leaf = t["children"][0];
  if (!isPlainObject(leaf) || typeof leaf["text"] !== "string") return null;
  // 带 bold/italic 等 marks 不拆（避免 Y.Text 纯文本丢样式）。
  if (!Object.keys(leaf).every((k) => k === "text")) return null;
  return leaf["text"];
}

/**
 * 把一个 PlaitElement 拆成 { attr, text? }：
 * 标准单段文本 -> 属性 map 留段落骨架（type/align），文本交 Y.Text；其余原样不拆（往返无损）。
 */
function splitElementText(el: Record<string, unknown>): { attr: Record<string, unknown>; text?: string } {
  const t = el["text"];
  const leafText = asSingleLeafText(t);
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

/** 最小前后缀差异（同 docYjs.minimalDiff 思路）：prev -> next 的单条补丁，保住 Y.Text 字符级历史。 */
function minimalTextDiff(prev: string, next: string): { index: number; remove: number; insert: string } {
  let lead = 0;
  const maxLead = Math.min(prev.length, next.length);
  while (lead < maxLead && prev[lead] === next[lead]) lead += 1;
  let tail = 0;
  const maxTail = Math.min(prev.length - lead, next.length - lead);
  while (tail < maxTail && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { index: lead, remove: prev.length - lead - tail, insert: next.slice(lead, next.length - tail) };
}

/** 把一个 PlaitElement 增量对账进既有 / 新建的属性 Y.Map 与 Y.Text（不整值重建）。 */
function upsertElementY(
  elements: Y.Map<Y.Map<unknown>>,
  texts: Y.Map<Y.Text>,
  key: string,
  raw: Record<string, unknown>,
): void {
  const { attr, text } = splitElementText(raw);
  let m = elements.get(key);
  if (!(m instanceof Y.Map)) {
    m = jsonToYMap(attr);
    elements.set(key, m);
  } else {
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
    // 孤儿剪枝（DESIGN §3.6）：目标元素不再有标准段落文本时，删掉残留 Y.Text，
    // 否则 hydrate 会把已删除的文本重新注入，等于复活数据。
    texts.delete(key);
  }
}

function samePlain(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * 对账写 Y：把给定 PlaitElement[] 收敛进房间的画布 Y 结构（缺的补、多的删、顺序对齐、
 * 正文走最小差异补丁）。已在 Y 中的元素沿用其完整 key（保住 Y.Text 字符级历史）；
 * 新元素用 SERVER_CLIENT_PREFIX。与 docMerge.syncDocBlocksToY 同职责，供 REST 注入 /
 * 冲突归并后收敛 Y，随后 update 事件会广播。
 */
export function syncBoardToY(doc: Y.Doc, board: readonly unknown[]): void {
  const order = doc.getArray<string>(Y_CANVAS_ORDER_KEY);
  const elements = doc.getMap<Y.Map<unknown>>(Y_CANVAS_ELEMENTS_KEY);
  const texts = doc.getMap<Y.Text>(Y_CANVAS_TEXTS_KEY);

  // 业务 id -> 现有完整 key（属性 map 里的 id 才是业务真源）。
  const existingKey = new Map<string, string>();
  for (const key of order.toArray()) {
    const m = elements.get(key);
    const id = m instanceof Y.Map ? m.get("id") : undefined;
    if (typeof id === "string") existingKey.set(id, key);
  }

  // 目标顺序（完整 key）；非规范元素无法进 Y（它们本就不是前端 CRDT 产物），跳过。
  const wantKeys: string[] = [];
  const wantKeySet = new Set<string>();
  for (const raw of board) {
    if (!isPlainObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) continue;
    const id = raw["id"] as string;
    const key = existingKey.get(id) ?? `${SERVER_CLIENT_PREFIX}:${id}`;
    wantKeys.push(key);
    wantKeySet.add(key);
  }

  doc.transact(() => {
    for (const key of order.toArray()) {
      if (!wantKeySet.has(key)) {
        elements.delete(key);
        texts.delete(key);
      }
    }
    board.forEach((raw) => {
      if (!isPlainObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) return;
      const key = existingKey.get(raw["id"] as string) ?? `${SERVER_CLIENT_PREFIX}:${raw["id"] as string}`;
      upsertElementY(elements, texts, key, raw);
    });
    const now = order.toArray();
    if (now.length !== wantKeys.length || now.some((k, i) => k !== wantKeys[i])) {
      order.delete(0, order.length);
      if (wantKeys.length > 0) order.insert(0, wantKeys);
    }
  });
}

/* ================================ 三方归并（base / mine / next） ================================ */

function indexById(els: readonly unknown[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const raw of els) {
    if (isPlainObject(raw) && typeof raw["id"] === "string" && raw["id"]) {
      out.set(raw["id"] as string, raw);
    }
  }
  return out;
}

/** 规范化深比（数组保序、对象按键排序），不受 JSON 键序 / 空白影响。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function sameElement(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * 三方归并（语义对齐 docMerge.mergeBlocks，粒度为图元 —— A9 一期图形级）：
 *   外部没动（base==next） -> 保留 mine（在线编辑优先）；
 *   我没动（base==mine）   -> 采纳 next；
 *   两边都动               -> mine 优先（图形级 LWW；图元内文本已在 Y.Text 字符级合并）；
 *   next 有 / mine 无      -> 采纳 next（外部新增）；mine 有 / next 无 -> 尾追（在线新增）。
 * 顺序以 next（库最新）为准，在线新增元素尾追。
 */
export function mergeBoards(
  base: readonly unknown[],
  mine: readonly unknown[],
  next: readonly unknown[],
): unknown[] {
  const baseIdx = indexById(base);
  const mineIdx = indexById(mine);
  const out: unknown[] = [];
  const consumedMine = new Set<string>();

  for (const nRaw of next) {
    // 库里既存的非规范元素（坏值 / 无 id）原样保留，绝不因归并凭空丢存量。
    if (!isPlainObject(nRaw) || typeof nRaw["id"] !== "string" || !nRaw["id"]) {
      out.push(nRaw);
      continue;
    }
    const id = nRaw["id"] as string;
    const m = mineIdx.get(id);
    if (!m) {
      out.push(nRaw);
      continue;
    }
    consumedMine.add(id);
    const b = baseIdx.get(id);
    if (!b) {
      // base 没有这位（两侧各自新增撞 id）：在线侧优先。
      out.push(m);
      continue;
    }
    if (sameElement(b, nRaw)) {
      out.push(m); // 外部没动
    } else if (sameElement(b, m)) {
      out.push(nRaw); // 我没动，采纳外部
    } else {
      out.push(m); // 两边都动：在线 CRDT 优先
    }
  }

  for (const mRaw of mine) {
    if (isPlainObject(mRaw) && typeof mRaw["id"] === "string") {
      const id = mRaw["id"] as string;
      if (!consumedMine.has(id)) out.push(mRaw);
    }
  }
  return out;
}

/**
 * 两篇画布 JSON 是否"实质相同"：各自 parseBoardContent 后按规范化结构深比
 * （免疫 Y.Map 还原导致的键序差异与 JSON 空白差异，对照 docFlush.sameDocContent 的去噪目的）。
 * 任一为坏 JSON 则视为不同（保守走真实写库，绝不用坏内容去比）。
 */
export function sameBoardContent(a: string | null | undefined, b: string): boolean {
  const pa = parseBoardContent(a ?? "");
  const pb = parseBoardContent(b);
  if (pa.parseError || pb.parseError) return false;
  return canonical(pa.elements) === canonical(pb.elements);
}

/* ================================ 冷归结主流程 ================================ */

/**
 * 画布房间的冷归结。注册为 "canvas" 的 RoomFlusher，由 registry 在
 * 空置 / 30s tick / 优雅关闭三处调用；HTTP PUT 注入后也直接调它取真实版本号。
 */
export async function flushCanvasRoom(room: CollabRoom, title?: string): Promise<CanvasFlushResult> {
  const ref = parseCollabRoomId(room.roomId);
  if (!ref || ref.kind !== "canvas") return skipped("not-canvas");

  const board = readBoardFromY(room.doc);
  // 房间还没播种（客户端尚未把内容铺进 Y）：写空板等于抹掉全板。
  if (board.order.length === 0) return skipped("no-elements");
  // order 非空却还原不出任何有效元素：只可能是键名契约漂移 / 整块损坏。
  // 用户真删光时 order 也为空（已被上一条兜住），故此处宁可不写，防止把全板抹成 []。
  if (board.board.length === 0) return skipped("all-elements-invalid");
  // ① 没有最后编辑者就不写。
  const editor = room.lastEditorUserId;
  if (!editor) return skipped("no-editor");

  const st = retryOf(room);
  const force = room.conns.size === 0;
  if (!force && Date.now() < st.nextAt) {
    return { status: "deferred", contentVersion: null, snapshotted: false, reason: "backoff" };
  }

  let json = JSON.stringify(board.board);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await writeOnce(ref.objectId, room, json, editor, title);
      st.fails = 0;
      st.nextAt = 0;
      return res;
    } catch (e) {
      if (!(e instanceof VersionConflictError) || attempt === MAX_ATTEMPTS - 1) {
        noteFailure(room);
        throw e;
      }
      // ④ 冲突不是终态（§3.2）：重读库内容三方归并回 Y，base 前进后重试一次。
      const cur = await prisma.kbDoc.findUnique({
        where: { id: ref.objectId },
        select: { kind: true, content: true, contentVersion: true },
      });
      if (!cur || cur.kind !== "canvas") {
        noteFailure(room);
        throw e;
      }
      const nextParsed = parseBoardContent(cur.content);
      if (nextParsed.parseError) {
        // 库里画布 JSON 已损坏：绝不把损坏内容合并进在线房间。
        noteFailure(room);
        throw e;
      }
      // 基线坏 JSON 按空板处理（在线元素全部算作本地新增，不丢编辑）。
      const baseParsed = parseBoardContent(room.baseContent ?? "");
      const base = baseParsed.parseError ? [] : baseParsed.elements;
      const mine = readBoardFromY(room.doc).board;
      const merged = mergeBoards(base, mine, nextParsed.elements);
      syncBoardToY(room.doc, merged);
      room.baseVersion = cur.contentVersion;
      room.baseContent = cur.content;
      json = JSON.stringify(merged);
      console.warn(
        `[collab] canvas version conflict merged room=${room.roomId} base=${room.baseVersion} retry=${attempt + 1}`,
      );
    }
  }
  noteFailure(room);
  throw new Error(`[collab] canvas flush exhausted room=${room.roomId}`);
}

/** 单次归结写：整篇图元 JSON 一次进事务；实质未变不写库（不白顶 contentVersion、不造零差异快照）。 */
async function writeOnce(
  docId: string,
  room: CollabRoom,
  json: string,
  editor: string,
  title?: string,
): Promise<CanvasFlushResult> {
  return await withWriteTx("collab.flush.canvas", async (tx) => {
    const row = await tx.kbDoc.findUnique({
      where: { id: docId },
      select: { kind: true, content: true, contentVersion: true },
    });
    if (!row) return skipped("canvas-missing");
    if (row.kind !== "canvas") return skipped("kind-mismatch");
    if (sameBoardContent(row.content, json)) {
      room.baseVersion = row.contentVersion;
      room.baseContent = json;
      return { status: "unchanged", contentVersion: row.contentVersion, snapshotted: false, reason: "same-content" };
    }
    const saved = await saveDocContentTx(tx, {
      docId,
      kind: "canvas",
      currentVersion: row.contentVersion,
      content: json,
      // searchText 投影与 MCP canvas.commit_elements / REST 直写完全同一口径。
      searchText: buildSearchText("canvas", json),
      userId: editor,
      title,
      baseVersion: room.baseVersion ?? undefined,
    });
    room.baseVersion = saved.contentVersion;
    room.baseContent = json;
    return { status: "written", contentVersion: saved.contentVersion, snapshotted: saved.snapshotted, reason: "ok" };
  });
}

/**
 * 房间在线时的整篇覆盖写（DESIGN §3.3）：把 content 作为一次 CRDT 更新三方归并进房间并广播，
 * 再由房间统一归结落库 —— 不直接写库（否则 30s 后冷归结会静默吞掉这次写入），也不回 409
 * （会打断 MCP / AI 写入）。
 *
 * 返回 injected=false 表示不该走注入（房间没播种 / 入参是坏画布 JSON），调用方退回直写路径。
 */
export async function injectCanvasContent(
  room: CollabRoom,
  content: string,
  userId: string,
  title?: string,
): Promise<{ injected: boolean; contentVersion: number | null; snapshotted: boolean }> {
  const board = readBoardFromY(room.doc);
  if (board.order.length === 0) return { injected: false, contentVersion: null, snapshotted: false };
  const nextParsed = parseBoardContent(content);
  // 坏 JSON 不注入在线房间（保护 CRDT）；退回今天的直写路径，行为与现状一致。
  if (nextParsed.parseError) return { injected: false, contentVersion: null, snapshotted: false };

  const baseParsed = parseBoardContent(room.baseContent ?? "");
  const base = baseParsed.parseError ? [] : baseParsed.elements;
  const merged = mergeBoards(base, board.board, nextParsed.elements);
  syncBoardToY(room.doc, merged);
  // Y 事务 origin 不是连接，lastEditor 不会被 update 事件认领，这里显式记 HTTP 侧 actor。
  room.lastEditorUserId = userId;
  const res = await flushCanvasRoom(room, title);
  return { injected: true, contentVersion: res.contentVersion, snapshotted: res.snapshotted };
}

let registered = false;

/** 注册 canvas 的冷归结实现（幂等；装配入口 collab/index.ts 在启动时调用一次）。 */
export function registerCanvasFlusher(): void {
  if (registered) return;
  registerRoomFlusher("canvas", async (room) => {
    await flushCanvasRoom(room);
  });
  registered = true;
}

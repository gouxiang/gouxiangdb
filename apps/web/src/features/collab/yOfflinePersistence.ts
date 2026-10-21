// apps/web/src/features/collab/yOfflinePersistence.ts
// 离线 Yjs 更新的本地累积层（YN9 / S6-WEB-a）：断网刷新 / 重开后，字符级 CRDT 改动不丢、
// 重连由 y-websocket 的 sync step1/2 自动与服务端合并。
//
// 与 features/kb/draft.ts 的分工（两者刻意分开，不许互相替代）：
//   · gx-y:<roomId>   —— 本模块：Yjs **增量 update**（字符级 CRDT），重放后可自动合并；
//   · gx-kb-draft:    —— 整篇 Markdown 快照，崩溃/兜底恢复用，需要用户二选一，不能自动合并。
//
// doc 与 canvas 共用本模块：调用方只需提供房间 id（如 `doc:<id>` / `canvas:<id>`）与 Y update，
// 本文件不感知内容结构（order/blocks/texts 还是画板图元）。
//
// 存储格式（单键，localStorage，JSON + base64 二进制安全编码）：
//   { "v": 1,
//     "s"?: "<base64，已合并的快照 update，可选>",
//     "u":  [ { "b": "<base64 update>", "c": clientId, "t": tsMs, "q": seqInSegment } ] }
// 读取时把 s 与 u 内全部 update 经 Y.mergeUpdates 合成单条全量 update 灌入新 Y.Doc。
// 单键超过 MAX_STORED_KEY_CHARS 时就地压缩为一条快照（u 清空），避免增量无限增长。
//
// 环境安全：无 localStorage（SSR / node 单测）时所有写入口 no-op、读返回 null；
// 坏 JSON / 结构损坏 / base64 或 update 解码失败 → 丢弃该键并返回 null，绝不抛错。

import * as Y from "yjs";

const PREFIX = "gx-y:";
const FORMAT_VERSION = 1;

/**
 * 灌入（重放）本地累积状态时所用的事务 origin。仅用于标识/调试——是否回存实际只看
 * `transaction.local`（applyUpdate 强制 false），与 origin 取值无关。
 */
export const LOCAL_REPLAY_ORIGIN = "gx-y-local-replay";

/** 单键序列化字符数软上限（base64 全 ASCII，1 字符 ≈ 1 字节存储）。到限即压缩为快照。 */
export const MAX_STORED_KEY_CHARS = 2 * 1024 * 1024;

export interface LocalUpdateMeta {
  /** 产生该 update 的 Y.Doc clientID（Y.Doc.clientID），仅用于诊断/对账。 */
  clientId: number;
  /** 产生时间（Date.now() 毫秒）。 */
  ts: number;
}

interface StoredEntry {
  /** base64 编码的单条 Y update。 */
  b: string;
  c: number;
  t: number;
  /** 段内序号（压缩后归零），仅作观测，不参与合并正确性。 */
  q: number;
}

interface StoredShape {
  v: typeof FORMAT_VERSION;
  /** 已合并快照（base64）；存在时它是 u 的共同前缀状态。 */
  s?: string;
  u: StoredEntry[];
}

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageKey(roomId: string): string {
  return PREFIX + roomId;
}

/** 取 localStorage：不存在 / 被 SecurityError 禁用（SSR、隐私模式）一律视为不可用。 */
function getStorage(): MinimalStorage | null {
  try {
    const s = (globalThis as { localStorage?: MinimalStorage }).localStorage;
    if (s && typeof s.getItem === "function" && typeof s.setItem === "function") {
      return s;
    }
    return null;
  } catch {
    return null;
  }
}

/* ---------------- base64（分块，防长字符串 spread 爆栈；node22/浏览器均有全局 btoa/atob） ---------------- */

const B64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  const btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof btoa !== "function") throw new Error("btoa unavailable");
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const atob = (globalThis as { atob?: (s: string) => string }).atob;
  if (typeof atob !== "function") throw new Error("atob unavailable");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* ---------------- 形状读写（坏数据自愈：删键） ---------------- */

function isShape(value: unknown): value is StoredShape {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<StoredShape>;
  return (
    s.v === FORMAT_VERSION &&
    Array.isArray(s.u) &&
    (s.s === undefined || typeof s.s === "string") &&
    s.u.every((e) => e && typeof e.b === "string")
  );
}

/** 读并校验形状；缺失返回 null；损坏（JSON/结构非法）则删键并返回 null。 */
function readShape(store: MinimalStorage, key: string): StoredShape | null {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    dropKey(store, key);
    return null;
  }
  if (!isShape(parsed)) {
    dropKey(store, key);
    return null;
  }
  return parsed;
}

/** 快照（若有）+ 全部增量按存储顺序解码；任一条损坏即抛，由调用方决定丢键。 */
function decodeAll(shape: StoredShape): Uint8Array[] {
  const parts: Uint8Array[] = [];
  if (shape.s) parts.push(base64ToBytes(shape.s));
  for (const e of shape.u) parts.push(base64ToBytes(e.b));
  return parts;
}

function dropKey(store: MinimalStorage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ---------------- 对外 API ---------------- */

/**
 * 追加一条本地产生的 Y update。
 *
 * 调用方责任（见 collab-provider.ts 接线）：只传 **本地编辑事务** 的 update
 * （`transaction.local === true`）。从本地存储灌入、远端 sync step2、跨标签页 BroadcastChannel
 * 转发都走 Y.applyUpdate，而 yjs 在 applyUpdate 内部强制 `transaction.local = false`
 * （yjs 源码 readUpdateV2：`transaction.local = false`），故不会被二次回存。
 */
export function appendLocalUpdate(roomId: string, update: Uint8Array, meta: LocalUpdateMeta): void {
  if (!update || update.length === 0) return;
  const store = getStorage();
  if (!store) return;
  const key = storageKey(roomId);
  try {
    const shape = readShape(store, key) ?? { v: FORMAT_VERSION, u: [] };
    shape.u.push({
      b: bytesToBase64(update),
      c: Number.isFinite(meta.clientId) ? meta.clientId : 0,
      t: typeof meta.ts === "number" ? meta.ts : Date.now(),
      q: shape.u.length,
    });

    const serialized = JSON.stringify(shape);
    if (serialized.length <= MAX_STORED_KEY_CHARS) {
      store.setItem(key, serialized);
      return;
    }

    // 超软上限：把「快照 + 全部增量」mergeUpdates 压成单条全量 update 再存（纯函数，内存合并，
    // 不触碰任何 Y.Doc 实例）。mergeUpdates 输出即合法的全量 state update，可直接 applyUpdate。
    try {
      const snapshot = Y.mergeUpdates(decodeAll(shape));
      const compact: StoredShape = { v: FORMAT_VERSION, s: bytesToBase64(snapshot), u: [] };
      store.setItem(key, JSON.stringify(compact));
    } catch {
      // 旧条目已损坏无法合并，或快照仍超配额：保住「本次编辑」，重置为仅含当前增量的段。
      // 即便此处 setItem 再因配额失败也静默——上层仍有整篇 draft 与 REST 路径兜底。
      const fallback: StoredShape = { v: FORMAT_VERSION, u: [shape.u[shape.u.length - 1]!] };
      try {
        store.setItem(key, JSON.stringify(fallback));
      } catch {
        /* localStorage 不可写：放弃 gx-y 累积，draft/REST 仍在 */
      }
    }
  } catch {
    // 序列化 / 配额等任何意外：静默降级（与 draft.ts 同一姿态），绝不影响编辑主链路。
  }
}

/**
 * 读出某房间的全部本地更新，合并成单条全量 state update（供 Y.applyUpdate 灌入）。
 * 无存储 / 无更新 / 数据损坏（已删键）均返回 null，绝不抛错。
 */
export function loadMergedLocalState(roomId: string): Uint8Array | null {
  const store = getStorage();
  if (!store) return null;
  const key = storageKey(roomId);
  const shape = readShape(store, key);
  if (!shape || (!shape.s && shape.u.length === 0)) {
    if (shape) dropKey(store, key); // 空壳键：清掉
    return null;
  }
  try {
    const merged = Y.mergeUpdates(decodeAll(shape));
    return merged.length > 0 ? merged : null;
  } catch {
    // base64 / update 编码损坏：删键自愈，返回 null（上层退化为空 doc + 重新播种）。
    dropKey(store, key);
    return null;
  }
}

/** 是否存在尚未确认合并的本地更新（供调用方做状态展示/对账；canvas 刀可复用）。 */
export function hasLocalUpdates(roomId: string): boolean {
  const store = getStorage();
  if (!store) return false;
  const shape = readShape(store, storageKey(roomId));
  return !!shape && (!!shape.s || shape.u.length > 0);
}

/**
 * 清除某房间的本地累积。必须在「与服务端完成首次 sync、本地更新已被 sync 协议带走并合并」
 * 之后调用（collab-provider 的 sync 事件处）。removeItem 幂等，断线重连后再次 synced 可重复调。
 */
export function clearLocalUpdates(roomId: string): void {
  const store = getStorage();
  if (!store) return;
  dropKey(store, storageKey(roomId));
}

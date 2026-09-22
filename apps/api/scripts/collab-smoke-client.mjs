// apps/api/scripts/collab-smoke-client.mjs
// collab-smoke.mjs 的客户端半边：手写 y-protocols 客户端（**不引入 y-websocket**）。
//
// 为什么自己写：验收要证的是「服务端线格对不对」，用 y-websocket 会把服务端与客户端的
// 同一份实现假设带进来；这里按 y-websocket 同样的帧顺序手写一遍，跨实现互验才有意义。
//
// lib0 说明：y-protocols 的 sync API 要求调用方自己造 Encoder/Decoder，而 lib0 在本仓
// pnpm 布局下没提升到 apps/api/node_modules（实测 import("lib0/decoding") 抛
// ERR_MODULE_NOT_FOUND）。故按 lib0@0.2.117 的字段布局（Encoder: cpos/cbuf/bufs；
// Decoder: arr/pos）复刻一份——真正的编解码函数仍是 y-protocols 内部调的那份 lib0，
// 与服务端 src/collab/codec.ts 同口径（已在真 lib0 上逐字节对拍：writeUpdate /
// writeSyncStep1 / writeSyncStep2 / readSyncMessage(step1) 响应全等）。

import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";

export const MSG = { SYNC: 0, AWARENESS: 1, AUTH: 2, QUERY_AWARENESS: 3 };
export const SYNC_SUB = { STEP1: 0, STEP2: 1, UPDATE: 2 };
export const WAIT_MS = 6000;

// ---------------------------------------------------------------- 鸭子型 lib0 编解码

const createEncoder = () => ({ cpos: 0, cbuf: new Uint8Array(100), bufs: [] });
const createDecoder = (u) => ({ arr: u, pos: 0 });

const writeByte = (e, b) => {
  if (e.cpos === e.cbuf.length) {
    e.bufs.push(e.cbuf);
    e.cbuf = new Uint8Array(e.cbuf.length * 2);
    e.cpos = 0;
  }
  e.cbuf[e.cpos++] = b;
};
const writeVarUint = (e, n) => {
  let v = n;
  while (v > 0x7f) {
    writeByte(e, 0x80 | (0x7f & v));
    v = Math.floor(v / 128);
  }
  writeByte(e, 0x7f & v);
};
const toUint8Array = (e) => {
  let total = e.cpos;
  for (const b of e.bufs) total += b.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of e.bufs) {
    out.set(b, p);
    p += b.length;
  }
  out.set(e.cbuf.subarray(0, e.cpos), p);
  return out;
};
const readVarUint = (d) => {
  let num = 0;
  let mult = 1;
  while (d.pos < d.arr.length) {
    const b = d.arr[d.pos++];
    num += (b & 0x7f) * mult;
    mult *= 128;
    if (b < 0x80) return num;
  }
  return null;
};
const readVarUint8Array = (d) => {
  const len = readVarUint(d);
  if (len === null || d.pos + len > d.arr.length) return null;
  const out = d.arr.subarray(d.pos, d.pos + len);
  d.pos += len;
  return out;
};

export const varUintBytes = (n) => {
  const e = createEncoder();
  writeVarUint(e, n);
  return toUint8Array(e);
};

/** 把一段字节写成 varUint 长度前缀 + 裸字节（y-protocols 的 varUint8Array 线格）。 */
export const bytesVarUint8Array = (b) => {
  const len = varUintBytes(b.length);
  const out = new Uint8Array(len.length + b.length);
  out.set(len, 0);
  out.set(b, len.length);
  return out;
};

export const concat = (parts) => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
};

/** sync 帧：外层 messageSync 自己写，y-protocols 只写子类型（漏了会把帧读成 auth）。 */
export function encodeSyncStep1(doc) {
  const e = createEncoder();
  writeVarUint(e, MSG.SYNC);
  syncProtocol.writeSyncStep1(e, doc);
  return toUint8Array(e);
}

export function encodeSyncUpdate(update) {
  const e = createEncoder();
  writeVarUint(e, MSG.SYNC);
  syncProtocol.writeUpdate(e, update);
  return toUint8Array(e);
}

/** 读帧头的两个 varUint；用于判定「这条帧是不是 sync update」。 */
export function frameSubType(frame) {
  const d = createDecoder(frame);
  if (readVarUint(d) !== MSG.SYNC) return null;
  return readVarUint(d);
}

// ---------------------------------------------------------------- 客户端

export class CollabClient {
  constructor(url, opts = {}) {
    this.url = url;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState({ nick: opts.nick ?? "smoke", color: opts.color ?? "#2563EB" });
    this.syncSubs = [];
    this.ws = null;
    this.autoSend = opts.autoSend !== false;
    this.doc.on("update", (update, origin) => {
      if (origin === this) return; // 远端应用的更新不回环
      if (!this.autoSend) return;
      this.send(encodeSyncUpdate(update));
    });
  }

  send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {
        // 连上即发 step1 + 自己的 awareness（与 y-websocket 的握手顺序一致）
        ws.send(encodeSyncStep1(this.doc));
        const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
        ws.send(concat([varUintBytes(MSG.AWARENESS), bytesVarUint8Array(payload)]));
        resolve();
      });
      ws.on("error", reject);
      ws.on("message", (buf) => this.onFrame(new Uint8Array(buf)));
    });
  }

  onFrame(frame) {
    const decoder = createDecoder(frame);
    const messageType = readVarUint(decoder);
    if (process.env.GX_SMOKE_DEBUG) console.log("[dbg][cli] frame", frame.length, "type", messageType);
    if (messageType === MSG.SYNC) {
      const e = createEncoder();
      writeVarUint(e, MSG.SYNC);
      const sub = syncProtocol.readSyncMessage(decoder, e, this.doc, this);
      this.syncSubs.push(sub);
      const out = toUint8Array(e);
      if (out.length > 1) this.send(out); // 只有 step1 才有响应
      return;
    }
    if (messageType === MSG.AWARENESS) {
      const payload = readVarUint8Array(decoder);
      if (payload) awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, this);
    }
  }

  text() {
    return this.doc.getText("body").toString();
  }

  insert(s) {
    this.doc.getText("body").insert(this.doc.getText("body").length, s);
  }

  waitFor(pred, label) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        let ok = false;
        try {
          ok = pred();
        } catch {
          ok = false;
        }
        if (ok) return resolve();
        if (Date.now() - started > WAIT_MS) return reject(new Error(`超时等待：${label}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.awareness.destroy();
  }
}

/** 原始连接：只做「发帧 / 收帧 / 记关闭码」，用于鉴权与只读断言。 */
export function rawConnect(url) {
  const conn = { ws: null, frames: [], closeCode: null, closeReason: "" };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    conn.ws = ws;
    ws.on("open", () => resolve(conn));
    ws.on("error", reject);
    ws.on("message", (buf) => conn.frames.push(new Uint8Array(buf)));
    ws.on("close", (code, reason) => {
      conn.closeCode = code;
      conn.closeReason = reason ? reason.toString() : "";
    });
  });
}

export async function waitClose(conn, label) {
  const started = Date.now();
  while (conn.closeCode === null) {
    if (Date.now() - started > WAIT_MS) throw new Error(`超时等待关闭：${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return conn.closeCode;
}

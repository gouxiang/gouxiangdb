// apps/api/src/collab/codec.ts
// y-protocols 线上帧的编解码基座。
//
// ★ 为什么这里要「鸭子类型」复刻 lib0 的 Encoder/Decoder，而不是 import lib0：
//   lib0 是 yjs / y-protocols 的传递依赖，在本仓 pnpm 布局下**没有提升**到
//   apps/api/node_modules（实测：在 apps/api 下 import("lib0/decoding") 抛
//   ERR_MODULE_NOT_FOUND；node_modules/.pnpm/lib0@0.2.117 只在 pnpm 私有层可达）。
//   而 y-protocols 的 sync API 全是 (encoder|decoder, ...) 形态——调用方必须自己造出
//   一个 Encoder/Decoder 实例。阶段 1 的依赖清单里没有 lib0，本文件因此只复刻
//   lib0@0.2.117 的【对象字段布局】（Encoder: cpos/cbuf/bufs；Decoder: arr/pos），
//   真正的 encode/decode 函数仍然是 y-protocols 内部调用的那一份 lib0，语义零漂移。
//
// 已实测对照（真实 lib0 0.2.117，逐字节比较）：
//   writeUpdate / writeSyncStep1 / writeSyncStep2 / readSyncMessage(step1) 的响应
//   与真 lib0 产出的字节流**全等**（含超过初始 100 字节缓冲区触发的翻倍扩容路径）。
//   耦合面只有上面那四个字段名；升级 lib0 时若其内部布局变动，本文件是唯一改动点。

// 泛型参数写成 ArrayBuffer（而非默认的 ArrayBufferLike）：lib0 0.2.117 的 d.ts 在 TS 5.7
// 下会把这两个字段收成 Uint8Array<ArrayBuffer>，这里必须同型，否则把鸭子对象交给
// y-protocols 会报 SharedArrayBuffer 不兼容（不是运行时问题，纯类型对齐）。

/** lib0/encoding 的 Encoder 字段布局（复刻，非 import）。 */
export interface Encoder {
  /** 当前块游标。 */
  cpos: number;
  /** 当前写入块；写满即整块入 bufs 并换一块更大的。 */
  cbuf: Uint8Array<ArrayBuffer>;
  /** 已写满的历史块，按写入顺序排列。 */
  bufs: Uint8Array[];
}

/** lib0/decoding 的 Decoder 字段布局（复刻，非 import）。 */
export interface Decoder {
  arr: Uint8Array;
  pos: number;
}

const INITIAL_BUF_SIZE = 100;

/** 造一个空 Encoder（初始块 100 字节，与 lib0 一致）。 */
export function createEncoder(): Encoder {
  return { cpos: 0, cbuf: new Uint8Array(INITIAL_BUF_SIZE), bufs: [] };
}

/** 造一个 Decoder，游标在 0。 */
export function createDecoder(bytes: Uint8Array): Decoder {
  return { arr: bytes, pos: 0 };
}

/** 单字节写入，逐字复刻 lib0/encoding#write（写满整块入队 + 新块翻倍）。 */
function writeByte(encoder: Encoder, byte: number): void {
  const bufferLen = encoder.cbuf.length;
  if (encoder.cpos === bufferLen) {
    encoder.bufs.push(encoder.cbuf);
    encoder.cbuf = new Uint8Array(bufferLen * 2);
    encoder.cpos = 0;
  }
  encoder.cbuf[encoder.cpos++] = byte;
}

/** 写入一个 varUint（LEB128，7 位一组，高位续行）。与 lib0/encoding#writeVarUint 同口径。 */
export function writeVarUint(encoder: Encoder, num: number): void {
  let n = num;
  while (n > 0x7f) {
    writeByte(encoder, 0x80 | (0x7f & n));
    n = Math.floor(n / 128);
  }
  writeByte(encoder, 0x7f & n);
}

/** 把 Encoder 收成一条 Uint8Array。逐字复刻 lib0/encoding#toUint8Array。 */
export function toUint8Array(encoder: Encoder): Uint8Array {
  let total = encoder.cpos;
  for (const buf of encoder.bufs) total += buf.length;
  const out = new Uint8Array(total);
  let cur = 0;
  for (const buf of encoder.bufs) {
    out.set(buf, cur);
    cur += buf.length;
  }
  out.set(encoder.cbuf.subarray(0, encoder.cpos), cur);
  return out;
}

/** 读一个 varUint；游标推进。帧被截断时返回 null（调用方按「不认识的帧」处理）。 */
export function readVarUint(decoder: Decoder): number | null {
  let num = 0;
  let mult = 1;
  while (decoder.pos < decoder.arr.length) {
    const byte = decoder.arr[decoder.pos++];
    num += (byte & 0x7f) * mult;
    mult *= 128;
    if (byte < 0x80) return num;
  }
  return null;
}

/** 读一段 varUint8Array（varUint 长度 + 裸字节）；数据不足返回 null。 */
export function readVarUint8Array(decoder: Decoder): Uint8Array | null {
  const len = readVarUint(decoder);
  if (len === null) return null;
  if (decoder.pos + len > decoder.arr.length) return null;
  const out = decoder.arr.subarray(decoder.pos, decoder.pos + len);
  decoder.pos += len;
  return out;
}

/** 仅把 varUint 编成字节（用于自己拼帧，如 awareness 帧头）。 */
export function varUintBytes(num: number): Uint8Array {
  const encoder = createEncoder();
  writeVarUint(encoder, num);
  return toUint8Array(encoder);
}

/** 拼接若干 Uint8Array（拼帧用，避免再绕一层 Encoder）。 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let cur = 0;
  for (const p of parts) {
    out.set(p, cur);
    cur += p.length;
  }
  return out;
}

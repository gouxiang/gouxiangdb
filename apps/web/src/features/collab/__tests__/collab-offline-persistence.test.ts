// YN9/S6-WEB-a · collab-provider 与 gx-y 累积层的接线回归（node 环境，假 WebSocket + 内存 localStorage）。
// 覆盖：
//   A. 门控关（默认）：本地事务不写任何 gx-y 键（零行为变化）。
//   B. 门控开 + 取票失败（离线）：本地编辑累积 gx-y；「重开页面」（新建连接）在建 provider 前
//      灌入，doc 内容直接还原；灌入事务不被二次回存（键不膨胀）。
//   C. 门控开 + 建连收到 sync step2：清掉 gx-y、仅在确有本地累积时回调 onLocalMerged；
//      sync 后稳态编辑不再落盘；断线后编辑重新累积；重连再 sync 再清、再回调。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createCollabConnection, type CollabConnection } from "../collab-provider";
import { loadMergedLocalState } from "../yOfflinePersistence";
import type { CollabTicketResponse } from "@gx/shared-types";

const ORIGIN = "https://gx.example.com";
const WS_PATH = "/ws/collab/doc%3Aabc";
const ROOM = "doc:abc";
const KEY = "gx-y:" + ROOM;

function ticket(seq: number): CollabTicketResponse {
  return {
    ticket: `ticket-${seq}`,
    roomId: ROOM,
    expiresAt: Date.now() + 60_000,
    role: "editor",
    kind: "user",
    userId: "u1",
    nick: "阿强",
    color: "#1F6FEB",
    wsPath: WS_PATH,
    serverTime: Date.now(),
  };
}

class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (k: string): string | null => this.map.get(k) ?? null;
  setItem = (k: string, v: string): void => void this.map.set(k, v);
  removeItem = (k: string): void => void this.map.delete(k);
  raw(k: string): string | undefined {
    return this.map.get(k);
  }
  clear(): void {
    this.map.clear();
  }
}

type FrameListener = (ev: { data: unknown }) => void;

/** 假 WebSocket：支持 y-websocket 用到的 onopen/onmessage/onclose，并能投递二进制 sync 帧。 */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  private readonly frameListeners: FrameListener[] = [];

  constructor(readonly url: string | URL) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: FrameListener): void {
    if (type === "message") this.frameListeners.push(fn);
  }
  removeEventListener(): void {}
  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data !== "string") {
      this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    }
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }
  text(raw: string): void {
    for (const fn of this.frameListeners) fn({ data: raw });
  }
  binary(buf: Uint8Array): void {
    this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  }
  closeWith(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean: code === 1000 });
  }
}

/** LEB128 varUint（与 yjs/decoding 一致）。 */
function writeVarUint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

/** 构造 y-protocols sync step2 帧：[messageSync=0][step2=1][varUint(len)][update]。 */
function syncStep2Frame(update: Uint8Array): Uint8Array {
  const head = [0, 1, ...writeVarUint(update.length)];
  const out = new Uint8Array(head.length + update.length);
  out.set(head, 0);
  out.set(update, head.length);
  return out;
}

/** 空服务端房间的全量 update：客户端应用它即完成 sync（触发 sync 事件）。 */
const EMPTY_SERVER_STATE = Y.encodeStateAsUpdate(new Y.Doc());

let storage: MemoryStorage;
const conns: CollabConnection[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  for (const c of conns.splice(0)) c.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // @ts-expect-error 还原无 localStorage
  delete globalThis.localStorage;
});

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("门控关闭（默认）：零 localStorage 行为", () => {
  it("本地编辑事务不写任何 gx-y 键；取票失败离线亦然", async () => {
    const conn = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: false, // 显式关：即便环境注入了 VITE_OFFLINE_Y 也确定性断言
      fetchTicket: async () => {
        throw new Error("断网");
      },
    });
    conns.push(conn);
    await settle();
    expect(conn.status).toBe("offline");

    conn.doc.getMap("m").set("k", "v"); // 本地事务
    expect(storage.raw(KEY)).toBeUndefined();
    expect(loadMergedLocalState(ROOM)).toBeNull();
  });
});

describe("门控开启：离线累积与重开灌入", () => {
  it("取票失败（离线）时本地编辑写入 gx-y；新建连接在建 provider 前还原内容", async () => {
    const offline = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      fetchTicket: async () => {
        throw new Error("断网");
      },
    });
    conns.push(offline);
    await settle();
    expect(offline.status).toBe("offline");
    expect(FakeSocket.instances).toHaveLength(0); // 离线绝不建 WebSocket（未授权也不发）

    offline.doc.getText("body").insert(0, "断网前敲的字");
    expect(storage.raw(KEY)).toBeDefined();

    // 「刷新 / 重开页面」：销毁旧连接，用同一 room 建新连接（仍离线）。
    offline.disconnect();

    const reopened = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      fetchTicket: async () => {
        throw new Error("断网");
      },
    });
    conns.push(reopened);
    // 灌入在构造时同步完成，先于任何取票/建 provider：此刻 doc 已含离线内容。
    await settle();
    expect(reopened.status).toBe("offline");
    expect(reopened.doc.getText("body").toString()).toBe("断网前敲的字");

    // 灌入是 applyUpdate（transaction.local=false），不应回存导致 gx-y 膨胀：
    // 重开后不做任何编辑，键里仍是原来的单段增量。
    const shape = JSON.parse(storage.raw(KEY)!);
    expect(shape.u).toHaveLength(1);
  });

  it("多段离线编辑合并后文本完整还原", async () => {
    const a = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      fetchTicket: async () => {
        throw new Error("net");
      },
    });
    conns.push(a);
    await settle();
    a.doc.getText("body").insert(0, "AC");
    a.doc.getText("body").insert(1, "B");
    a.doc.getText("body").insert(3, "D");
    a.disconnect();

    const b = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      fetchTicket: async () => {
        throw new Error("net");
      },
    });
    conns.push(b);
    await settle();
    expect(b.doc.getText("body").toString()).toBe("ABCD");
  });
});

describe("门控开启：sync 确认合并后清盘 + 回调 + 累积窗口", () => {
  it("有本地累积时收到 step2 → 清 gx-y 并回调；回调只触发一次", async () => {
    let merged = 0;
    const conn = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      onLocalMerged: () => {
        merged += 1;
      },
      fetchTicket: async () => ticket(1),
    });
    conns.push(conn);
    await settle();
    const sock = FakeSocket.instances[0]!;
    // 连上之前先有离线编辑（模拟在 connecting 空窗敲字）
    conn.doc.getText("body").insert(0, "待合并");

    sock.accept();
    expect(conn.status).toBe("connected");
    sock.binary(syncStep2Frame(EMPTY_SERVER_STATE)); // 服务端 step2 → sync(true)

    expect(storage.raw(KEY)).toBeUndefined();
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(merged).toBe(1);
    // 再收到一次 step2（不应发生，但保险）：无待确认内容，不重复回调
    sock.binary(syncStep2Frame(EMPTY_SERVER_STATE));
    expect(merged).toBe(1);
  });

  it("sync 后稳态协同的编辑不再落盘；断线后编辑重新累积", async () => {
    const conn = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      fetchTicket: async () => ticket(1),
    });
    conns.push(conn);
    await settle();
    const sock = FakeSocket.instances[0]!;
    sock.accept();
    sock.binary(syncStep2Frame(EMPTY_SERVER_STATE)); // 完成首次 sync（无本地累积，不回调）
    expect(storage.raw(KEY)).toBeUndefined();

    // 已确认合并：稳态编辑不写 gx-y（避免无限增长），仍正常上行给 provider（这里不断言发送）。
    conn.doc.getText("body").insert(0, "在线敲字");
    expect(storage.raw(KEY)).toBeUndefined();

    // 断线（异常关闭码 → 走退避重连）：确认窗口关闭，离线编辑重新累积。
    sock.closeWith(1006);
    await settle();
    expect(conn.status).toBe("offline");
    conn.doc.getText("body").insert(conn.doc.getText("body").length, "→断线后");
    expect(storage.raw(KEY)).toBeDefined();
    expect(loadMergedLocalState(ROOM)).toBeInstanceOf(Uint8Array);
  });

  it("无本地累积时收到 step2 不触发 onLocalMerged（稳态不误清草稿）", async () => {
    let merged = 0;
    const conn = createCollabConnection(ROOM, {
      origin: ORIGIN,
      offlinePersistence: true,
      onLocalMerged: () => {
        merged += 1;
      },
      fetchTicket: async () => ticket(1),
    });
    conns.push(conn);
    await settle();
    FakeSocket.instances[0]!.accept();
    FakeSocket.instances[0]!.binary(syncStep2Frame(EMPTY_SERVER_STATE));
    expect(merged).toBe(0);
    expect(storage.raw(KEY)).toBeUndefined();
  });

  it("断线重连再次 sync：离线累积被清且再次回调", async () => {
    let merged = 0;
    const conn = createCollabConnection(ROOM, {
      origin: ORIGIN,
      random: () => 0.5,
      offlinePersistence: true,
      onLocalMerged: () => {
        merged += 1;
      },
      fetchTicket: async () => ticket(1),
    });
    conns.push(conn);
    await settle();
    const s1 = FakeSocket.instances[0]!;
    s1.accept();
    conn.doc.getText("body").insert(0, "首连内容");
    s1.binary(syncStep2Frame(EMPTY_SERVER_STATE));
    expect(merged).toBe(1);
    expect(storage.raw(KEY)).toBeUndefined();

    s1.closeWith(1006);
    await settle(1_000); // attempt1 → 1s 后退避到期，重新取票建新 socket
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    const s2 = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    s2.accept();
    conn.doc.getText("body").insert(conn.doc.getText("body").length, "重连前离线");
    s2.binary(syncStep2Frame(EMPTY_SERVER_STATE));
    expect(storage.raw(KEY)).toBeUndefined();
    expect(merged).toBe(2);
  });
});

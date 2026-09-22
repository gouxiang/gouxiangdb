// 阶段 2 · 发布通道回归：awareness 的 selection / leases 写入口。
//
// 背景：provider 是**异步**建的（要先拿到服务端票据才知道 wsPath），而页面一进文档就要开始
// 上报光标。这里锁死三件事：① 票据回来之前的发布请求被缓存、建好后补发；② 传 null 能清字段；
// ③ disconnect 后发布不再生效（也不炸）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollabConnection, type CollabConnection } from "../collab-provider";
import { toPresenceEntries } from "../collab-presence";
import type { CollabPresenceEntry, CollabTicketResponse } from "@gx/shared-types";

const ORIGIN = "https://gx.example.com";
const ROOM_ID = "doc:abc";

function makeTicket(seq = 1): CollabTicketResponse {
  return {
    ticket: `ticket-${seq}`,
    roomId: ROOM_ID,
    expiresAt: Date.now() + 60_000,
    role: "editor",
    kind: "user",
    userId: "u-1",
    nick: "阿强",
    color: "#1F6FEB",
    wsPath: "/ws/collab/doc%3Aabc",
    serverTime: Date.now(),
  };
}

/** 只实现 y-websocket 真正用到的那部分；不需要真的收发帧。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

let connections: CollabConnection[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  connections = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  for (const conn of connections) conn.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SELECTION = { kind: "doc" as const, blockId: "b1", offset: 4, length: 0 };
const LEASES = [{ unit: "b1", since: 1_000, expiresAt: 16_000 }];

/**
 * 建一条连接并订阅名单。
 * `before` 在**票据返回之前**（provider 还不存在）同步执行 —— 正是「缓存待补发」要覆盖的窗口。
 */
async function connectWithWatch(
  before?: (conn: CollabConnection) => void,
): Promise<{
  conn: CollabConnection;
  latest: () => CollabPresenceEntry[];
  raw: () => Record<string, unknown> | undefined;
}> {
  let latest: CollabPresenceEntry[] = [];
  let raw: Record<string, unknown> | undefined;
  const conn = createCollabConnection(ROOM_ID, {
    origin: ORIGIN,
    random: () => 0.5,
    fetchTicket: async () => makeTicket(),
  });
  connections.push(conn);
  conn.onAwarenessChange((states) => {
    latest = toPresenceEntries(states);
    raw = states.get(conn.doc.clientID);
  });
  before?.(conn);
  await vi.advanceTimersByTimeAsync(0); // 票据 Promise 走完 → provider 建好 → 补发
  return { conn, latest: () => latest, raw: () => raw };
}

describe("本地字段发布（selection / leases）", () => {
  it("provider 尚未创建（首张票据未回）时先缓存，provider 建好后补发", async () => {
    const { latest } = await connectWithWatch((conn) => {
      // 此刻 provider 还没建：票据是 await 出来的，先发的包不能丢
      conn.setLocalFields({ selection: SELECTION, leases: LEASES });
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const me = latest()[0];
    expect(me).toBeDefined();
    expect(me!.selection).toEqual(SELECTION);
    expect(me!.leases).toEqual(LEASES);
  });

  it("传 null 清掉该字段（裁剪后的名单里回到 null，未传的字段不受影响）", async () => {
    const { conn, latest, raw } = await connectWithWatch((c) =>
      c.setLocalFields({ selection: SELECTION, leases: LEASES }),
    );
    expect(latest()[0]!.selection).toEqual(SELECTION);

    conn.setLocalFields({ selection: null });
    expect(latest()[0]!.selection).toBeNull();
    // y-protocols@1.0.7 的 setLocalStateField 是「赋 null」而非 delete 键；
    // 接收侧（collab-presence 的白名单裁剪）对 null 与缺键一视同仁 → selection: null。
    expect(raw()!.selection).toBeNull();
    // 未清的字段不受影响
    expect(latest()[0]!.leases).toEqual(LEASES);
  });

  it("一次调用可以只改一个字段，其他字段不动", async () => {
    const { conn, latest } = await connectWithWatch((c) =>
      c.setLocalFields({ selection: SELECTION, leases: LEASES }),
    );

    conn.setLocalFields({ leases: [] });
    expect(latest()[0]!.leases).toEqual([]);
    expect(latest()[0]!.selection).toEqual(SELECTION);
  });

  it("disconnect 后发布被丢弃：不炸、也不再改动 awareness", async () => {
    const { conn, latest } = await connectWithWatch((c) => c.setLocalFields({ selection: SELECTION }));
    const before = latest()[0]!.selection;
    expect(before).toEqual(SELECTION);

    conn.disconnect();
    expect(() => conn.setLocalFields({ selection: null, leases: [] })).not.toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(latest()[0]!.selection).toEqual(SELECTION); // 仍保持断连前的值：发布已失效
  });
});

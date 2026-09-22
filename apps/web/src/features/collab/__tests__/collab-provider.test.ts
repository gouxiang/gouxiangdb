// 阶段 1 · 连接层回归：WS 地址拼装、退避序列、永久错误判定、
// 以及**最关键的「重连前必须重新取票」**（服务端票据 60s 单次核销，复用旧票必被拒）。
//
// 不依赖真实网络：替换全局 WebSocket 为假实现，并注入假票据源。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MAX_MS,
  backoffDelayMs,
  buildWsUrl,
  createCollabConnection,
  denyReasonOfClose,
  type CollabConnection,
} from "../collab-provider";
import type { CollabPresenceEntry, CollabTicketResponse, UserDTO } from "@gx/shared-types";
import { toPresenceEntries } from "../collab-presence";
import { useAuthStore } from "../../../store/auth";

const ORIGIN = "https://gx.example.com";
const WS_PATH = "/ws/collab/doc%3Aabc";
const ROOM_ID = "doc:abc";

function makeTicket(seq: number, patch: Partial<CollabTicketResponse> = {}): CollabTicketResponse {
  return {
    ticket: `ticket-${seq}`,
    roomId: ROOM_ID,
    expiresAt: Date.now() + 60_000,
    role: "editor",
    kind: "user",
    userId: "u-from-ticket",
    nick: "阿强",
    color: "#1F6FEB",
    wsPath: WS_PATH,
    serverTime: Date.now(),
    ...patch,
  };
}

/** 本地会话的用户（id 故意与票据下发的不同，用于证明票据优先）。 */
const LOCAL_USER: UserDTO = {
  id: "u-local-session",
  email: "local@gx.test",
  displayName: "本地",
  username: null,
  phone: null,
  avatarUrl: null,
  bio: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

type FrameListener = (ev: { data: unknown }) => void;

/**
 * 假 WebSocket：只实现 y-websocket 真正用到的那部分。
 * readyState 的数值必须与真实 WebSocket 一致（库里有 `readyState === WebSocket.OPEN` 比较）。
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  private readonly frameListeners: FrameListener[] = [];

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: FrameListener): void {
    if (type === "message") this.frameListeners.push(fn);
  }
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // —— 测试驱动的服务端行为 ——
  serverAccept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  serverText(raw: string): void {
    for (const fn of this.frameListeners) fn({ data: raw });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
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

/** 让 await 的票据 Promise 走完；async 函数会在 microtask 里推进。 */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 建一条连接，返回可变的取票记录数组（每次取票都会 push 一次 roomId）。 */
async function connectOnce(): Promise<{
  conn: CollabConnection;
  ticketCalls: CollabTicketResponse[];
  statuses: string[];
}> {
  const ticketCalls: CollabTicketResponse[] = [];
  const statuses: string[] = [];
  const conn = createCollabConnection(ROOM_ID, {
    origin: ORIGIN,
    random: () => 0.5, // 固定抖动，延迟即退避基准值
    fetchTicket: async (roomId) => {
      expect(roomId).toBe(ROOM_ID);
      const ticket = makeTicket(ticketCalls.length + 1);
      ticketCalls.push(ticket);
      return ticket;
    },
    onStatus: (s) => statuses.push(s),
  });
  connections.push(conn);
  await flush();
  return { conn, ticketCalls, statuses };
}

describe("buildWsUrl", () => {
  it("http → ws，https → wss（换头不动主机与端口）", () => {
    expect(buildWsUrl(WS_PATH, "tk", "http://localhost:5173")).toBe(
      "ws://localhost:5173/ws/collab/doc%3Aabc?t=tk",
    );
    expect(buildWsUrl(WS_PATH, "tk", "https://gx.example.com")).toBe(
      "wss://gx.example.com/ws/collab/doc%3Aabc?t=tk",
    );
  });

  it("wsPath 自带 basePath 时原样保留（子路径部署）", () => {
    expect(buildWsUrl("/app/gouxiangdb/ws/collab/doc%3Aabc", "tk", "https://nas.local")).toBe(
      "wss://nas.local/app/gouxiangdb/ws/collab/doc%3Aabc?t=tk",
    );
  });

  it("wsPath 缺前导斜杠时补上", () => {
    expect(buildWsUrl("ws/collab/doc%3Aabc", "tk", "http://localhost")).toBe(
      "ws://localhost/ws/collab/doc%3Aabc?t=tk",
    );
  });

  it("票据必须 encode（含空格、#、&、?、/ 等分隔字符）", () => {
    const out = buildWsUrl(WS_PATH, "a b#c&d?e/f", "https://gx.example.com");
    expect(out).toBe("wss://gx.example.com/ws/collab/doc%3Aabc?t=a%20b%23c%26d%3Fe%2Ff");
    // 查询串里不能再出现第二个 '?'，否则服务端会把票据截断
    expect(out.slice(out.indexOf("?") + 1).match(/\?/g)).toBeNull();
  });
});

describe("退避序列", () => {
  it("1s→2s→4s→8s 递增并在 30s 封顶（抖动取中值时即为基准值）", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(1, noJitter)).toBe(1_000);
    expect(backoffDelayMs(2, noJitter)).toBe(2_000);
    expect(backoffDelayMs(3, noJitter)).toBe(4_000);
    expect(backoffDelayMs(4, noJitter)).toBe(8_000);
    expect(backoffDelayMs(6, noJitter)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(20, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it("抖动范围在 ±20% 内", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(800);
    expect(backoffDelayMs(1, () => 1)).toBe(1_200);
    expect(backoffDelayMs(5, () => 0)).toBe(12_800);
    expect(backoffDelayMs(5, () => 1)).toBe(19_200);
  });

  it("attempt 为 0 或负数时按第一次算（防御性的非正输入）", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(1_000);
    expect(backoffDelayMs(-3, () => 0.5)).toBe(1_000);
  });
});

describe("永久错误判定", () => {
  it("4400–4499 是永久错误（停止重连）", () => {
    for (const code of [4400, 4401, 4403, 4408, 4444, 4499]) {
      expect(denyReasonOfClose(code)).toBeDefined();
    }
    expect(denyReasonOfClose(4401)).toBe("ticket_invalid");
    expect(denyReasonOfClose(4403)).toBe("readonly");
    expect(denyReasonOfClose(4408)).toBe("handshake_timeout");
    expect(denyReasonOfClose(4499)).toBe("no_access");
  });
});

describe("连接生命周期", () => {
  it("首连：用第一张票据打开正确的地址，接通后状态为 connected", async () => {
    const { conn, ticketCalls } = await connectOnce();
    expect(ticketCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // 分解出来的地址必须与 buildWsUrl 算出的完全一致（库用 serverUrl+roomname+params 拼）
    expect(FakeWebSocket.instances[0]!.url).toBe(buildWsUrl(WS_PATH, "ticket-1", ORIGIN));

    FakeWebSocket.instances[0]!.serverAccept();
    expect(conn.status).toBe("connected");
  });

  it("重连前必定重新取票（票据单次核销，这是本阶段最关键回归点）", async () => {
    const { conn, ticketCalls } = await connectOnce();
    const first = FakeWebSocket.instances[0]!;
    first.serverAccept();
    expect(conn.status).toBe("connected");

    first.serverClose(1006, "abnormal");
    expect(conn.status).toBe("offline");

    // 先只推进一小段：库自带的内部重连会在 200ms 左右触发，若它抢先，
    // 用的就是已核销的旧票 —— 断言此时既没有新建连接也没有重新取票。
    await flush(400);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ticketCalls).toHaveLength(1);

    // 推进到我们自己的退避窗口之后（attempt=1 → 1s）
    await flush(700);
    expect(ticketCalls).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toBe(buildWsUrl(WS_PATH, "ticket-2", ORIGIN));
    expect(FakeWebSocket.instances[1]!.url).not.toContain("ticket-1");
    expect(conn.status).toBe("reconnecting");
  });

  it("第二次失败后按退避逐级变长，并在成功连接后重置", async () => {
    const { conn, ticketCalls } = await connectOnce();
    FakeWebSocket.instances[0]!.serverAccept();

    FakeWebSocket.instances[0]!.serverClose(1001, "going away");
    await flush(1_000); // attempt 1 → 1s：第 2 次取票
    expect(ticketCalls).toHaveLength(2);
    FakeWebSocket.instances[1]!.serverClose(1006, "abnormal");

    await flush(1_500); // attempt 2 → 2s：这段时间内不应建连
    expect(ticketCalls).toHaveLength(2);
    await flush(600); // 越过 2s 界
    expect(ticketCalls).toHaveLength(3);

    FakeWebSocket.instances[2]!.serverAccept();
    expect(conn.status).toBe("connected");

    // 成功后退避重置：下一次失败回到 1s，而不是继续往 4s 走
    FakeWebSocket.instances[2]!.serverClose(1000, "");
    await flush(1_000);
    expect(ticketCalls).toHaveLength(4);
  });

  it.each([4401, 4403, 4408])("关闭码 %i 是永久错误：置 denied 且不再重试", async (code) => {
    const { conn, ticketCalls } = await connectOnce();
    FakeWebSocket.instances[0]!.serverAccept();
    FakeWebSocket.instances[0]!.serverClose(code, "denied");

    expect(conn.status).toBe("denied");
    expect(conn.denyReason).toBe(denyReasonOfClose(code));

    await flush(120_000); // 远超任何退避窗口
    expect(ticketCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("服务端文本控制帧 revoked → denied + 断开，不再重连", async () => {
    const { conn, ticketCalls } = await connectOnce();
    const socket = FakeWebSocket.instances[0]!;
    socket.serverAccept();

    socket.serverText(JSON.stringify({ type: "revoked", reason: "downgraded", message: "降权" }));
    expect(conn.status).toBe("denied");
    expect(conn.denyReason).toBe("downgraded");

    await flush(120_000);
    expect(ticketCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("非法 JSON 文本帧与非 revoked 类型都被忽略，不影响同步状态", async () => {
    const { conn } = await connectOnce();
    const socket = FakeWebSocket.instances[0]!;
    socket.serverAccept();

    socket.serverText("{not json");
    socket.serverText(JSON.stringify({ type: "peer_left", id: "x" }));
    expect(conn.status).toBe("connected");
  });

  it("disconnect 幂等：重复调用不报错且会停掉后续重试", async () => {
    const { conn, ticketCalls } = await connectOnce();
    FakeWebSocket.instances[0]!.serverClose(1006, "abnormal");

    conn.disconnect();
    expect(() => conn.disconnect()).not.toThrow();
    expect(conn.status).toBe("idle");

    await flush(120_000);
    expect(ticketCalls).toHaveLength(1);
  });

  it("主动 disconnect 不会被误判成需要重连的断线", async () => {
    const { conn, ticketCalls } = await connectOnce();
    FakeWebSocket.instances[0]!.serverAccept();

    conn.disconnect();
    await flush(120_000);
    expect(ticketCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("取票失败按一次失败处理：继续退避重试而不是永久拒绝", async () => {
    const statuses: string[] = [];
    let fail = true;
    const conn = createCollabConnection(ROOM_ID, {
      origin: ORIGIN,
      random: () => 0.5,
      fetchTicket: async () => {
        if (fail) throw new Error("取票失败");
        return makeTicket(1);
      },
      onStatus: (s) => statuses.push(s),
    });
    connections.push(conn);
    await flush();

    expect(conn.status).toBe("offline");
    fail = false;
    await flush(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses).toContain("reconnecting");
  });
});

describe("身份下发（awareness user 载荷）", () => {
  beforeEach(() => useAuthStore.setState({ user: LOCAL_USER }));
  afterEach(() => useAuthStore.setState({ user: null }));

  /** 本机是唯一 peer：连通后裁剪出来的第 0 条 presence 就是自己的条目。 */
  async function selfUserId(patch: Partial<CollabTicketResponse>): Promise<string | null | undefined> {
    let latest: CollabPresenceEntry[] = [];
    const conn = createCollabConnection(ROOM_ID, {
      origin: ORIGIN,
      random: () => 0.5,
      fetchTicket: async () => makeTicket(1, patch),
    });
    connections.push(conn);
    conn.onAwarenessChange((states) => {
      latest = toPresenceEntries(states);
    });
    await flush();
    return latest[0]?.userId;
  }

  it("登录用户：票据下发的 userId 优先于本地会话", async () => {
    expect(await selfUserId({ kind: "user", userId: "u-from-ticket" })).toBe("u-from-ticket");
  });

  it("票据未携带 userId 时才临时回落本地会话（老服务端 / 字段缺失）", async () => {
    expect(await selfUserId({ kind: "user", userId: null })).toBe("u-local-session");
  });

  it("访客：恒为 null，本地同时存在登录会话也不回落", async () => {
    expect(await selfUserId({ kind: "guest", userId: null, nick: "匿名" })).toBeNull();
  });
});

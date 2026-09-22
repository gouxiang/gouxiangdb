// apps/api/src/collab/__tests__/room-coldflush.test.ts
// 冷归结门的回归保护（DESIGN §2.3 冷档 + §12-A1 30s 兜底）。
//
// 起因（真机实测）：registry 的 30s 兜底节拍原本拿 `room.dirty` 当门，而 dirty 会被 500ms
// 热持久化清掉 —— 于是「长会话每 30s 兜底」一次都不触发，冷归结只剩「房间空置」和
// 「优雅关闭」两条路径。实测两人开着页面打了 42 秒字，kb_docs 一动不动，界面却恒定
// 显示「已保存到云端」。
//
// 本文件锁住的契约：
//   ① 一次编辑同时置起 dirty（热）与 coldDirty（冷）；
//   ② 热持久化跑完只清 dirty，coldDirty 必须还在（否则 30s 兜底永不触发）；
//   ③ 冷归结成功才清 coldDirty；失败（flusher 抛错）必须保留，下一轮接着试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CollabConn, CollabSocket } from "../room.js";

const saveCollabState = vi.fn(async () => {});
vi.mock("../store.js", () => ({
  saveCollabState: (...args: unknown[]) => saveCollabState(...(args as [])),
  loadCollabState: async () => ({ state: null, baseVersion: null }),
}));

type RoomMod = typeof import("../room.js");

function fakeSocket(): CollabSocket {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
    ping: () => {},
    terminate: () => {},
  };
}

function fakeConn(overrides: Partial<CollabConn> = {}): CollabConn {
  return {
    id: "c1",
    ws: fakeSocket(),
    alive: true,
    subject: "user",
    userId: "u1",
    role: "editor",
    nick: "u1",
    color: "#DC2626",
    ...overrides,
  } as CollabConn;
}

/** canvas 是阶段未接主库的 kind，本文件给它注册假 flusher，不与 doc 的真 flusher 冲突。 */
let room: InstanceType<RoomMod["CollabRoom"]>;
let HOT_DEBOUNCE_MS: number;
let roomMod: RoomMod;

beforeEach(async () => {
  vi.resetModules();
  saveCollabState.mockClear();
  roomMod = await import("../room.js");
  HOT_DEBOUNCE_MS = roomMod.HOT_DEBOUNCE_MS;
  room = new roomMod.CollabRoom({
    roomId: "canvas:r1",
    kind: "canvas",
    initialState: null,
    baseVersion: 1,
  });
  room.addConn(fakeConn());
});

afterEach(() => {
  room.destroy();
});

/** 等热持久化的防抖窗口跑完（HOT_DEBOUNCE_MS 之外再留一档余量）。 */
function waitHot(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, HOT_DEBOUNCE_MS + 120));
}

describe("冷归结门 coldDirty", () => {
  it("① 一次远端编辑同时置起 dirty 与 coldDirty", () => {
    // 用一条带 conn origin 的 update 触发 handleDocUpdate（origin 不是 conn 时不认领编辑者）
    const src = new Y.Doc();
    src.getText("t").insert(0, "x");
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(src), fakeConn());
    expect(room.dirty).toBe(true);
    expect(room.coldDirty).toBe(true);
  });

  it("② 热持久化跑完只清 dirty，coldDirty 必须保留（否则 30s 兜底永不触发）", async () => {
    const src = new Y.Doc();
    src.getText("t").insert(0, "x");
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(src), fakeConn());

    await waitHot();

    expect(saveCollabState).toHaveBeenCalledTimes(1); // 热持久化确实跑过
    expect(room.dirty).toBe(false); // 热门已清
    expect(room.coldDirty).toBe(true); // ★ 冷门必须还在
  });

  it("③ 归结成功才清 coldDirty", async () => {
    const calls = { n: 0 };
    roomMod.registerRoomFlusher("canvas", async () => {
      calls.n += 1;
    });
    const src = new Y.Doc();
    src.getText("t").insert(0, "x");
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(src), fakeConn());
    await waitHot();

    await room.flush("tick");
    expect(calls.n).toBe(1);
    expect(room.coldDirty).toBe(false);
  });

  it("④ 归结失败保留 coldDirty，下一轮 tick 会再试（失败不得静默）", async () => {
    const calls = { n: 0 };
    roomMod.registerRoomFlusher("canvas", async () => {
      calls.n += 1;
      throw new Error("boom");
    });
    const src = new Y.Doc();
    src.getText("t").insert(0, "x");
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(src), fakeConn());
    await waitHot();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await room.flush("tick");
    await room.flush("tick");
    errSpy.mockRestore();

    expect(calls.n).toBe(2); // 第二轮的门还开着
    expect(room.coldDirty).toBe(true);
  });
});

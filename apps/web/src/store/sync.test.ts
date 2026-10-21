// apps/web/src/store/sync.test.ts
// 六态派生 + store actions 的纯 node 单测（无 jsdom）。
import { describe, it, expect, beforeEach, vi } from "vitest";

// store 模块在求值时创建 zustand persist；其默认 storage = createJSONStorage(() => window.localStorage)。
// 纯 node 无 window → storage 解析为空，persist 走早退分支、hook 上不挂 `.persist`（仅 node 现象，
// 浏览器里恒有 localStorage）。此用例要断言 partialize，故在【任何 import 之前】（vi.hoisted 最先执行）
// 注入一个最小内存 localStorage，复刻真实宿主；不碰生产代码、不引 jsdom。
vi.hoisted(() => {
  const mem = new Map<string, string>();
  const localStorage = {
    getItem: (name: string) => (mem.has(name) ? mem.get(name)! : null),
    setItem: (name: string, value: string) => void mem.set(name, String(value)),
    removeItem: (name: string) => void mem.delete(name),
    clear: () => mem.clear(),
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: {
      // 部分模块（src/node/datasource.ts）在求值期读 window.location.origin，须给非浏览器兜底。
      location: { origin: "http://localhost", href: "http://localhost/" },
      localStorage,
    },
    configurable: true,
    writable: true,
  });
});

import {
  derivePhase,
  toDeriveInput,
  toPendingConflict,
  useSyncStore,
  type DerivePhaseInput,
} from "./sync";
import { disabledSyncStatus, type IncomingItem, type LocalSyncStatus } from "../api/localSync";

function input(over: Partial<DerivePhaseInput> = {}): DerivePhaseInput {
  return {
    enabled: true,
    online: true,
    inFlight: false,
    pendingOutbox: 0,
    quarantinedCount: 0,
    conflictCount: 0,
    hasRemoteBase: true,
    lastError: null,
    ...over,
  };
}

function status(over: Partial<LocalSyncStatus> = {}): LocalSyncStatus {
  return { ...disabledSyncStatus(), enabled: true, ...over };
}

describe("derivePhase 六态", () => {
  it("未启用恒为 null（门控外不渲染）", () => {
    expect(derivePhase(input({ enabled: false }))).toBeNull();
  });

  it("在线已同步 → online", () => {
    expect(derivePhase(input())).toBe("online");
  });

  it("在线且一轮在飞 → syncing", () => {
    expect(derivePhase(input({ inFlight: true }))).toBe("syncing");
  });

  it("在线空闲但仍有待发出箱 → syncing", () => {
    expect(derivePhase(input({ pendingOutbox: 3 }))).toBe("syncing");
  });

  it("在线有 lastError 且不在飞 → error；在飞时不报 error", () => {
    expect(derivePhase(input({ lastError: "boom" }))).toBe("error");
    expect(derivePhase(input({ lastError: "boom", inFlight: true }))).toBe("syncing");
  });

  it("隔离条数 >0 最优先 → quarantined（压过在线/错误/在飞）", () => {
    expect(derivePhase(input({ quarantinedCount: 1 }))).toBe("quarantined");
    expect(derivePhase(input({ quarantinedCount: 2, inFlight: true, lastError: "x" }))).toBe("quarantined");
  });

  it("离线且有远端副本 → offlinePending", () => {
    expect(derivePhase(input({ online: false, hasRemoteBase: true }))).toBe("offlinePending");
    expect(derivePhase(input({ online: false, hasRemoteBase: true, pendingOutbox: 5 }))).toBe("offlinePending");
  });

  it("离线且从无远端 → offlineLocalOnly", () => {
    expect(derivePhase(input({ online: false, hasRemoteBase: false }))).toBe("offlineLocalOnly");
  });

  it("离线即使有 lastError 也归离线态（离线网络错不算 error 退避）", () => {
    expect(derivePhase(input({ online: false, hasRemoteBase: false, lastError: "net" }))).toBe("offlineLocalOnly");
  });

  it("离线有隔离项仍最优先 quarantined", () => {
    expect(derivePhase(input({ online: false, quarantinedCount: 1 }))).toBe("quarantined");
  });

  it("冲突条数不改变 phase（由弹窗独立承载）", () => {
    expect(derivePhase(input({ conflictCount: 9 }))).toBe("online");
  });
});

describe("toDeriveInput", () => {
  it("inFlight/stage 与 hasRemoteBase 投影正确", () => {
    const d = toDeriveInput(status({ inFlight: true, stage: "push" }), true);
    expect(d.inFlight).toBe(true);
    expect(d.hasRemoteBase).toBe(false);

    const d2 = toDeriveInput(status({ lastPushedAt: "2026-10-20T00:00:00.000Z", stage: "idle" }), true);
    expect(d2.hasRemoteBase).toBe(true);
    expect(d2.inFlight).toBe(false);

    const d3 = toDeriveInput(status({ bases: [{ id: "b1", name: null, lastPulledAt: null, lastPushedAt: null }] }), false);
    expect(d3.hasRemoteBase).toBe(true);
    expect(d3.online).toBe(false);
  });

  it("disabled 报告投影 enabled=false", () => {
    expect(toDeriveInput(disabledSyncStatus(), true).enabled).toBe(false);
  });
});

describe("toPendingConflict", () => {
  const item: IncomingItem = {
    id: "in1",
    clientOpId: "cop1",
    baseId: "b1",
    entityType: "record",
    entityId: "r1",
    op: "update",
    payload: { a: 1 },
    baseVersion: "3",
    status: "conflict",
    reasonCode: "SYNC_VERSION_CONFLICT",
    reasonDetail: null,
    serverVersion: "4",
    conflictServerPayload: { a: 2 },
    attempts: 1,
    createdAt: null,
    decidedAt: null,
  };
  it("映射双栏左右值", () => {
    const c = toPendingConflict(item)!;
    expect(c.mine).toEqual({ a: 1 });
    expect(c.theirs).toEqual({ a: 2 });
    expect(c.incomingId).toBe("in1");
    expect(c.clientOpId).toBe("cop1");
  });
  it("缺主键返回 null；缺快照 theirs=null", () => {
    expect(toPendingConflict({ ...item, id: "" })).toBeNull();
    expect(toPendingConflict({ ...item, conflictServerPayload: null })!.theirs).toBeNull();
  });
});

describe("useSyncStore actions", () => {
  beforeEach(() => {
    useSyncStore.getState().resetRuntime();
    useSyncStore.getState().setTab("status");
  });

  it("初始为禁用空态、phase=null、抽屉关", () => {
    const s = useSyncStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.phase).toBeNull();
    expect(s.centerOpen).toBe(false);
    expect(s.conflicts).toEqual([]);
  });

  it("setSyncSnapshot 写入报告并重算 phase", () => {
    useSyncStore.getState().setSyncSnapshot(status({ pendingOutbox: 2 }), true, 123);
    const s = useSyncStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("syncing");
    expect(s.report.pendingOutbox).toBe(2);
    expect(s.lastFetchedAt).toBe(123);
  });

  it("setOnline 仅切换在线位并重算 phase", () => {
    useSyncStore.getState().setSyncSnapshot(status(), true);
    expect(useSyncStore.getState().phase).toBe("online");
    useSyncStore.getState().setOnline(false);
    // status() 无 base/水位 → hasRemoteBase=false → 离线纯本地。
    expect(useSyncStore.getState().phase).toBe("offlineLocalOnly");
  });

  it("离线有远端（曾推送）→ offlinePending", () => {
    useSyncStore.getState().setSyncSnapshot(status({ lastPushedAt: "2026-10-20T00:00:00.000Z" }), false);
    expect(useSyncStore.getState().phase).toBe("offlinePending");
  });

  it("离线无远端 → offlineLocalOnly", () => {
    useSyncStore.getState().setSyncSnapshot(status(), false);
    expect(useSyncStore.getState().phase).toBe("offlineLocalOnly");
  });

  it("冲突队列入队/出队（按 incomingId 与 clientOpId）", () => {
    useSyncStore.getState().replaceConflicts([
      {
        id: "i1", clientOpId: "c1", baseId: null, entityType: "record", entityId: "e", op: "update",
        payload: {}, baseVersion: "1", status: "conflict", reasonCode: null, reasonDetail: null,
        serverVersion: "2", conflictServerPayload: {}, attempts: 1, createdAt: null, decidedAt: null,
      },
    ]);
    expect(useSyncStore.getState().conflicts).toHaveLength(1);
    useSyncStore.getState().dismissConflict({ clientOpId: "c1" });
    expect(useSyncStore.getState().conflicts).toHaveLength(0);
  });

  it("抽屉开关与 tab", () => {
    useSyncStore.getState().openCenter("incoming");
    expect(useSyncStore.getState().centerOpen).toBe(true);
    expect(useSyncStore.getState().lastTab).toBe("incoming");
    useSyncStore.getState().closeCenter();
    expect(useSyncStore.getState().centerOpen).toBe(false);
  });

  it("resetRuntime 回零运行时态但保留 lastTab 偏好", () => {
    useSyncStore.getState().openCenter("storage");
    useSyncStore.getState().setSyncSnapshot(status(), true);
    useSyncStore.getState().resetRuntime();
    const s = useSyncStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.phase).toBeNull();
    expect(s.centerOpen).toBe(false);
    expect(s.lastTab).toBe("storage"); // 偏好保留
  });

  it("persist 仅持久化 lastTab（运行时态不入 localStorage）", () => {
    const opts = useSyncStore.persist.getOptions();
    const sliced = opts.partialize?.(useSyncStore.getState());
    expect(sliced).toEqual({ lastTab: expect.any(String) });
  });
});

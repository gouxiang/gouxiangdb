// launcherStore.ts 测试（纯 node + 内存 Storage + fake 登录）。
// 锁定：动作后自动持久化并通知；跨"重启"（用同一 storage 新建 store）恢复活动数据源；
// 远端无已存会话时恢复后无活动；getActive 与活动节点一致。

import { describe, it, expect, vi } from "vitest";
import { createLauncherStore, type ShellStoreHooks } from "./launcherStore";
import { LAUNCHER_REGISTRY_STORAGE_KEY } from "./registry";
import { REMOTE_SESSION_KEY_PREFIX } from "./remoteSessions";
import type { KvStorage } from "./remoteSessions";

class MemStorage implements KvStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const baseDeps = () => ({
  getLocalBase: () => "",
  getOrigin: () => "http://127.0.0.1:5999",
  getLocalToken: () => "local-jwt",
  now: () => "2026-10-17T00:00:00.000Z",
});

describe("自动持久化与订阅", () => {
  it("connectLocal 后注册表写入 gx-node-launcher 且订阅者被通知", async () => {
    const storage = new MemStorage();
    const store = createLauncherStore({ storage, ...baseDeps() });
    let n = 0;
    store.subscribe(() => {
      n += 1;
    });
    await store.connectLocal();
    const raw = storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY) ?? "";
    const saved = JSON.parse(raw);
    expect(saved.activeNodeId).toBe("local");
    expect(saved.localDesired).toBe("running");
    expect(n).toBe(1);
    expect(store.getActive()?.kind).toBe("local");
  });

  it("addRemote 持久化但不成为活动、不通知活动数据源（active 仍 null）", () => {
    const storage = new MemStorage();
    const store = createLauncherStore({ storage, ...baseDeps() });
    store.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    expect(store.getActive()).toBeNull();
    expect(store.getState().entries.some((e) => e.nodeId === "aaaa")).toBe(true);
  });
});

describe("跨重启恢复", () => {
  it("活动本地：用同一 storage 新建 store 即恢复 local 数据源", async () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    await s1.connectLocal();

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getState().activeNodeId).toBe("local");
    expect(s2.getActive()?.kind).toBe("local");
    expect(s2.getActive()?.token).toBe("local-jwt");
  });

  it("活动远端且会话已存：恢复远端数据源（免登）", async () => {
    const storage = new MemStorage();
    const login = vi.fn(async () => ({ token: "saved-rt", user: null }));
    const s1 = createLauncherStore({ storage, ...baseDeps(), loginRemote: login });
    s1.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    await s1.connectRemote("aaaa");
    expect(storage.getItem(`${REMOTE_SESSION_KEY_PREFIX}:aaaa`)).toContain("saved-rt");

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getActive()?.kind).toBe("remote");
    expect(s2.getActive()?.token).toBe("saved-rt");
    expect(s2.getActive()?.baseURL).toBe("http://nas:3001");
  });

  it("活动远端但会话被清：恢复后无活动（停启动器）", () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    s1.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    // 手工把注册表 active 指向远端，但不写会话（模拟登出过）
    const reg = JSON.parse(storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY) as string);
    reg.activeNodeId = "aaaa";
    storage.setItem(LAUNCHER_REGISTRY_STORAGE_KEY, JSON.stringify(reg));

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getActive()).toBeNull();
  });

  it("本地节点 stopped 持久化后，重启仍保持 stopped、无活动", async () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    await s1.connectLocal();
    await s1.disconnect("local");
    expect(s1.getState().localDesired).toBe("stopped");

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getState().localDesired).toBe("stopped");
    expect(s2.getActive()).toBeNull();
  });
});

describe("独立启停（W2）", () => {
  const fakeShell = (
    over: Partial<ShellStoreHooks> = {},
  ): ShellStoreHooks => ({
    ensureLocalReady: vi.fn(async () => {}),
    syncUpstream: vi.fn(async () => {}),
    stopLocal: vi.fn(async () => {}),
    startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
    stopLocalOnly: vi.fn(async () => {}),
    ...over,
  });

  it("非壳（无 shell）：startLocalOnly 注册本地条目但 active 仍 null、回 firstBoot=false、不抛错", async () => {
    const storage = new MemStorage();
    const store = createLauncherStore({ storage, ...baseDeps() });
    const r = await store.startLocalOnly();
    expect(r).toEqual({ firstBoot: false });
    const state = store.getState();
    expect(state.entries.some((e) => e.kind === "local")).toBe(true);
    expect(state.localDesired).toBe("running");
    expect(state.activeNodeId).toBeNull();
    expect(store.getActive()).toBeNull();
  });

  it("壳模式：startLocalOnly 注册条目、active 仍 null，并调用 shell.startLocalOnly 透传 firstBoot", async () => {
    const storage = new MemStorage();
    const startLocalOnly = vi.fn(async () => ({ firstBoot: true }));
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ startLocalOnly }),
    });
    const r = await store.startLocalOnly();
    expect(r).toEqual({ firstBoot: true });
    expect(startLocalOnly).toHaveBeenCalledOnce();
    expect(store.getState().activeNodeId).toBeNull();
    // 已持久化（跨重启条目仍在）
    const raw = JSON.parse(storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY) ?? "{}");
    expect(raw.entries.some((e: { kind: string }) => e.kind === "local")).toBe(true);
  });

  it("壳模式：stopLocalOnly 后 desired=stopped、条目保留、active 不变、shell 钩子被调", async () => {
    const storage = new MemStorage();
    const stopLocalOnly = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ stopLocalOnly }),
    });
    await store.connectLocal();
    expect(store.getState().activeNodeId).toBe("local");
    await store.stopLocalOnly();
    expect(stopLocalOnly).toHaveBeenCalledOnce();
    const state = store.getState();
    expect(state.localDesired).toBe("stopped");
    expect(state.entries.some((e) => e.kind === "local")).toBe(true);
    expect(state.activeNodeId).toBe("local"); // 不 disconnect
  });

  it("非壳（无 shell）：stopLocalOnly 不抛错，只落注册表期望停止", async () => {
    const storage = new MemStorage();
    const store = createLauncherStore({ storage, ...baseDeps() });
    await store.connectLocal();
    await expect(store.stopLocalOnly()).resolves.toBeUndefined();
    expect(store.getState().localDesired).toBe("stopped");
    expect(store.getState().activeNodeId).toBe("local");
  });

  it("shell.startLocalOnly 抛错：错误上抛且注册表条目已落（与 connectLocal 的失败回滚语义不同）", async () => {
    const storage = new MemStorage();
    const startLocalOnly = vi.fn(async () => {
      throw new Error("内核启动失败");
    });
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ startLocalOnly }),
    });
    await expect(store.startLocalOnly()).rejects.toThrow("内核启动失败");
    // persist 发生在 shell 调用之前：条目已登记，UI 下次可重试/停止。
    expect(store.getState().entries.some((e) => e.kind === "local")).toBe(true);
  });
});

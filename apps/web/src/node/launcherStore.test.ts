// launcherStore.ts 测试（纯 node + 内存 Storage + fake 登录）。
// 锁定：动作后自动持久化并通知；跨"重启"（用同一 storage 新建 store）恢复活动数据源；
// 远端无已存会话时恢复后无活动；getActive 与活动节点一致。

import { describe, it, expect, vi } from "vitest";
import { createLauncherStore } from "./launcherStore";
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
  it("connectLocal 后注册表写入 gx-node-launcher 且订阅者被通知", () => {
    const storage = new MemStorage();
    const store = createLauncherStore({ storage, ...baseDeps() });
    let n = 0;
    store.subscribe(() => {
      n += 1;
    });
    store.connectLocal();
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
  it("活动本地：用同一 storage 新建 store 即恢复 local 数据源", () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    s1.connectLocal();

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

  it("本地节点 stopped 持久化后，重启仍保持 stopped、无活动", () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    s1.connectLocal();
    s1.disconnect("local");
    expect(s1.getState().localDesired).toBe("stopped");

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getState().localDesired).toBe("stopped");
    expect(s2.getActive()).toBeNull();
  });
});

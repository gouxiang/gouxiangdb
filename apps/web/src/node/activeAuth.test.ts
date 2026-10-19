// activeAuth.ts 单测（node 环境）：登录/改密结果按「当前活动数据源」分槽的三个出口。
//  - commitLoginForActiveSource：门控关/本地→false（调用方写 gx-auth）；远端→写该节点分键 true；
//  - patchActiveRemoteUser：改密 me() 失败兜底，仅补丁远端会话 user；
//  - refreshActiveSourceUser：改密 me() 成功，用当前活动数据源 token 重写会话；本地 handled:false。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UserDTO } from "@gx/shared-types";
import {
  commitLoginForActiveSource,
  patchActiveRemoteUser,
  refreshActiveSourceUser,
  isActiveRemoteSource,
} from "./activeAuth";
import { dataSourceResolver } from "./datasource";
import {
  createLauncherStore,
  getLauncherStore,
  __resetLauncherStoreForTest,
} from "./launcherStore";
import type { KvStorage } from "./remoteSessions";
import { useAuthStore } from "../store/auth";

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

const user = (over: Partial<UserDTO> = {}): UserDTO =>
  ({ id: "u1", email: "a@b.c", displayName: "A", ...over }) as UserDTO;

function stubWindow(storage: MemStorage) {
  // 注意：不带 __TAURI_INTERNALS__，hasShell()=false → getLauncherStore 走 browserDefaultDeps，
  // resolver/base/origin/token 经 overrides 注入，纯选路路径不调用 loginRemote。
  vi.stubGlobal("window", {
    localStorage: storage,
    location: { origin: "http://127.0.0.1:7788" },
  });
}

describe("activeAuth（门控关 / 本地：现网零变化）", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });

  it("门控关：isActiveRemoteSource=false，commit 返回 false（由调用方写本地 gx-auth）", () => {
    expect(isActiveRemoteSource()).toBe(false);
    expect(commitLoginForActiveSource("jwt", user())).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("门控开但活动源是本机：refresh 返回 handled:false + 当前本地 token，patch 返回 false", () => {
    vi.stubEnv("VITE_NODE_LAUNCHER", "1");
    dataSourceResolver.setActive({
      nodeId: "local",
      kind: "local",
      baseURL: "",
      token: "local-jwt",
      wsOrigin: "ws://x",
    });
    expect(isActiveRemoteSource()).toBe(false);
    const r = refreshActiveSourceUser(user({ mustChangePassword: false }));
    expect(r.handled).toBe(false);
    expect(r.token).toBe("local-jwt");
    expect(patchActiveRemoteUser({ mustChangePassword: false })).toBe(false);
  });
});

describe("activeAuth（门控开 + 活动远端，单例 store）", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    vi.stubEnv("VITE_NODE_LAUNCHER", "1");
    stubWindow(storage);
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });

  /** 构造浏览器单例（activeAuth 内部 getLauncherStore 拿到的正是它）+ 添加并纯选路到一个远端。 */
  async function setupRoutedRemote(nodeId = "abc123def456") {
    const store = getLauncherStore({
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:7788",
      getLocalToken: () => null,
    });
    store.addRemote({ nodeId, baseURL: "http://nas:3001" });
    await store.connectRemote(nodeId);
    return store;
  }

  it("remote-empty 即算活动远端；登录提交 → commit 写分键并重推带 token 数据源", async () => {
    const store = await setupRoutedRemote();
    expect(isActiveRemoteSource()).toBe(true);
    expect(dataSourceResolver.current().token).toBeNull();

    const handled = commitLoginForActiveSource("remote-jwt", user());
    expect(handled).toBe(true);
    expect(dataSourceResolver.current().kind).toBe("remote");
    expect(dataSourceResolver.current().token).toBe("remote-jwt");
    // 分键信封落盘，本地 gx-auth 不被污染
    expect(storage.getItem("gx-node-session:abc123def456")).toContain("remote-jwt");
    expect(useAuthStore.getState().token).toBeNull();
    expect(store.getRemoteSession("abc123def456")?.user?.id).toBe("u1");
  });

  it("patchActiveRemoteUser：只合并 user 字段、token 沿用", async () => {
    const store = await setupRoutedRemote();
    commitLoginForActiveSource("jwt-1", user({ mustChangePassword: true }));
    expect(patchActiveRemoteUser({ mustChangePassword: false })).toBe(true);
    const sess = store.getRemoteSession("abc123def456");
    expect(sess?.token).toBe("jwt-1");
    expect(sess?.user?.mustChangePassword).toBe(false);
    expect(sess?.user?.id).toBe("u1");
  });

  it("refreshActiveSourceUser：改密后用当前活动数据源 token 重写会话（远端）", async () => {
    const store = await setupRoutedRemote();
    commitLoginForActiveSource("jwt-after-change", user({ mustChangePassword: true }));
    const r = refreshActiveSourceUser(user({ mustChangePassword: false }));
    expect(r.handled).toBe(true);
    expect(r.token).toBe("jwt-after-change");
    expect(store.getRemoteSession("abc123def456")?.user?.mustChangePassword).toBe(false);
    expect(dataSourceResolver.current().token).toBe("jwt-after-change");
  });

  it("refreshActiveSourceUser：远端活动源竟无 token → fail-closed 抛错，绝不写空会话", async () => {
    // 手动构造一个独立 store + 幽灵远端 resolver（注册表无该节点，模拟不可达异常态）。
    const ghost = new MemStorage();
    createLauncherStore({
      storage: ghost,
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:7788",
      getLocalToken: () => null,
    });
    dataSourceResolver.setActive({
      nodeId: "ghost",
      kind: "remote",
      baseURL: "http://ghost:3001",
      token: null,
      wsOrigin: "ws://ghost:3001",
    });
    expect(() => refreshActiveSourceUser(user())).toThrow(/token/);
    expect(ghost.getItem("gx-node-session:ghost")).toBeNull();
  });
});

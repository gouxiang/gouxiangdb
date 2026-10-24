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
  deauthenticateActiveSource,
  isActiveIsolatedSource,
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
    useAuthStore.setState({ token: null, user: null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
    useAuthStore.setState({ token: null, user: null });
  });

  it("门控关：isActiveIsolatedSource=false，commit 返回 false（由调用方写本地 gx-auth）", () => {
    expect(isActiveIsolatedSource()).toBe(false);
    expect(commitLoginForActiveSource("jwt", user())).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("deauthenticateActiveSource：本地源返回 false（由调用方走原 logout），不清本地 store", () => {
    useAuthStore.getState().setAuth("local-jwt", user());
    expect(deauthenticateActiveSource()).toBe(false);
    expect(useAuthStore.getState().token).toBe("local-jwt");
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
    expect(isActiveIsolatedSource()).toBe(false);
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
    expect(isActiveIsolatedSource()).toBe(true);
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

  it("deauthenticateActiveSource：远端源返回 true 且清该节点会话、保持选路态（个人中心退出）", async () => {
    const store = await setupRoutedRemote();
    commitLoginForActiveSource("jwt-quit", user());
    expect(dataSourceResolver.current().token).toBe("jwt-quit");
    expect(store.getRemoteSession("abc123def456")?.token).toBe("jwt-quit");

    expect(deauthenticateActiveSource()).toBe(true);
    // fire-and-forget：让出微任务让 deauthenticateRemote 落盘/重推数据源
    await Promise.resolve();
    await Promise.resolve();

    // 选路态不变（仍是该远端节点），但会话与数据源 token 已清
    expect(store.getState().activeNodeId).toBe("abc123def456");
    expect(store.getRemoteSession("abc123def456")).toBeNull();
    expect(dataSourceResolver.current().kind).toBe("remote");
    expect(dataSourceResolver.current().nodeId).toBe("abc123def456");
    expect(dataSourceResolver.current().token).toBeNull();
    // 本地 gx-auth 全程不被触碰
    expect(useAuthStore.getState().token).toBeNull();
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

describe("activeAuth（门控开 + 活动离线副本：JWT 走副本分键，绝不写 gx-auth）", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    vi.stubEnv("VITE_NODE_LAUNCHER", "1");
    stubWindow(storage);
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
    useAuthStore.setState({ token: null, user: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
    useAuthStore.setState({ token: null, user: null });
  });

  /**
   * 构造一份含主库 + 副本 office-1 的注册表（冷启动 activeNodeId 必须为 null：2b 起活动副本
   * 在构造前被归一化、restore 也 fail-closed，不再跨重启自动激活），随后用**在线**纯选路
   * controller.connectNodeById("office-1")（applyActive(true)，允许空令牌）把副本激活进 resolver。
   */
  function setupRoutedReplica() {
    // 手工构造 version:1 注册表（主库 primary + 副本 replica，冷启动无活动节点）。
    const registry = {
      version: 1,
      activeNodeId: null,
      localDesired: "running",
      entries: [
        { kind: "local", role: "primary", nodeId: "local", baseURL: "", label: "本机", lastConnectedAt: null },
        {
          kind: "local",
          role: "replica",
          nodeId: "office-1",
          baseURL: "",
          label: "办公室副本",
          lastConnectedAt: null,
          replica: { remoteBaseUrl: "http://nas:3001", clientId: null, syncIntervalMs: null },
        },
      ],
    };
    storage.setItem("gx-node-launcher", JSON.stringify(registry));
    const store = getLauncherStore({
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:7788",
      getLocalToken: () => "primary-jwt",
    });
    // 在线激活副本（无会话也允许空 token，进副本自己的登录引导），等价于用户在启动器点进该副本。
    const outcome = store.controller.connectNodeById("office-1");
    expect(outcome.active?.nodeId).toBe("office-1");
    return store;
  }

  it("副本 ds kind='local' 但 nodeId=副本名 → isActiveIsolatedSource=true（不按 kind 误判为主库）", () => {
    setupRoutedReplica();
    const ds = dataSourceResolver.current();
    expect(ds.kind).toBe("local");
    expect(ds.nodeId).toBe("office-1");
    expect(ds.token).toBeNull(); // 在线激活副本、无分键会话 → 空 token 槽（不串主库 gx-auth）
    expect(isActiveIsolatedSource()).toBe(true);
  });

  it("登录提交：JWT 落 gx-node-session:office-1，重推副本数据源，不写 gx-auth", () => {
    const store = setupRoutedReplica();
    const handled = commitLoginForActiveSource("rep-jwt", user());
    expect(handled).toBe(true);
    expect(storage.getItem("gx-node-session:office-1")).toContain("rep-jwt");
    expect(useAuthStore.getState().token).toBeNull(); // 主库 gx-auth 不被污染
    const ds = dataSourceResolver.current();
    expect(ds.nodeId).toBe("office-1");
    expect(ds.kind).toBe("local");
    expect(ds.token).toBe("rep-jwt");
    expect(store.getRemoteSession("office-1")?.user?.id).toBe("u1");
  });

  it("deauthenticate：清副本分键、保持选路态（仍指副本，token=null），不动 gx-auth", async () => {
    const store = setupRoutedReplica();
    commitLoginForActiveSource("rep-jwt", user());
    expect(deauthenticateActiveSource()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getRemoteSession("office-1")).toBeNull();
    expect(dataSourceResolver.current().nodeId).toBe("office-1");
    expect(dataSourceResolver.current().kind).toBe("local");
    expect(dataSourceResolver.current().token).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("refreshActiveSourceUser：副本改密后用副本 token 重写副本分键", () => {
    setupRoutedReplica();
    commitLoginForActiveSource("rep-jwt", user({ mustChangePassword: true }));
    const r = refreshActiveSourceUser(user({ mustChangePassword: false }));
    expect(r.handled).toBe(true);
    expect(r.token).toBe("rep-jwt");
    expect(JSON.parse(storage.getItem("gx-node-session:office-1") as string).user.mustChangePassword).toBe(false);
  });
});

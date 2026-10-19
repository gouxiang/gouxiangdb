// activeSession.ts 单测（node 环境）：
//  ① deriveActiveSession 纯选择器矩阵（门控关强制 local；remote-empty；带会话远端）；
//  ② useActiveSession 在伪 dispatcher 下的引用稳定（同签名同引用，登录态变化才换引用）；
//  ③ 门控开 + 真实 launcher store 的远端全链路：纯选路 remote-empty → commit 已认证 →
//     deauthenticate 回到 remote-empty（kind/nodeId 不变，这是守卫送回远端登录页的依据）。
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import type { UserDTO } from "@gx/shared-types";
import {
  deriveActiveSession,
  useActiveSession,
  __resetActiveSessionForTest,
} from "./activeSession";
import { LOCAL_NODE_ID } from "./resolve";
import { dataSourceResolver } from "./datasource";
import { useAuthStore } from "../store/auth";
import { createLauncherStore } from "./launcherStore";
import { __resetLauncherStoreForTest } from "./launcherStore";
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

const user = (over: Partial<UserDTO> = {}): UserDTO =>
  ({ id: "u1", email: "a@b.c", displayName: "A", ...over }) as UserDTO;

function localDs(token: string | null) {
  return { nodeId: LOCAL_NODE_ID, kind: "local" as const, baseURL: "", token, wsOrigin: "ws://x" };
}
function remoteDs(nodeId: string, token: string | null) {
  return {
    nodeId,
    kind: "remote" as const,
    baseURL: "http://nas:3001",
    token,
    wsOrigin: "ws://nas:3001",
  };
}

describe("deriveActiveSession 纯选择器", () => {
  it("门控关：即便 ds 是远端也强制按 local 读（现网零变化）", () => {
    const v = deriveActiveSession({
      enabled: false,
      ds: remoteDs("r1", "rt"),
      localUser: null,
      remoteSession: null,
    });
    expect(v).toEqual({
      enabled: false,
      kind: "local",
      nodeId: LOCAL_NODE_ID,
      token: null, // ds.kind=remote → 不取其 token
      user: null,
      authenticated: false,
    });
  });

  it("门控关 + local ds + gx-auth 已登录：authenticated=true、user 即本地用户", () => {
    const u = user();
    const v = deriveActiveSession({
      enabled: false,
      ds: localDs("local-jwt"),
      localUser: u,
      remoteSession: null,
    });
    expect(v.kind).toBe("local");
    expect(v.token).toBe("local-jwt");
    expect(v.user).toBe(u);
    expect(v.authenticated).toBe(true);
  });

  it("门控开 + local ds（无 token）：未登录本机，authenticated=false", () => {
    const v = deriveActiveSession({
      enabled: true,
      ds: localDs(null),
      localUser: null,
      remoteSession: null,
    });
    expect(v.kind).toBe("local");
    expect(v.authenticated).toBe(false);
  });

  it("门控开 + remote ds 无 token 无会话：remote-empty，authenticated=false", () => {
    const v = deriveActiveSession({
      enabled: true,
      ds: remoteDs("r1", null),
      localUser: user(), // 本地即便有登录态也不算远端认证
      remoteSession: null,
    });
    expect(v.kind).toBe("remote");
    expect(v.nodeId).toBe("r1");
    expect(v.token).toBeNull();
    expect(v.user).toBeNull();
    expect(v.authenticated).toBe(false);
  });

  it("门控开 + remote ds 带 token + 会话 user：authenticated=true，user 取远端会话", () => {
    const ru = user({ mustChangePassword: true });
    const v = deriveActiveSession({
      enabled: true,
      ds: remoteDs("r1", "rt"),
      localUser: user({ id: "local-user" }),
      remoteSession: { nodeId: "r1", token: "rt", user: ru },
    });
    expect(v.authenticated).toBe(true);
    expect(v.user?.id).toBe("u1");
    expect(v.user?.mustChangePassword).toBe(true);
  });
});

// ---- useSyncExternalStore 伪 dispatcher（node 环境无 fiber，同 view-guard-hook-order 手法）----
const INTERNALS = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    ReactCurrentDispatcher: { current: unknown };
  };
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

function renderHook<T>(fn: () => T): T {
  INTERNALS.ReactCurrentDispatcher.current = {
    useSyncExternalStore: (_sub: unknown, get: () => T) => get(),
  };
  try {
    return fn();
  } finally {
    INTERNALS.ReactCurrentDispatcher.current = null;
  }
}

describe("useActiveSession 引用稳定（门控关，纯 local/gx-auth）", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    __resetActiveSessionForTest();
    useAuthStore.setState({ token: null, user: null });
    dataSourceResolver.setActive(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetActiveSessionForTest();
    useAuthStore.setState({ token: null, user: null });
    dataSourceResolver.setActive(null);
  });

  it("同态两拍返回同一引用；gx-auth 登录/登出后才换引用", () => {
    const v1 = renderHook(() => useActiveSession());
    const v2 = renderHook(() => useActiveSession());
    expect(v2).toBe(v1);
    expect(v1.authenticated).toBe(false);

    useAuthStore.getState().setAuth("local-jwt", user());
    const v3 = renderHook(() => useActiveSession());
    expect(v3).not.toBe(v2);
    expect(v3.authenticated).toBe(true);
    expect(v3.user?.id).toBe("u1");

    useAuthStore.getState().logout();
    const v4 = renderHook(() => useActiveSession());
    expect(v4.authenticated).toBe(false);
  });

  it("仅 user 的无关字段变化但签名相同（id/mustChangePassword/updatedAt 不变）→ 引用稳定", () => {
    useAuthStore.getState().setAuth("t", user({ displayName: "旧名" }));
    const v1 = renderHook(() => useActiveSession());
    useAuthStore.getState().updateUser({ displayName: "新名" });
    const v2 = renderHook(() => useActiveSession());
    expect(v2).toBe(v1); // 显示名不在签名里，避免无意义重渲
  });
});

describe("useActiveSession 门控开远端全链路（真实 launcher store）", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    vi.stubEnv("VITE_NODE_LAUNCHER", "1");
    // activeSession 读远端会话要求浏览器环境：桩一个最小 window.localStorage。
    vi.stubGlobal("window", {
      localStorage: storage,
      location: { origin: "http://127.0.0.1:7788" },
    });
    __resetActiveSessionForTest();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetActiveSessionForTest();
    __resetLauncherStoreForTest();
    dataSourceResolver.setActive(null);
  });

  it("纯选路→remote-empty；commit 后已认证；deauthenticate 回 remote-empty 但仍指同一远端", async () => {
    const store = createLauncherStore({
      storage,
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:7788",
      getLocalToken: () => null,
    });
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    await store.connectRemote("abc123def456");

    const empty = renderHook(() => useActiveSession());
    expect(empty.enabled).toBe(true);
    expect(empty.kind).toBe("remote");
    expect(empty.nodeId).toBe("abc123def456");
    expect(empty.token).toBeNull();
    expect(empty.authenticated).toBe(false);

    // 远端自己的登录页提交成功 → JWT/user 落该节点分键，数据源重推带 token
    store.commitRemoteSession("abc123def456", "remote-jwt", user({ mustChangePassword: true }));
    const authed = renderHook(() => useActiveSession());
    expect(authed.authenticated).toBe(true);
    expect(authed.token).toBe("remote-jwt");
    expect(authed.user?.mustChangePassword).toBe(true);

    // 401：deauthenticate 清会话但保持选路态——守卫据此把用户送回同一远端的登录页
    await store.deauthenticateRemote("abc123def456");
    const back = renderHook(() => useActiveSession());
    expect(back.kind).toBe("remote");
    expect(back.nodeId).toBe("abc123def456");
    expect(back.authenticated).toBe(false);
    expect(back.token).toBeNull();
  });
});

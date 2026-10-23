// #1056 个人资料写成功后的会话回写分流（syncActiveUser）纯链路测试（node 环境）。
//
// useUpdateMe / useUploadAvatar / useRemoveAvatar 的 onSuccess 统一走 syncActiveUser：
//   - 活动源是远端（桌面壳）→ 用当前活动数据源 token + 最新 user 重写该节点会话分键
//     （commit 触发通知，顶栏/抽屉即时刷新），且不污染本地 gx-auth；
//   - 本地源/门控关 → updateUser 写本地 gx-auth，现网逐字节不变。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UserDTO } from "@gx/shared-types";
import { syncActiveUser } from "../hooks";
import { dataSourceResolver } from "../../node/datasource";
import {
  createLauncherStore,
  getLauncherStore,
  __resetLauncherStoreForTest,
} from "../../node/launcherStore";
import type { KvStorage } from "../../node/remoteSessions";
import { useAuthStore } from "../../store/auth";
import { commitLoginForActiveSource } from "../../node/activeAuth";

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
  vi.stubGlobal("window", {
    localStorage: storage,
    location: { origin: "http://127.0.0.1:7788" },
  });
}

describe("syncActiveUser（门控关 / 本地）", () => {
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

  it("本地源：更新写本地 gx-auth（displayName 生效），无远端会话分键", () => {
    useAuthStore.getState().setAuth("local-jwt", user({ displayName: "旧名" }));
    syncActiveUser(user({ displayName: "新名" }));
    expect(useAuthStore.getState().user?.displayName).toBe("新名");
  });
});

describe("syncActiveUser（门控开 + 活动远端）", () => {
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

  it("远端源：更新重写该节点会话分键，本地 gx-auth 不被写入", async () => {
    const store = getLauncherStore({
      resolver: dataSourceResolver,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:7788",
      getLocalToken: () => null,
    });
    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    await store.connectRemote("abc123def456");
    commitLoginForActiveSource("remote-jwt", user({ displayName: "旧名" }));

    syncActiveUser(user({ displayName: "远端新名" }));

    // 远端会话分键里的 user 已更新
    const sess = store.getRemoteSession("abc123def456");
    expect(sess?.user?.displayName).toBe("远端新名");
    // token 沿用当前活动数据源令牌
    expect(sess?.token).toBe("remote-jwt");
    // 本地 gx-auth 保持空（未污染）
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("异常远端（活动远端源竟无 token）refresh fail-closed 抛错时回落本地，不吞错", () => {
    // 构造单例 store（注册表为空），resolver 指向 token=null 的远端——
    // refreshActiveSourceUser 对此 fail-closed 抛错（见 activeAuth.ts），syncActiveUser 须回落本地。
    getLauncherStore({
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
    useAuthStore.getState().setAuth("local-jwt", user({ displayName: "旧" }));
    expect(() => syncActiveUser(user({ displayName: "本地兜底名" }))).not.toThrow();
    expect(useAuthStore.getState().user?.displayName).toBe("本地兜底名");
  });
});

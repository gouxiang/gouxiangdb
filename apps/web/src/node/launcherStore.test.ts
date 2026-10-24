// launcherStore.ts 测试（纯 node + 内存 Storage + fake 登录）。
// 锁定：动作后自动持久化并通知；跨"重启"（用同一 storage 新建 store）恢复活动数据源；
// 远端无已存会话时恢复后无活动；getActive 与活动节点一致。

import { describe, it, expect, vi } from "vitest";
import { createLauncherStore, type ShellStoreHooks } from "./launcherStore";
import type { StartReplicaArg } from "./shellBridge";
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

/** 一套默认成功的假壳钩子；用 over 覆盖单个钩子（如失败的 startReplica）。 */
const fakeShell = (over: Partial<ShellStoreHooks> = {}): ShellStoreHooks => ({
  ensureLocalReady: vi.fn(async () => {}),
  syncUpstream: vi.fn(async () => {}),
  stopLocal: vi.fn(async () => {}),
  startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
  stopLocalOnly: vi.fn(async () => {}),
  startReplica: vi.fn(async () => ({
    ok: true as const,
    kernelPort: 41000,
    initialized: true,
    nodeId: "office-1",
  })),
  stopReplica: vi.fn(async () => {}),
  replicaStatus: vi.fn(async () => ({
    added: true,
    initialized: true,
    running: true,
    ready: true,
    kernelPort: 41000,
  })),
  ...over,
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
    const login = vi.fn(async () => ({ token: "should-never-login", user: null }));
    const s1 = createLauncherStore({ storage, ...baseDeps(), loginRemote: login });
    s1.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    // 纯选路：connectRemote 不登录；远端会话由其自己登录页提交后经 commitRemoteSession 记住。
    s1.commitRemoteSession("aaaa", "saved-rt", null);
    await s1.connectRemote("aaaa");
    expect(login).not.toHaveBeenCalled();
    expect(s1.getActive()?.token).toBe("saved-rt");
    expect(storage.getItem(`${REMOTE_SESSION_KEY_PREFIX}:aaaa`)).toContain("saved-rt");

    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getActive()?.kind).toBe("remote");
    expect(s2.getActive()?.token).toBe("saved-rt");
    expect(s2.getActive()?.baseURL).toBe("http://nas:3001");
  });

  it("纯选路无会话：connectRemote 后活动远端 token=null（remote-empty），重启不自动连", async () => {
    const storage = new MemStorage();
    const s1 = createLauncherStore({ storage, ...baseDeps() });
    s1.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    const out = await s1.connectRemote("aaaa");
    // 在线纯选路允许空 token：界面随即展示远端自己的登录页
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBeNull();
    expect(storage.getItem(`${REMOTE_SESSION_KEY_PREFIX}:aaaa`)).toBeNull();
    // 重启：restore 刻意 fail-closed，无会话不自动连远端
    const s2 = createLauncherStore({ storage, ...baseDeps() });
    expect(s2.getActive()).toBeNull();
  });

  it("deauthenticateRemote：清会话并 emit，但不 persist 注册表、不 syncUpstream，活动仍指该远端", async () => {
    const storage = new MemStorage();
    const syncUpstream = vi.fn(async () => {});
    const s1 = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: {
        ensureLocalReady: vi.fn(async () => {}),
        syncUpstream,
        stopLocal: vi.fn(async () => {}),
        startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
        stopLocalOnly: vi.fn(async () => {}),
        startReplica: vi.fn(async () => ({
          ok: true as const,
          kernelPort: 41000,
          initialized: true,
          nodeId: "office-1",
        })),
        stopReplica: vi.fn(async () => {}),
        replicaStatus: vi.fn(async () => ({
          added: true,
          initialized: true,
          running: true,
          ready: true,
          kernelPort: 41000,
        })),
      },
    });
    s1.addRemote({ nodeId: "aaaa", baseURL: "http://nas:3001" });
    s1.commitRemoteSession("aaaa", "jwt", null);
    await s1.connectRemote("aaaa");
    const syncCallsAfterConnect = syncUpstream.mock.calls.length;
    expect(s1.getActive()?.token).toBe("jwt");

    let emits = 0;
    const unsub = s1.subscribe(() => {
      emits += 1;
    });
    const regBefore = storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY);
    const out = await s1.deauthenticateRemote("aaaa");
    unsub();

    // 保持选路态：活动仍是该远端、token 清空；会话分键被删
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBeNull();
    expect(s1.getState().activeNodeId).toBe("aaaa");
    expect(storage.getItem(`${REMOTE_SESSION_KEY_PREFIX}:aaaa`)).toBeNull();
    // 注册表形状不变（不 persist）、emit 一次、壳上游不重切
    expect(storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY)).toBe(regBefore);
    expect(emits).toBe(1);
    expect(syncUpstream.mock.calls.length).toBe(syncCallsAfterConnect);
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

describe("第三入口 2b：副本壳编排 addReplica / connectReplica", () => {
  const REMOTE_URL = "http://nas:3001";
  const SECRET = "secret-remote-token-9f3a";

  function allStorage(storage: MemStorage): string {
    return [...storage.m.values()].join("\n");
  }

  it("addReplica：入册并持久化，但不自动激活、不拉任何进程、令牌永不落盘", () => {
    const storage = new MemStorage();
    const startReplica = vi.fn();
    const store = createLauncherStore({ storage, ...baseDeps(), shell: fakeShell({ startReplica }) });
    store.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL });
    const e = store.controller.getNode("office-1");
    expect(e?.role).toBe("replica");
    expect(e?.replica?.remoteBaseUrl).toBe(REMOTE_URL);
    // 不自动激活：活动源为空；且没有触达任何壳拉起命令。
    expect(store.getActive()).toBeNull();
    expect(store.getState().activeNodeId).toBeNull();
    expect(startReplica).not.toHaveBeenCalled();
  });

  it("connectReplica 成功：startReplica 以 remoteToken 调一次 → connectNodeById 激活副本；零 syncUpstream/stop", async () => {
    const storage = new MemStorage();
    const startReplica = vi.fn(async (_arg: StartReplicaArg) => ({
      ok: true as const,
      kernelPort: 41000,
      initialized: true,
      nodeId: "office-1",
    }));
    const syncUpstream = vi.fn(async () => {});
    const stopLocal = vi.fn(async () => {});
    const stopReplica = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ startReplica, syncUpstream, stopLocal, stopReplica }),
    });
    store.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL, clientId: "cid-7", syncIntervalMs: 5000 });

    const out = await store.connectReplica("office-1", SECRET);

    // startReplica 恰好一次，入参带规范化 origin / nodeId / 本次令牌 / 绑定里实际存在的两可选键。
    expect(startReplica).toHaveBeenCalledOnce();
    const arg = startReplica.mock.calls[0][0];
    expect(arg).toMatchObject({
      remoteBaseUrl: REMOTE_URL,
      nodeId: "office-1",
      remoteToken: SECRET,
      clientId: "cid-7",
      syncIntervalMs: 5000,
    });
    // Rust 已自置 Upstream::Replica：web 侧只纯选路激活，绝不 syncUpstream、不停任何内核。
    expect(syncUpstream).not.toHaveBeenCalled();
    expect(stopLocal).not.toHaveBeenCalled();
    expect(stopReplica).not.toHaveBeenCalled();
    // 活动源是副本（kind=local、nodeId=副本名、无分键会话时空令牌，绝不串主库 gx-auth）。
    expect(out.active?.nodeId).toBe("office-1");
    expect(out.active?.kind).toBe("local");
    expect(out.active?.token).toBeNull();
    expect(store.getActive()?.nodeId).toBe("office-1");
    expect(store.getState().activeNodeId).toBe("office-1");
    // 命门：remoteToken 绝不进任何 storage 键值（注册表/会话/log/state 全部扫描）。
    expect(allStorage(storage)).not.toContain(SECRET);
    expect(allStorage(storage)).not.toContain("remoteToken");
  });

  it("connectReplica：clientId/syncIntervalMs 缺省时不透传这两个键（只透传实际存在的键）", async () => {
    const storage = new MemStorage();
    const startReplica = vi.fn(async (_arg: StartReplicaArg) => ({
      ok: true as const,
      kernelPort: 41000,
      initialized: true,
      nodeId: "office-1",
    }));
    const store = createLauncherStore({ storage, ...baseDeps(), shell: fakeShell({ startReplica }) });
    store.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL });
    await store.connectReplica("office-1", SECRET);
    const arg = startReplica.mock.calls[0][0];
    expect(arg.remoteBaseUrl).toBe(REMOTE_URL);
    expect(arg.nodeId).toBe("office-1");
    expect(arg.remoteToken).toBe(SECRET);
    expect(arg).not.toHaveProperty("clientId");
    expect(arg).not.toHaveProperty("syncIntervalMs");
  });

  it("start_replica {ok:false}：中文 throw、不切 active、不 persist running、不 emit、零 syncUpstream/stop", async () => {
    const storage = new MemStorage();
    const startReplica = vi.fn(async () => ({ ok: false as const, error: "本机主库正在运行，互斥拒绝" }));
    const syncUpstream = vi.fn(async () => {});
    const stopReplica = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ startReplica, syncUpstream, stopReplica }),
    });
    store.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL });
    const regBefore = storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY);
    let emits = 0;
    const unsub = store.subscribe(() => {
      emits += 1;
    });

    await expect(store.connectReplica("office-1", SECRET)).rejects.toThrow("本机主库正在运行");
    unsub();

    // 失败原子性：活动指针不切、注册表不写 running（落盘内容与 addReplica 后逐字节一致）、不 emit。
    expect(store.getActive()).toBeNull();
    expect(store.getState().activeNodeId).toBeNull();
    expect(storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY)).toBe(regBefore);
    expect(emits).toBe(0);
    expect(syncUpstream).not.toHaveBeenCalled();
    expect(stopReplica).not.toHaveBeenCalled();
    // 失败也不留令牌痕迹。
    expect(allStorage(storage)).not.toContain(SECRET);
  });

  it("非副本 nodeId / 非壳环境：connectReplica 中文 throw 且不触达 startReplica", async () => {
    // 非壳（无 shell）：即使条目是副本也 fail-closed。
    const storage1 = new MemStorage();
    const s1 = createLauncherStore({ storage: storage1, ...baseDeps() });
    s1.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL });
    await expect(s1.connectReplica("office-1", SECRET)).rejects.toThrow(/不支持连接离线副本|副本/);

    // 壳环境但 nodeId 不存在 / 是主库：throw 且不拉进程。
    const startReplica = vi.fn();
    const storage2 = new MemStorage();
    const s2 = createLauncherStore({ storage: storage2, ...baseDeps(), shell: fakeShell({ startReplica }) });
    await s2.connectLocal();
    await expect(s2.connectReplica("nope", SECRET)).rejects.toThrow(/不存在|不是离线副本/);
    await expect(s2.connectReplica("local", SECRET)).rejects.toThrow(/不存在|不是离线副本/);
    expect(startReplica).not.toHaveBeenCalled();
  });
});

describe("第三入口 2b：disconnect 按 isPrimaryEntry/isReplicaEntry 三分", () => {
  const REMOTE_URL = "http://nas:3001";

  it("断开副本：调 stopReplica、不调 stopLocal，随后统一 syncUpstream(null,null)", async () => {
    const storage = new MemStorage();
    const stopLocal = vi.fn(async () => {});
    const stopReplica = vi.fn(async () => {});
    const syncUpstream = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ stopLocal, stopReplica, syncUpstream }),
    });
    store.addReplica({ nodeId: "office-1", remoteBaseUrl: REMOTE_URL });
    await store.connectReplica("office-1", "tok");
    expect(store.getActive()?.nodeId).toBe("office-1");

    const out = await store.disconnect("office-1");

    expect(stopReplica).toHaveBeenCalledOnce();
    expect(stopLocal).not.toHaveBeenCalled();
    expect(syncUpstream).toHaveBeenCalledOnce();
    expect(syncUpstream).toHaveBeenCalledWith(null, null);
    expect(out.active).toBeNull();
    expect(store.getState().activeNodeId).toBeNull();
  });

  it("断开主库：调 stopLocal、不调 stopReplica，随后 syncUpstream(null,null)", async () => {
    const storage = new MemStorage();
    const stopLocal = vi.fn(async () => {});
    const stopReplica = vi.fn(async () => {});
    const syncUpstream = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ stopLocal, stopReplica, syncUpstream }),
    });
    await store.connectLocal();
    await store.disconnect("local");
    expect(stopLocal).toHaveBeenCalledOnce();
    expect(stopReplica).not.toHaveBeenCalled();
    expect(syncUpstream).toHaveBeenCalledWith(null, null);
  });

  it("断开远端：不停任何内核，仅 syncUpstream(null,null)", async () => {
    const storage = new MemStorage();
    const stopLocal = vi.fn(async () => {});
    const stopReplica = vi.fn(async () => {});
    const syncUpstream = vi.fn(async () => {});
    const store = createLauncherStore({
      storage,
      ...baseDeps(),
      shell: fakeShell({ stopLocal, stopReplica, syncUpstream }),
    });
    store.addRemote({ nodeId: "aaaa", baseURL: REMOTE_URL });
    await store.connectRemote("aaaa");
    await store.disconnect("aaaa");
    expect(stopLocal).not.toHaveBeenCalled();
    expect(stopReplica).not.toHaveBeenCalled();
    expect(syncUpstream).toHaveBeenCalledWith(null, null);
  });
});

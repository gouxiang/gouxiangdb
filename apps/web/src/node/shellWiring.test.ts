// launcherStore 壳模式编排单测（纯 node + 内存 storage + fake 壳命令/登录）。
// 锁 W1 §4 line 147/149 的副作用时机，不触达真实 window/Tauri（shell hooks 全部注入）：
//   - connectLocal：先 ensureLocalReady（start_local 等 ready）→ 同源化切源 → syncUpstream(local) → emit；
//     ready 失败则 throw 且注册表/数据源/通知全不变；
//   - connectRemote：登录换 JWT 后同源化切源 → syncUpstream(remote, target=真实基址) → emit；
//   - disconnect 本地：stopLocal + syncUpstream(none)；断开远端：不 stopLocal、仅 none。
import { describe, it, expect, vi } from "vitest";
import { createLauncherStore, type ShellStoreHooks } from "./launcherStore";
import { createDataSourceResolver } from "./datasource";
import { deriveShellActiveDataSource } from "./shellRouting";
import { LOCAL_NODE_ID } from "./resolve";
import type { KvStorage } from "./remoteSessions";
import type { StoredNodeEntry } from "./registry";
import type { NodeHandshake } from "./handshake";

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

const ORIGIN = "http://127.0.0.1:7788";

interface Wiring {
  store: ReturnType<typeof createLauncherStore>;
  resolver: ReturnType<typeof createDataSourceResolver>;
  shell: Required<ShellStoreHooks> & {
    ensureLocalReady: ReturnType<typeof vi.fn>;
    stopLocal: ReturnType<typeof vi.fn>;
  };
  syncCalls: { activeNodeId: string | null; activeKind: string | null; entryURL: string | null }[];
  emitsDuringSync: number[];
  emitsAtSyncEnd: number[];
  totalEmits: () => number;
  login: ReturnType<typeof vi.fn>;
}

function makeWiring(): Wiring {
  const storage = new MemStorage();
  const resolver = createDataSourceResolver({
    getLocalBase: () => "",
    getOrigin: () => ORIGIN,
    getLocalToken: () => "local-jwt",
  });
  const syncCalls: Wiring["syncCalls"] = [];
  const emitsDuringSync: number[] = [];
  const emitsAtSyncEnd: number[] = [];
  let emitCount = 0;

  const ensureLocalReady = vi.fn(async () => undefined);
  const stopLocal = vi.fn(async () => undefined);
  const login = vi.fn(async () => ({ token: "remote-jwt", user: null }));

  const shell: ShellStoreHooks = {
    ensureLocalReady,
    stopLocal,
    startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
    stopLocalOnly: vi.fn(async () => undefined),
    startReplica: vi.fn(async () => ({
      ok: true as const,
      kernelPort: 41000,
      initialized: true,
      nodeId: "office-1",
    })),
    stopReplica: vi.fn(async () => undefined),
    replicaStatus: vi.fn(async () => ({
      added: true,
      initialized: true,
      running: true,
      ready: true,
      kernelPort: 41000,
    })),
    syncUpstream: vi.fn(async (active, entry: StoredNodeEntry | null) => {
      // emit 必须发生在壳上游切换期间之外：进入 sync 时记录通知数，体内不应新增。
      const atEntry = emitCount;
      emitsDuringSync.push(atEntry);
      syncCalls.push({
        activeNodeId: active?.nodeId ?? null,
        activeKind: active?.kind ?? null,
        entryURL: entry?.baseURL ?? null,
      });
      // 让出一微任务后计数仍应不变（store 是 await 之后才 emit）。
      await Promise.resolve();
      emitsAtSyncEnd.push(emitCount);
      expect(emitCount).toBe(atEntry);
    }),
  };

  const store = createLauncherStore({
    storage,
    resolver,
    getLocalBase: () => "",
    getOrigin: () => ORIGIN,
    getLocalToken: () => "local-jwt",
    loginRemote: login,
    deriveDs: (entry, token) => deriveShellActiveDataSource(entry, token, () => ORIGIN),
    probeHandshake:
      () =>
      async (): Promise<NodeHandshake> => ({
        version: "0.2.5",
        initialized: true,
        signupOpen: false,
        meta: null,
      }),
    shell,
  });
  store.subscribe(() => {
    emitCount += 1;
  });

  return {
    store,
    resolver,
    shell: shell as Wiring["shell"],
    syncCalls,
    emitsDuringSync,
    emitsAtSyncEnd,
    totalEmits: () => emitCount,
    login,
  };
}

describe("壳模式 connectLocal 编排", () => {
  it("成功：start_local 先于切源，随后 set_upstream(local)，数据源同源化，emit 在最后", async () => {
    const w = makeWiring();
    const order: string[] = [];
    w.shell.ensureLocalReady.mockImplementation(async () => {
      order.push("ready");
      // ready 期间注册表/数据源尚未切换。
      expect(w.store.getState().activeNodeId).toBeNull();
      expect(w.resolver.current().nodeId).toBe(LOCAL_NODE_ID); // buildLocal 兜底（同源）
    });

    const out = await w.store.connectLocal();
    order.push("returned");

    expect(order).toEqual(["ready", "returned"]);
    expect(out.active?.kind).toBe("local");
    // 同源化：baseURL 恒 ""、wsOrigin 回落壳口、身份与 token 保留。
    expect(out.active?.baseURL).toBe("");
    expect(out.active?.nodeId).toBe(LOCAL_NODE_ID);
    expect(out.active?.token).toBe("local-jwt");
    expect(out.active?.wsOrigin).toBe("ws://127.0.0.1:7788");
    expect(w.resolver.current().baseURL).toBe("");
    // 壳上游被置 local（无 target）。
    expect(w.syncCalls).toEqual([
      { activeNodeId: LOCAL_NODE_ID, activeKind: "local", entryURL: "" },
    ]);
    // syncUpstream 进入/体内订阅者都尚未因本次连接被通知；整体 resolve 后才通知 1 次。
    expect(w.emitsDuringSync).toEqual([0]);
    expect(w.emitsAtSyncEnd).toEqual([0]);
    expect(w.totalEmits()).toBe(1);
  });
  it("start_local 返回失败：throw 中文错误，注册表/数据源/壳上游/通知全部不变", async () => {
    const w = makeWiring();
    w.shell.ensureLocalReady.mockRejectedValue(new Error("内核启动失败：端口占用"));
    let notified = 0;
    const unsub = w.store.subscribe(() => {
      notified += 1;
    });

    await expect(w.store.connectLocal()).rejects.toThrow("内核启动失败：端口占用");
    expect(w.store.getState().activeNodeId).toBeNull();
    expect(w.store.getState().entries.some((e) => e.kind === "local")).toBe(false);
    expect(w.syncCalls).toEqual([]); // 绝未把壳上游切到一个没起来的本地
    expect(notified).toBe(0);
    unsub();
  });
});

describe("壳模式 connectRemote / disconnect 编排", () => {
  it("纯选路连远端（无会话）：不登录，同源化切源 token=null，syncUpstream 收到 remote + 注册表保存的真实绝对 target", async () => {
    const w = makeWiring();
    w.store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    const out = await w.store.connectRemote("abc123def456", {
      email: "a@b.c",
      password: "pw",
    });

    // 「连接＝只选路」：凭据被忽略，绝不发登录请求
    expect(w.login).not.toHaveBeenCalled();
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.nodeId).toBe("abc123def456");
    // 真实远端地址绝不进入活动数据源（只经壳代理），但作为壳上游 target 传递。
    expect(out.active?.baseURL).toBe("");
    // remote-empty：无记住会话时活动数据源 token=null，界面随即展示该远端自己的登录页
    expect(out.active?.token).toBeNull();
    expect(w.syncCalls).toEqual([
      { activeNodeId: "abc123def456", activeKind: "remote", entryURL: "http://nas:3001" },
    ]);
    // 进入 sync 前 addRemote 已通知 1 次；sync 体内不再新增，resolve 后本次连接再通知 1 次（共 2）。
    expect(w.emitsDuringSync).toEqual([1]);
    expect(w.emitsAtSyncEnd).toEqual([1]);
    expect(w.totalEmits()).toBe(2);
    expect(w.resolver.current().baseURL).toBe("");
    // remote-empty 请求不带 X-GX-Token（登录页本身是匿名可达的）。
    expect(w.resolver.headers()["X-GX-Token"]).toBeUndefined();
  });

  it("已记住会话的远端：纯选路同源化切源直接带 JWT，不登录；补 token 不重切壳上游", async () => {
    const w = makeWiring();
    w.store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    // 远端自己登录页提交成功后，由 activeAuth → store.commitRemoteSession 记住会话
    w.store.commitRemoteSession("abc123def456", "remote-jwt", null);
    const out = await w.store.connectRemote("abc123def456");

    expect(w.login).not.toHaveBeenCalled();
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBe("remote-jwt");
    expect(w.resolver.headers()["X-GX-Token"]).toBe("remote-jwt");
    expect(w.syncCalls).toEqual([
      { activeNodeId: "abc123def456", activeKind: "remote", entryURL: "http://nas:3001" },
    ]);

    // 同节点再次 commit（如改密后 me 刷新）只重推数据源、不 syncUpstream（上游目标未变）。
    const syncCount = w.syncCalls.length;
    w.store.commitRemoteSession("abc123def456", "remote-jwt-2", null);
    expect(w.syncCalls.length).toBe(syncCount);
    expect(w.resolver.headers()["X-GX-Token"]).toBe("remote-jwt-2");
  });

  it("断开远端：清会话/活动回落，syncUpstream(none)，但不停本地内核", async () => {
    const w = makeWiring();
    w.store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    await w.store.connectRemote("abc123def456", { email: "a@b.c", password: "pw" });
    w.syncCalls.length = 0;
    w.emitsDuringSync.length = 0;
    w.emitsAtSyncEnd.length = 0;

    const out = await w.store.disconnect("abc123def456");
    expect(out.active).toBeNull();
    expect(w.store.getState().activeNodeId).toBeNull();
    expect(w.shell.stopLocal).not.toHaveBeenCalled();
    expect(w.syncCalls).toEqual([{ activeNodeId: null, activeKind: null, entryURL: null }]);
    expect(w.emitsDuringSync).toEqual(w.emitsAtSyncEnd); // sync 体内无新增通知
  });

  it("断开本地：先优雅停本地内核，再 syncUpstream(none)，desired=stopped、条目保留", async () => {
    const w = makeWiring();
    await w.store.connectLocal();
    w.syncCalls.length = 0;
    const order: string[] = [];
    w.shell.stopLocal.mockImplementation(async () => {
      order.push("stopped");
    });

    const out = await w.store.disconnect(LOCAL_NODE_ID);
    order.push("returned");
    expect(out.active).toBeNull();
    expect(w.store.getState().localDesired).toBe("stopped");
    expect(w.store.getState().entries.some((e) => e.kind === "local")).toBe(true);
    expect(order).toEqual(["stopped", "returned"]);
    expect(w.syncCalls).toEqual([{ activeNodeId: null, activeKind: null, entryURL: null }]);
  });
});

describe("壳本机登录态刷新（先连本机、后登录）", () => {
  it("connectLocal 当拍令牌为 null，登录令牌到位经 watch 回调后活动数据源带最新 X-GX-Token", async () => {
    // 复刻真机：连本机时尚未登录（getLocalToken=null），随后登录成功令牌到位。
    const storage = new MemStorage();
    let currentLocalToken: string | null = null;
    const resolver = createDataSourceResolver({
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => currentLocalToken,
    });
    const tokenListeners = new Set<() => void>();

    const store = createLauncherStore({
      storage,
      resolver,
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => currentLocalToken,
      deriveDs: (entry, token) => deriveShellActiveDataSource(entry, token, () => ORIGIN),
      shell: {
        ensureLocalReady: vi.fn(async () => undefined),
        stopLocal: vi.fn(async () => undefined),
        startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
        stopLocalOnly: vi.fn(async () => undefined),
        startReplica: vi.fn(async () => ({
          ok: true as const,
          kernelPort: 41000,
          initialized: true,
          nodeId: "office-1",
        })),
        stopReplica: vi.fn(async () => undefined),
        replicaStatus: vi.fn(async () => ({
          added: true,
          initialized: true,
          running: true,
          ready: true,
          kernelPort: 41000,
        })),
        syncUpstream: vi.fn(async () => undefined),
      },
      watchLocalToken: (onChange) => {
        tokenListeners.add(onChange);
        return () => tokenListeners.delete(onChange);
      },
    });

    await store.connectLocal();
    // 连本机当拍未登录：冻结快照令牌为空、无头。
    expect(resolver.current().kind).toBe("local");
    expect(resolver.current().token).toBeNull();
    expect(resolver.headers()["X-GX-Token"]).toBeUndefined();

    // 登录/注册成功：gx-auth 令牌到位并通知订阅者（不经过任何连接/上游切换）。
    currentLocalToken = "fresh-login-jwt";
    tokenListeners.forEach((fn) => fn());

    // 活动数据源已被刷新为最新令牌（nodeId 仍 local、同源 baseURL 不变）。
    expect(resolver.current().nodeId).toBe(LOCAL_NODE_ID);
    expect(resolver.current().baseURL).toBe("");
    expect(resolver.current().token).toBe("fresh-login-jwt");
    expect(resolver.headers()["X-GX-Token"]).toBe("fresh-login-jwt");
  });

  it("当前活动是远端节点时，本机令牌变化不影响远端数据源", async () => {
    const storage = new MemStorage();
    const resolver = createDataSourceResolver({
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => "local-jwt",
    });
    const tokenListeners = new Set<() => void>();
    const store = createLauncherStore({
      storage,
      resolver,
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => "local-jwt",
      loginRemote: vi.fn(async () => ({ token: "remote-jwt", user: null })),
      deriveDs: (entry, token) => deriveShellActiveDataSource(entry, token, () => ORIGIN),
      shell: {
        ensureLocalReady: vi.fn(async () => undefined),
        stopLocal: vi.fn(async () => undefined),
        startLocalOnly: vi.fn(async () => ({ firstBoot: false })),
        stopLocalOnly: vi.fn(async () => undefined),
        startReplica: vi.fn(async () => ({
          ok: true as const,
          kernelPort: 41000,
          initialized: true,
          nodeId: "office-1",
        })),
        stopReplica: vi.fn(async () => undefined),
        replicaStatus: vi.fn(async () => ({
          added: true,
          initialized: true,
          running: true,
          ready: true,
          kernelPort: 41000,
        })),
        syncUpstream: vi.fn(async () => undefined),
      },
      watchLocalToken: (onChange) => {
        tokenListeners.add(onChange);
        return () => tokenListeners.delete(onChange);
      },
    });

    store.addRemote({ nodeId: "abc123def456", baseURL: "http://nas:3001" });
    // 纯选路 + commit 记住远端会话（不再经登录动作）
    store.commitRemoteSession("abc123def456", "remote-jwt", null);
    await store.connectRemote("abc123def456");
    expect(resolver.current().kind).toBe("remote");
    expect(resolver.headers()["X-GX-Token"]).toBe("remote-jwt");

    // 本机 gx-auth 令牌变化（不应被 refreshActiveLocal 触碰远端数据源）。
    tokenListeners.forEach((fn) => fn());
    expect(resolver.current().kind).toBe("remote");
    expect(resolver.headers()["X-GX-Token"]).toBe("remote-jwt");
  });
});

describe("壳装配暴露 probe 握手工厂", () => {
  it("store.addHandshake 为可调用工厂（表单据此走 probe 同源握手），非壳 store 为 undefined", () => {
    const shell = makeWiring();
    expect(typeof shell.store.addHandshake).toBe("function");

    const storage = new MemStorage();
    const plain = createLauncherStore({
      storage,
      getLocalBase: () => "",
      getOrigin: () => ORIGIN,
      getLocalToken: () => null,
    });
    expect(plain.addHandshake).toBeUndefined();
  });
});

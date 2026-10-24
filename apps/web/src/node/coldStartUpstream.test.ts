// 冷启动壳上游补切（restoreReady）单测（纯 node + 内存 storage + 注入壳钩子）。
//
// 背景缺口：Rust 壳进程代理上游恒从 Upstream::None 启动且不跨进程持久化，只有
// gx:set_active_upstream 会改它。createLauncherStore 构造即 controller.restore() 把 web 侧
// resolver 指回上次活动节点，因此「App 冷启动 + 上次活动是已登录远端」时，必须在构造期把壳
// 代理也补切到该远端，否则首个 /api 请求打到 None → 503（记住节点下次直进在重启后失效）。
// 本文件锁这一构造期编排：
//   1. 壳 + 恢复出活动远端（有会话）→ 构造即 syncUpstream(remote) 恰好 1 次，restoreReady 可 await；
//   2. 壳 + 恢复出活动本机 → 绝不 syncUpstream local（冷启动内核未必在跑，维持点「进入本机」才拉）；
//   3. 非壳（无 shell）→ restoreReady 已 resolve、没有任何壳调用面（门控关/浏览器零变化）；
//   4. 壳 + 注册表活动指向远端但该节点无会话分键 → restore fail-closed 回落 active=null，
//      不 syncUpstream（冷启动应回启动器，不把壳上游指向一个必然要重登的远端）。
import { describe, it, expect, vi } from "vitest";
import { createLauncherStore, type ShellStoreHooks } from "./launcherStore";
import { createDataSourceResolver } from "./datasource";
import { deriveShellActiveDataSource } from "./shellRouting";
import { LOCAL_NODE_ID } from "./resolve";
import {
  LAUNCHER_REGISTRY_STORAGE_KEY,
  serializeRegistry,
  type NodeRegistryState,
  type StoredNodeEntry,
} from "./registry";
import { writeRemoteSession, type KvStorage } from "./remoteSessions";

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
const NODE_ID = "abc123def456";
const REMOTE_URL = "http://nas:3001";

const remoteEntry: StoredNodeEntry = {
  kind: "remote",
  nodeId: NODE_ID,
  baseURL: REMOTE_URL,
  label: "公司库",
  lastConnectedAt: "2026-10-18T10:00:00.000Z",
};
const localEntry: StoredNodeEntry = {
  kind: "local",
  nodeId: LOCAL_NODE_ID,
  baseURL: "",
  label: "本机",
  lastConnectedAt: "2026-10-18T10:00:00.000Z",
};
const replicaEntry: StoredNodeEntry = {
  kind: "local",
  role: "replica",
  nodeId: "office-1",
  baseURL: "",
  label: "办公室副本",
  lastConnectedAt: "2026-10-18T10:00:00.000Z",
  replica: { remoteBaseUrl: REMOTE_URL, clientId: null, syncIntervalMs: null },
};

function registryWith(
  entries: StoredNodeEntry[],
  activeNodeId: string | null,
): NodeRegistryState {
  return { version: 1, entries, activeNodeId, localDesired: "running" };
}

/** 构造一套壳钩子；syncUpstream 默认成功 resolve，用例可改其实现模拟失败。 */
function makeShell() {
  const ensureLocalReady = vi.fn(async () => undefined);
  const stopLocal = vi.fn(async () => undefined);
  const startLocalOnly = vi.fn(async () => ({ firstBoot: false }));
  const stopLocalOnly = vi.fn(async () => undefined);
  const startReplica = vi.fn(async () => ({
    ok: true as const,
    kernelPort: 41000,
    initialized: true,
    nodeId: "office-1",
  }));
  const stopReplica = vi.fn(async () => undefined);
  const replicaStatus = vi.fn(async () => ({
    added: true,
    initialized: true,
    running: true,
    ready: true,
    kernelPort: 41000,
  }));
  const syncUpstream = vi.fn(
    async (_active: unknown, _entry: StoredNodeEntry | null) => undefined,
  );
  const shell: ShellStoreHooks = {
    ensureLocalReady,
    stopLocal,
    startLocalOnly,
    stopLocalOnly,
    startReplica,
    stopReplica,
    replicaStatus,
    syncUpstream,
  };
  return {
    shell,
    syncUpstream,
    /** 其余壳命令面（用于断言构造期一律不被触碰）。 */
    otherCalls: {
      ensureLocalReady,
      stopLocal,
      startLocalOnly,
      stopLocalOnly,
      startReplica,
      stopReplica,
      replicaStatus,
    },
  };
}

function buildStore(storage: KvStorage, shell?: ShellStoreHooks) {
  const resolver = createDataSourceResolver({
    getLocalBase: () => "",
    getOrigin: () => ORIGIN,
    getLocalToken: () => null,
  });
  return createLauncherStore({
    storage,
    resolver,
    getLocalBase: () => "",
    getOrigin: () => ORIGIN,
    getLocalToken: () => null,
    deriveDs: (entry, token) => deriveShellActiveDataSource(entry, token, () => ORIGIN),
    ...(shell ? { shell } : {}),
  });
}

describe("冷启动：壳代理上游补切到恢复出的活动远端", () => {
  it("壳 + 上次活动是已登录远端：构造即 syncUpstream(remote) 恰好 1 次，restoreReady 可 await", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      serializeRegistry(registryWith([remoteEntry], NODE_ID)),
    );
    // 该远端已记住会话（restore 据此重推带 JWT 的 remote 数据源，守卫才会直进业务壳）
    writeRemoteSession(storage, {
      nodeId: NODE_ID,
      token: "remembered-jwt",
      user: null,
    });
    const { shell, syncUpstream } = makeShell();

    const store = buildStore(storage, shell); // 构造期内即发起补切

    expect(syncUpstream).toHaveBeenCalledTimes(1);
    const [active, entry] = syncUpstream.mock.calls[0];
    expect(active).not.toBeNull();
    expect((active as { kind: string }).kind).toBe("remote");
    expect((active as { nodeId: string }).nodeId).toBe(NODE_ID);
    expect(entry).not.toBeNull();
    expect((entry as StoredNodeEntry).kind).toBe("remote");
    expect((entry as StoredNodeEntry).baseURL).toBe(REMOTE_URL);
    // 壳目标必须是注册表保存的真实远端地址（syncUpstream 内部据此 set_upstream remote target）
    await expect(store.restoreReady).resolves.toBeUndefined();
  });

  it("壳 + 上次活动是本机：构造不 syncUpstream（内核冷启动未必在跑），restoreReady 仍 resolve", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      serializeRegistry(registryWith([localEntry], LOCAL_NODE_ID)),
    );
    const { shell, syncUpstream, otherCalls } = makeShell();

    const store = buildStore(storage, shell);

    expect(syncUpstream).not.toHaveBeenCalled();
    // 构造期也绝不能顺手 start_local（保持由用户点「进入本机」触发的现状）
    expect(otherCalls.ensureLocalReady).not.toHaveBeenCalled();
    expect(otherCalls.startLocalOnly).not.toHaveBeenCalled();
    await expect(store.restoreReady).resolves.toBeUndefined();
  });

  it("非壳（无 shell，门控关/浏览器）：restoreReady 已 resolve，且没有任何壳调用面", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      serializeRegistry(registryWith([remoteEntry], NODE_ID)),
    );
    writeRemoteSession(storage, { nodeId: NODE_ID, token: "jwt", user: null });

    const store = buildStore(storage); // 不传 shell

    expect(store.shellBound).toBe(false);
    // 非壳恒为已 resolve 的承诺；即使注册表活动是远端也不发起任何 invoke
    await expect(store.restoreReady).resolves.toBeUndefined();
  });

  it("壳 + 活动指向远端但无会话分键：restore 回落 active=null，不 syncUpstream，restoreReady resolve", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      // 活动节点是远端，但下面不写 gx-node-session 分键（已登出/未记住）
      serializeRegistry(registryWith([remoteEntry], NODE_ID)),
    );
    const { shell, syncUpstream } = makeShell();

    const store = buildStore(storage, shell);

    expect(syncUpstream).not.toHaveBeenCalled();
    // 恢复路径 fail-closed：无会话不自动激活远端，活动源回落 null（界面回启动器）
    expect(store.getActive()).toBeNull();
    await expect(store.restoreReady).resolves.toBeUndefined();
  });

  it("壳 + 上次活动是离线副本：activeNodeId 归一化 null 并 persist，零任何壳调用，条目保留", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      // 主库 + 副本，active 指向副本（模拟上次退出停在副本）。
      serializeRegistry(registryWith([localEntry, replicaEntry], "office-1")),
    );
    // 即使副本恰好有自己的分键会话，冷启动也绝不自动连入（remoteToken/上游不跨重启）。
    writeRemoteSession(storage, { nodeId: "office-1", token: "rep-jwt", user: null });
    const { shell, syncUpstream, otherCalls } = makeShell();

    const store = buildStore(storage, shell);

    // 活动指针归一化为 null：resolver 无活动源，用户回启动器手动重连重输服务器令牌。
    expect(store.getActive()).toBeNull();
    expect(store.controller.getActiveNode()).toBeNull();
    expect(store.getState().activeNodeId).toBeNull();
    // 副本条目本身保留（仅清活动指针，不删档）。
    expect(store.controller.getNode("office-1")?.role).toBe("replica");
    // 构造末的去脏 persist 已把归一化结果落盘（再次 parse 仍为 null）。
    const persisted = JSON.parse(storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY) as string);
    expect(persisted.activeNodeId).toBeNull();
    // restoreReady 对副本零壳调用：绝不 start_replica，也不 syncUpstream/stop/start_local。
    await expect(store.restoreReady).resolves.toBeUndefined();
    expect(syncUpstream).not.toHaveBeenCalled();
    expect(otherCalls.startReplica).not.toHaveBeenCalled();
    expect(otherCalls.stopReplica).not.toHaveBeenCalled();
    expect(otherCalls.ensureLocalReady).not.toHaveBeenCalled();
    expect(otherCalls.startLocalOnly).not.toHaveBeenCalled();
    expect(otherCalls.stopLocal).not.toHaveBeenCalled();
    // 冷启动路径绝不落任何 remoteToken（storage 全键扫描）。
    const allValues = [...(storage as unknown as { m: Map<string, string> }).m.values()].join("\n");
    expect(allValues).not.toContain("remoteToken");
  });

  it("壳 + 活动远端补切失败（set_upstream reject）：不阻塞构造与首屏，restoreReady 仍 resolve（吞错）", async () => {
    const storage = new MemStorage();
    storage.setItem(
      LAUNCHER_REGISTRY_STORAGE_KEY,
      serializeRegistry(registryWith([remoteEntry], NODE_ID)),
    );
    writeRemoteSession(storage, { nodeId: NODE_ID, token: "jwt", user: null });
    const { shell, syncUpstream } = makeShell();
    syncUpstream.mockRejectedValueOnce(new Error("set_upstream failed"));

    const store = buildStore(storage, shell);

    expect(syncUpstream).toHaveBeenCalledTimes(1);
    // 失败被吞、承诺 settle（不向外抛），首屏不被卡死；用户随后点连接会再切一次
    await expect(store.restoreReady).resolves.toBeUndefined();
  });
});

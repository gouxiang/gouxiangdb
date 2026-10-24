// addReplicaFlow.ts 纯编排单测（node 环境，无 DOM/React/网络）。
//
// 切片 3a 纪律的回归锚点：本编排只「登记一个离线副本」——
//   - 不握手、不发网络请求、不连接壳（端口上即便存在 connectReplica 也绝不被调用）；
//   - 不收凭据：入参/出参/序列化结果都不得出现 token/password；
//   - 只调一次 addReplica，且入参严格只有 { nodeId, label, remoteBaseUrl } 三个键；
//   - fail-closed：非法网址 / 非白名单 nodeId（含中文）/ 重名 / 存储层竞态 throw，都不产生条目。
import { describe, it, expect, vi } from "vitest";
import {
  addReplicaFlow,
  defaultReplicaNodeId,
  type AddReplicaFlowInput,
  type AddReplicaStorePort,
} from "./addReplicaFlow";
import {
  addReplicaNode,
  emptyRegistry,
  type AddReplicaInput,
  type NodeRegistryState,
  type StoredNodeEntry,
} from "./registry";

const REMOTE_URL = "http://nas:3001";

const replicaEntry = (nodeId: string, remoteBaseUrl = REMOTE_URL): StoredNodeEntry => ({
  kind: "local",
  role: "replica",
  nodeId,
  baseURL: "",
  label: null,
  lastConnectedAt: null,
  replica: { remoteBaseUrl },
});

/**
 * 控制器面 fake：结构对齐 LauncherController.addReplica——成功返回新建 StoredNodeEntry、
 * 失败 throw 中文 Error。内核直接复用真 registry.addReplicaNode（纯函数），因此：
 *   - 成功条目是真实持久化形状（内部只存规范化裸 origin）；
 *   - 重名/非法名由真路径抛错，可忠实驱动编排器的竞态收口分支。
 * 全程无网络、无 React、无 storage。
 */
function fakeController(initial: StoredNodeEntry[] = []) {
  let state: NodeRegistryState = { ...emptyRegistry(), entries: [...initial] };
  const added: AddReplicaInput[] = [];
  const store: AddReplicaStorePort = {
    getState: () => state,
    addReplica(input: AddReplicaInput): StoredNodeEntry {
      added.push(input);
      const result = addReplicaNode(state, input);
      if (result.error) throw new Error(result.error.message);
      state = result.state;
      return state.entries[state.entries.length - 1]!;
    },
  };
  return {
    store,
    added,
    entries: () => state.entries,
  };
}

const run = (input: AddReplicaFlowInput, store: AddReplicaStorePort) =>
  addReplicaFlow(input, { store });

describe("defaultReplicaNodeId", () => {
  it("空占用集 → replica-1；按序号取首个空缺，不空跳号", () => {
    expect(defaultReplicaNodeId([])).toBe("replica-1");
    expect(defaultReplicaNodeId(["replica-1"])).toBe("replica-2");
    expect(defaultReplicaNodeId(["replica-1", "replica-2"])).toBe("replica-3");
    // replica-2 已占：1 可用仍应回填 replica-1（只找首个空缺，不简单 max+1）。
    expect(defaultReplicaNodeId(["replica-2"])).toBe("replica-1");
  });

  it("被远端 hex nodeId 占用不影响缺省副本编号（占用集只精确匹配 replica-N）", () => {
    expect(defaultReplicaNodeId(["replica-1", "a1b2c3d4e5f6", "deadbeef0123"])).toBe(
      "replica-2",
    );
  });

  it("接受整个注册表状态形态（主库 local + replica-1 → replica-2）", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [
        { kind: "local", nodeId: "local", baseURL: "", label: null, lastConnectedAt: null },
        replicaEntry("replica-1"),
      ],
    };
    expect(defaultReplicaNodeId(state)).toBe("replica-2");
  });
});

describe("addReplicaFlow 成功路径", () => {
  it("空注册表：缺省 nodeId=replica-1，只调一次 addReplica，入参严格三键", () => {
    const fc = fakeController();
    const result = run({ url: REMOTE_URL }, fc.store);

    expect(result.kind).toBe("added");
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.nodeId).toBe("replica-1");
    expect(result.label).toBeNull();
    expect(fc.added).toHaveLength(1);
    // 严格深等：fake 记录的就是 flow 实际下发的对象，多一个键都会让此断言失败。
    expect(fc.added[0]).toEqual({ nodeId: "replica-1", label: null, remoteBaseUrl: REMOTE_URL });
    expect(Object.keys(fc.added[0]!).sort()).toEqual(["label", "nodeId", "remoteBaseUrl"]);
  });

  it("缺省编号随占用递增（replica-1 已被副本占用 → replica-2）", () => {
    const fc = fakeController([replicaEntry("replica-1")]);
    const result = run({ url: REMOTE_URL }, fc.store);
    expect(result.kind).toBe("added");
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.nodeId).toBe("replica-2");
    expect(fc.entries().some((e) => e.nodeId === "replica-2")).toBe(true);
  });

  it("显示名 trim 后透传；纯空白/省略等价于不填（null）", () => {
    const named = fakeController();
    const r1 = run({ url: REMOTE_URL, label: "  办公室副本  " }, named.store);
    expect(r1.kind).toBe("added");
    if (r1.kind !== "added") throw new Error("expected added");
    expect(named.added[0]!.label).toBe("办公室副本");
    expect(r1.label).toBe("办公室副本");
    expect(r1.entry.label).toBe("办公室副本");

    const blank = fakeController();
    const r2 = run({ url: REMOTE_URL, label: "   " }, blank.store);
    expect(r2.kind).toBe("added");
    if (r2.kind !== "added") throw new Error("expected added");
    expect(blank.added[0]!.label).toBeNull();
    expect(r2.label).toBeNull();
  });

  it("用户误填子路径：传给存储层的是完整 baseURL，回显以存储条目裸 origin 为准（剥离子路径）", () => {
    const fc = fakeController();
    const result = run({ url: "http://nas:3001/app/gouxiangdb/" }, fc.store);
    expect(result.kind).toBe("added");
    if (result.kind !== "added") throw new Error("expected added");
    // 下发的是规范化 baseURL（去尾斜杠、保留子路径），由 registry 内部再剥成裸 origin。
    expect(fc.added[0]!.remoteBaseUrl).toBe("http://nas:3001/app/gouxiangdb");
    // 回显与持久化条目都是裸 origin（与 Rust upstream normalize_http_base 同口径）。
    expect(result.remoteBaseUrl).toBe("http://nas:3001");
    expect(result.entry.replica?.remoteBaseUrl).toBe("http://nas:3001");
  });

  it("成功结果序列化不含任何凭据字段（token/password），且条目本身无凭据键", () => {
    const fc = fakeController();
    const result = run({ url: REMOTE_URL, label: "副本" }, fc.store);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("password");
    if (result.kind !== "added") throw new Error("expected added");
    expect("token" in result.entry).toBe(false);
    expect("password" in result.entry).toBe(false);
  });

  it("绝不连接壳：即便端口对象上挂着 connectReplica，也一次都不调用", () => {
    const fc = fakeController();
    const connectReplica = vi.fn();
    const storeWithConnect = Object.assign(fc.store, { connectReplica });
    const result = run({ url: REMOTE_URL }, storeWithConnect);
    expect(result.kind).toBe("added");
    expect(connectReplica).not.toHaveBeenCalled();
  });

  it("显式合法 nodeId（白名单）被采纳并 trim", () => {
    const fc = fakeController();
    const result = run({ url: REMOTE_URL, nodeId: "  office-replica-01  " }, fc.store);
    expect(result.kind).toBe("added");
    if (result.kind !== "added") throw new Error("expected added");
    expect(result.nodeId).toBe("office-replica-01");
    expect(fc.added[0]!.nodeId).toBe("office-replica-01");
  });
});

describe("addReplicaFlow fail-closed", () => {
  it("非法网址（空串/含空格）→ invalid_url，addReplica 零调用", () => {
    for (const bad of ["", "   ", "http://bad host:3001", "not a url"]) {
      const fc = fakeController();
      const result = run({ url: bad }, fc.store);
      expect(result).toEqual({ kind: "error", error: { stage: "form", code: "invalid_url" } });
      expect(fc.added).toHaveLength(0);
      expect(fc.entries()).toHaveLength(0);
    }
  });

  it("显式中文 nodeId → label_invalid（白名单不收非 ASCII），addReplica 零调用", () => {
    const fc = fakeController();
    const result = run({ url: REMOTE_URL, nodeId: "办公室副本" }, fc.store);
    expect(result).toEqual({ kind: "error", error: { stage: "form", code: "label_invalid" } });
    expect(fc.added).toHaveLength(0);
  });

  it("保留名 local / 路径穿越名 → label_invalid，零调用", () => {
    for (const bad of ["local", ".", ".."]) {
      const fc = fakeController();
      const result = run({ url: REMOTE_URL, nodeId: bad }, fc.store);
      expect(result).toEqual({
        kind: "error",
        error: { stage: "form", code: "label_invalid" },
      });
      expect(fc.added).toHaveLength(0);
    }
  });

  it("nodeId 与任意已存条目（副本/远端/主库）重名 → duplicate，零调用", () => {
    // 撞已存副本
    const fc1 = fakeController([replicaEntry("replica-7")]);
    const r1 = run({ url: REMOTE_URL, nodeId: "replica-7" }, fc1.store);
    expect(r1).toEqual({ kind: "error", error: { stage: "form", code: "duplicate" } });
    expect(fc1.added).toHaveLength(0);

    // 撞远端 hex nodeId
    const remote: StoredNodeEntry = {
      kind: "remote",
      nodeId: "a1b2c3d4e5f6",
      baseURL: "http://remote:3001",
      label: null,
      lastConnectedAt: null,
    };
    const fc2 = fakeController([remote]);
    const r2 = run({ url: REMOTE_URL, nodeId: "a1b2c3d4e5f6" }, fc2.store);
    expect(r2).toEqual({ kind: "error", error: { stage: "form", code: "duplicate" } });
    expect(fc2.added).toHaveLength(0);
  });

  it("预检全过但存储层竞态 throw（REPLICA_PROFILE_EXISTS）→ 收口 duplicate，不上抛", () => {
    const throwingStore: AddReplicaStorePort = {
      getState: () => emptyRegistry(),
      addReplica: vi.fn(() => {
        throw new Error("同名副本节点已存在");
      }),
    };
    const result = run({ url: REMOTE_URL, nodeId: "replica-1" }, throwingStore);
    expect(result).toEqual({ kind: "error", error: { stage: "form", code: "duplicate" } });
    expect(throwingStore.addReplica).toHaveBeenCalledTimes(1);
  });

  it("任何失败都不切活动指针、不产生条目（注册表保持原状）", () => {
    const fc = fakeController([replicaEntry("replica-1")]);
    run({ url: REMOTE_URL, nodeId: "replica-1" }, fc.store); // duplicate
    expect(fc.entries()).toHaveLength(1);
    expect(fc.store.getState().activeNodeId).toBeNull(); // 编排只入册，从不切活动指针
  });
});

// registry.ts 测试（纯 node、无 jsdom、无新依赖）。
// 锁定启动器多节点模型（DESIGN-MACOS-APP.md §8.5）的全部不变量：
// 新装空册不启本地 / 本地唯一不可删不可重建 / 本地可停止但保留 / 远端可多可删 /
// 单活且断开后活动指针安全回落 / 持久化不含凭据 / parse 对脏数据强制收敛。

import { describe, it, expect } from "vitest";
import {
  emptyRegistry,
  addLocalNode,
  addRemoteNode,
  addReplicaNode,
  removeNode,
  connectNode,
  disconnectNode,
  renameNode,
  getEntry,
  hasLocal,
  localEntry,
  remoteEntries,
  replicaEntries,
  activeEntry,
  isValidReplicaNodeId,
  serializeRegistry,
  parseRegistry,
  type NodeRegistryState,
} from "./registry";
import { LOCAL_NODE_ID } from "./resolve";

const T1 = "2026-10-17T01:00:00.000Z";
const T2 = "2026-10-17T02:00:00.000Z";

function withLocal(): NodeRegistryState {
  return addLocalNode(emptyRegistry()).state;
}
function withRemote(state: NodeRegistryState, nodeId: string, baseURL: string): NodeRegistryState {
  return addRemoteNode(state, { nodeId, baseURL }).state;
}
function withReplica(state: NodeRegistryState, nodeId: string, remoteBaseUrl: string): NodeRegistryState {
  return addReplicaNode(state, { nodeId, remoteBaseUrl }).state;
}

describe("新装硬规则：空注册表不启动本地、无活动节点", () => {
  it("emptyRegistry 无任何条目、active=null、localDesired=null", () => {
    const s = emptyRegistry();
    expect(s.entries).toEqual([]);
    expect(s.activeNodeId).toBeNull();
    expect(s.localDesired).toBeNull();
    expect(hasLocal(s)).toBe(false);
    expect(activeEntry(s)).toBeNull();
  });
});

describe("本地节点唯一、不可删、不可重建", () => {
  it("添加本地：nodeId=local、baseURL 空、localDesired=running、不自动成为活动节点", () => {
    const r = addLocalNode(emptyRegistry());
    expect(r.error).toBeNull();
    const e = localEntry(r.state);
    expect(e?.nodeId).toBe(LOCAL_NODE_ID);
    expect(e?.kind).toBe("local");
    expect(e?.baseURL).toBe("");
    expect(r.state.localDesired).toBe("running");
    expect(r.state.activeNodeId).toBeNull(); // 添加≠连接
  });

  it("重复添加本地被拒 LOCAL_PROFILE_EXISTS 且状态不变", () => {
    const once = withLocal();
    const r2 = addLocalNode(once);
    expect(r2.error?.code).toBe("LOCAL_PROFILE_EXISTS");
    expect(r2.state).toBe(once); // 引用不变
    expect(once.entries.filter((e) => e.kind === "local")).toHaveLength(1);
  });

  it("本地节点不可删除 LOCAL_PROFILE_PERMANENT", () => {
    const s = withLocal();
    const r = removeNode(s, LOCAL_NODE_ID);
    expect(r.error?.code).toBe("LOCAL_PROFILE_PERMANENT");
    expect(r.state).toBe(s);
    expect(hasLocal(r.state)).toBe(true);
  });
});

describe("远端节点可多个、可删除", () => {
  it("可添加两个不同 nodeId 远端", () => {
    const s = withRemote(withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001"), "cccc2222dddd", "https://b.example");
    expect(remoteEntries(s)).toHaveLength(2);
    expect(s.entries).toHaveLength(3);
  });

  it("同 nodeId 重复添加被拒 REMOTE_PROFILE_EXISTS", () => {
    const s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    const dup = addRemoteNode(s, { nodeId: "aaaa1111bbbb", baseURL: "http://a:3001" });
    expect(dup.error?.code).toBe("REMOTE_PROFILE_EXISTS");
    expect(dup.state).toBe(s);
  });

  it("删除远端：条目消失；若删的是活动节点，活动态回落 null", () => {
    let s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    s = connectNode(s, "aaaa1111bbbb", T1).state;
    expect(activeEntry(s)?.nodeId).toBe("aaaa1111bbbb");
    const removed = removeNode(s, "aaaa1111bbbb");
    expect(removed.error).toBeNull();
    expect(getEntry(removed.state, "aaaa1111bbbb")).toBeNull();
    expect(removed.state.activeNodeId).toBeNull();
    expect(hasLocal(removed.state)).toBe(true); // 本地仍在
  });

  it("删除非活动远端不影响当前活动节点", () => {
    let s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    s = withRemote(s, "cccc2222dddd", "https://b");
    s = connectNode(s, LOCAL_NODE_ID, T1).state;
    const removed = removeNode(s, "aaaa1111bbbb");
    expect(removed.state.activeNodeId).toBe(LOCAL_NODE_ID);
  });
});

describe("单活会话：connect/disconnect 语义", () => {
  it("connect 设为唯一活动并刷新 lastConnectedAt；连本地置 running", () => {
    let s = withLocal();
    s = withRemote(s, "aaaa1111bbbb", "http://a:3001");
    s = disconnectNode(s, LOCAL_NODE_ID).state; // 本地先停止
    expect(s.localDesired).toBe("stopped");
    s = connectNode(s, "aaaa1111bbbb", T1).state;
    expect(s.activeNodeId).toBe("aaaa1111bbbb");
    expect(getEntry(s, "aaaa1111bbbb")?.lastConnectedAt).toBe(T1);
    expect(s.localDesired).toBe("stopped"); // 连远端不改本地期望态
    s = connectNode(s, LOCAL_NODE_ID, T2).state;
    expect(s.activeNodeId).toBe(LOCAL_NODE_ID);
    expect(s.localDesired).toBe("running"); // 连本地→期望拉起进程
    expect(getEntry(s, LOCAL_NODE_ID)?.lastConnectedAt).toBe(T2);
  });

  it("disconnect 活动节点 → active 回落 null；disconnect 本地=stopped 但条目/数据保留", () => {
    const s = connectNode(withLocal(), LOCAL_NODE_ID, T1).state;
    expect(s.activeNodeId).toBe(LOCAL_NODE_ID);
    const d = disconnectNode(s, LOCAL_NODE_ID);
    expect(d.state.activeNodeId).toBeNull();
    expect(d.state.localDesired).toBe("stopped");
    expect(hasLocal(d.state)).toBe(true); // 只是停进程，不删条目
  });

  it("disconnect 非活动远端不改活动指针", () => {
    let s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    s = connectNode(s, LOCAL_NODE_ID, T1).state;
    const d = disconnectNode(s, "aaaa1111bbbb");
    expect(d.state.activeNodeId).toBe(LOCAL_NODE_ID);
  });

  it("对不存在节点 connect/disconnect/remove/rename 报 NODE_NOT_FOUND", () => {
    const s = withLocal();
    expect(connectNode(s, "nope", T1).error?.code).toBe("NODE_NOT_FOUND");
    expect(disconnectNode(s, "nope").error?.code).toBe("NODE_NOT_FOUND");
    expect(removeNode(s, "nope").error?.code).toBe("NODE_NOT_FOUND");
    expect(renameNode(s, "nope", "x").error?.code).toBe("NODE_NOT_FOUND");
  });
});

describe("rename", () => {
  it("可改远端/本地显示名，不改其余字段", () => {
    let s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    s = renameNode(s, "aaaa1111bbbb", "公司").state;
    expect(getEntry(s, "aaaa1111bbbb")?.label).toBe("公司");
    expect(getEntry(s, "aaaa1111bbbb")?.baseURL).toBe("http://a:3001");
  });
});

describe("持久化：不含凭据 + roundtrip", () => {
  it("序列化结果不含 token/password 字样且可还原", () => {
    let s = withRemote(withLocal(), "aaaa1111bbbb", "http://a:3001");
    s = connectNode(s, "aaaa1111bbbb", T1).state;
    const json = serializeRegistry(s);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/password/i);
    const back = parseRegistry(json);
    expect(back.entries).toHaveLength(2);
    expect(back.activeNodeId).toBe("aaaa1111bbbb");
    expect(back.localDesired).toBe("running");
  });
});

describe("parseRegistry 对脏/老数据强制收敛（fail-safe）", () => {
  it("null/空串/非法 JSON/非对象 → 空册", () => {
    expect(parseRegistry(null)).toEqual(emptyRegistry());
    expect(parseRegistry("")).toEqual(emptyRegistry());
    expect(parseRegistry("not-json{")).toEqual(emptyRegistry());
    expect(parseRegistry("[]")).toEqual(emptyRegistry());
    expect(parseRegistry('"str"')).toEqual(emptyRegistry());
  });

  it("version 不符或 entries 非数组 → 空册", () => {
    expect(parseRegistry(JSON.stringify({ version: 9, entries: [] }))).toEqual(emptyRegistry());
    expect(parseRegistry(JSON.stringify({ version: 1, entries: {} }))).toEqual(emptyRegistry());
  });

  it("丢弃形状非法条目；本地至多一个且规范为 local、baseURL 强制空", () => {
    const dirty = JSON.stringify({
      version: 1,
      activeNodeId: null,
      localDesired: "running",
      entries: [
        { kind: "remote", nodeId: "r1", baseURL: "http://x" }, // 合法
        { kind: "weird", nodeId: "x", baseURL: "y" }, // 非法 kind
        { kind: "remote", nodeId: "", baseURL: "y" }, // 空 id
        { kind: "remote", nodeId: "r2" }, // 缺 baseURL
        { kind: "local", nodeId: "tampered-local", baseURL: "http://should-clear", label: "我的" },
        { kind: "local", nodeId: "local-2", baseURL: "" }, // 第二个本地，丢弃
      ],
    });
    const s = parseRegistry(dirty);
    expect(s.entries.map((e) => e.nodeId).sort()).toEqual(["local", "r1"]);
    const loc = localEntry(s);
    expect(loc?.nodeId).toBe(LOCAL_NODE_ID);
    expect(loc?.baseURL).toBe("");
    expect(loc?.label).toBe("我的");
  });

  it("nodeId 去重（保留首个）", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { kind: "remote", nodeId: "dup", baseURL: "http://a", label: "first" },
        { kind: "remote", nodeId: "dup", baseURL: "http://b", label: "second" },
      ],
    });
    const s = parseRegistry(raw);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].label).toBe("first");
  });

  it("activeNodeId 不指向存活条目 → null", () => {
    const raw = JSON.stringify({
      version: 1,
      activeNodeId: "ghost",
      entries: [{ kind: "remote", nodeId: "r1", baseURL: "http://a" }],
    });
    expect(parseRegistry(raw).activeNodeId).toBeNull();
  });

  it("有本地但 localDesired 非法/缺失 → 收敛为 running（默认拉起更安全）；无本地 → null", () => {
    const withLocalBad = JSON.stringify({
      version: 1,
      localDesired: "banana",
      entries: [{ kind: "local", nodeId: "local", baseURL: "" }],
    });
    expect(parseRegistry(withLocalBad).localDesired).toBe("running");
    const noLocal = JSON.stringify({
      version: 1,
      localDesired: "running",
      entries: [{ kind: "remote", nodeId: "r1", baseURL: "http://a" }],
    });
    expect(parseRegistry(noLocal).localDesired).toBeNull();
  });

  it("本地 localDesired=stopped 被忠实保留（纯远端用户重启后仍不拉起本地）", () => {
    const raw = JSON.stringify({
      version: 1,
      activeNodeId: "r1",
      localDesired: "stopped",
      entries: [
        { kind: "local", nodeId: "local", baseURL: "" },
        { kind: "remote", nodeId: "r1", baseURL: "http://a" },
      ],
    });
    const s = parseRegistry(raw);
    expect(s.localDesired).toBe("stopped");
    expect(s.activeNodeId).toBe("r1");
  });
});

// ── 离线副本（#828 第三入口契约地基）────────────────────────────────────────────

describe("isValidReplicaNodeId 边界（与 Rust sanitize_node_id 同口径）", () => {
  it("合法：字母/数字/点/下划线/连字符", () => {
    expect(isValidReplicaNodeId("office-1")).toBe(true);
    expect(isValidReplicaNodeId("a.b_c-9")).toBe(true);
    expect(isValidReplicaNodeId("  pad  ")).toBe(true); // trim 后 "pad"
  });
  it("拒绝：空/纯空白", () => {
    expect(isValidReplicaNodeId("")).toBe(false);
    expect(isValidReplicaNodeId("   ")).toBe(false);
  });
  it("拒绝：路径分隔符与穿越名", () => {
    expect(isValidReplicaNodeId("a/b")).toBe(false);
    expect(isValidReplicaNodeId(".")).toBe(false);
    expect(isValidReplicaNodeId("..")).toBe(false);
  });
  it("拒绝：保留 id local", () => {
    expect(isValidReplicaNodeId("local")).toBe(false);
    expect(isValidReplicaNodeId(" local ")).toBe(false);
  });
  it("拒绝：中文与空格", () => {
    expect(isValidReplicaNodeId("办公室")).toBe(false);
    expect(isValidReplicaNodeId("a b")).toBe(false);
  });
  it("长度边界：64 合法、65 非法", () => {
    expect(isValidReplicaNodeId("a".repeat(64))).toBe(true);
    expect(isValidReplicaNodeId("a".repeat(65))).toBe(false);
  });
});

describe("addReplicaNode：形状、与主库并存、错误码", () => {
  it("副本=kind local+role replica+baseURL 空，binding 存规范化裸 origin，不自动连接", () => {
    const r = addReplicaNode(withLocal(), {
      nodeId: "office-1",
      remoteBaseUrl: "http://192.168.1.5:3001/",
    });
    expect(r.error).toBeNull();
    const e = getEntry(r.state, "office-1");
    expect(e).toMatchObject({
      kind: "local",
      role: "replica",
      nodeId: "office-1",
      baseURL: "",
      lastConnectedAt: null,
    });
    expect(e?.replica?.remoteBaseUrl).toBe("http://192.168.1.5:3001"); // 裸 origin、去尾斜杠
    expect(r.state.activeNodeId).toBeNull(); // 添加≠连接
    expect(r.state.localDesired).toBe("running"); // 主库期望态不受影响
  });

  it("只存裸 origin：用户误填子路径/查询时剥离到 scheme://host[:port]（对齐 Rust normalize_http_base）", () => {
    const r = addReplicaNode(emptyRegistry(), {
      nodeId: "office-1",
      remoteBaseUrl: "http://h.example.com:3001/gx/",
    });
    expect(r.error).toBeNull();
    expect(getEntry(r.state, "office-1")?.replica?.remoteBaseUrl).toBe(
      "http://h.example.com:3001",
    );
    // query/fragment 也剥离；无显式端口时不带尾冒号
    const r2 = addReplicaNode(emptyRegistry(), {
      nodeId: "office-2",
      remoteBaseUrl: "https://hub.example/app/gouxiangdb?x=1#frag",
    });
    expect(getEntry(r2.state, "office-2")?.replica?.remoteBaseUrl).toBe(
      "https://hub.example",
    );
  });

  it("主库唯一且与多副本并存：hasLocal/localEntry 只认 primary，replicaEntries 收副本", () => {
    let s = withLocal();
    s = withReplica(s, "office-1", "http://a:3001");
    s = withReplica(s, "office-2", "http://b:3001");
    expect(hasLocal(s)).toBe(true);
    expect(localEntry(s)?.nodeId).toBe(LOCAL_NODE_ID);
    expect(replicaEntries(s).map((e) => e.nodeId).sort()).toEqual(["office-1", "office-2"]);
    expect(remoteEntries(s)).toHaveLength(0);
    expect(s.entries).toHaveLength(3);
  });

  it("nodeId trim 后落库；REPLICA_ID_INVALID", () => {
    const r = addReplicaNode(emptyRegistry(), {
      nodeId: " office-1 ",
      remoteBaseUrl: "http://a:3001",
    });
    expect(getEntry(r.state, "office-1")?.nodeId).toBe("office-1");
    const bad = addReplicaNode(emptyRegistry(), { nodeId: "a/b", remoteBaseUrl: "http://a" });
    expect(bad.error?.code).toBe("REPLICA_ID_INVALID");
    expect(bad.state.entries).toHaveLength(0);
  });

  it("nodeId 已被副本/主库/远端占用 → REPLICA_PROFILE_EXISTS", () => {
    let s = withReplica(withLocal(), "office-1", "http://a:3001");
    s = withRemote(s, "aaaa1111bbbb", "http://r:3001");
    expect(addReplicaNode(s, { nodeId: "office-1", remoteBaseUrl: "http://x" }).error?.code).toBe(
      "REPLICA_PROFILE_EXISTS",
    );
    expect(addReplicaNode(s, { nodeId: LOCAL_NODE_ID, remoteBaseUrl: "http://x" }).error?.code).toBe(
      "REPLICA_ID_INVALID",
    );
    expect(addReplicaNode(s, { nodeId: "aaaa1111bbbb", remoteBaseUrl: "http://x" }).error?.code).toBe(
      "REPLICA_PROFILE_EXISTS",
    );
  });

  it("remoteBaseUrl 无法规范化 → REPLICA_REMOTE_INVALID", () => {
    const r = addReplicaNode(emptyRegistry(), { nodeId: "office-1", remoteBaseUrl: "not a url x" });
    expect(r.error?.code).toBe("REPLICA_REMOTE_INVALID");
    expect(r.state.entries).toHaveLength(0);
  });
});

describe("removeNode：副本可删、主库不可删", () => {
  it("删除副本：条目消失；若是活动节点则 active 回落 null", () => {
    let s = withReplica(withLocal(), "office-1", "http://a:3001");
    s = connectNode(s, "office-1", T1).state;
    expect(activeEntry(s)?.nodeId).toBe("office-1");
    const removed = removeNode(s, "office-1");
    expect(removed.error).toBeNull();
    expect(getEntry(removed.state, "office-1")).toBeNull();
    expect(removed.state.activeNodeId).toBeNull();
    expect(hasLocal(removed.state)).toBe(true); // 主库仍在
  });
  it("主库依旧不可删", () => {
    const s = withReplica(withLocal(), "office-1", "http://a:3001");
    expect(removeNode(s, LOCAL_NODE_ID).error?.code).toBe("LOCAL_PROFILE_PERMANENT");
  });
});

describe("connect/disconnect 副本不影响主库 localDesired", () => {
  it("连/断副本只改 activeNodeId、lastConnectedAt，不动 localDesired", () => {
    let s = withReplica(withLocal(), "office-1", "http://a:3001");
    expect(s.localDesired).toBe("running");
    s = disconnectNode(s, LOCAL_NODE_ID).state; // 先停主库
    expect(s.localDesired).toBe("stopped");
    s = connectNode(s, "office-1", T1).state;
    expect(s.activeNodeId).toBe("office-1");
    expect(getEntry(s, "office-1")?.lastConnectedAt).toBe(T1);
    expect(s.localDesired).toBe("stopped"); // 连副本不改主库期望态
    const d = disconnectNode(s, "office-1");
    expect(d.state.activeNodeId).toBeNull();
    expect(d.state.localDesired).toBe("stopped"); // 断副本也不改
  });
  it("rename 对副本同样可用", () => {
    const s = withReplica(withLocal(), "office-1", "http://a:3001");
    const r = renameNode(s, "office-1", "办公室副本");
    expect(getEntry(r.state, "office-1")?.label).toBe("办公室副本");
  });
});

describe("副本持久化：不含 token + roundtrip + 老数据兼容", () => {
  it("含副本的序列化 JSON 不含 token/password，且副本字段可还原", () => {
    let s = withReplica(withLocal(), "office-1", "http://a:3001");
    s = connectNode(s, "office-1", T1).state;
    const json = serializeRegistry(s);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/password/i);
    expect(json).toContain('"role":"replica"');
    const back = parseRegistry(json);
    expect(hasLocal(back)).toBe(true);
    const rep = getEntry(back, "office-1");
    expect(rep).toMatchObject({ kind: "local", role: "replica", baseURL: "" });
    expect(rep?.replica?.remoteBaseUrl).toBe("http://a:3001");
    expect(back.activeNodeId).toBe("office-1"); // 副本 id 也通过 seen 校验
  });

  it("parse 老数据（local 无 role）仍收敛为 primary；既有无 role 用例不变", () => {
    const raw = JSON.stringify({
      version: 1,
      localDesired: "stopped",
      entries: [{ kind: "local", nodeId: "local", baseURL: "" }],
    });
    const s = parseRegistry(raw);
    expect(localEntry(s)?.role).toBe("primary");
    expect(replicaEntries(s)).toHaveLength(0);
    expect(s.localDesired).toBe("stopped");
  });

  it("parse 对注入 token/password 的脏副本绑定：丢弃凭据、保留合法字段", () => {
    const raw = JSON.stringify({
      version: 1,
      activeNodeId: "office-1",
      entries: [
        {
          kind: "local",
          role: "replica",
          nodeId: "office-1",
          baseURL: "http://SHOULD-CLEAR",
          replica: {
            remoteBaseUrl: "http://a:3001",
            remoteToken: "SECRET-TOK",
            token: "T",
            password: "p",
            clientId: "cid-7",
            syncIntervalMs: 5000,
          },
        },
      ],
    });
    const s = parseRegistry(raw);
    const rep = getEntry(s, "office-1");
    expect(rep?.baseURL).toBe(""); // 强制同源
    expect(rep?.replica).toEqual({
      remoteBaseUrl: "http://a:3001",
      clientId: "cid-7",
      syncIntervalMs: 5000,
    });
    expect(JSON.stringify(rep)).not.toMatch(/token/i);
    expect(JSON.stringify(rep)).not.toMatch(/password/i);
    expect(s.activeNodeId).toBe("office-1");
  });

  it("parse 对旧数据残留子路径的绑定兜底收敛为裸 origin", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "local",
          role: "replica",
          nodeId: "office-1",
          baseURL: "",
          replica: { remoteBaseUrl: "http://h.example.com:3001/gx/sub/" },
        },
      ],
    });
    expect(getEntry(parseRegistry(raw), "office-1")?.replica?.remoteBaseUrl).toBe(
      "http://h.example.com:3001",
    );
  });

  it("parse 多副本按 nodeId 去重、允许并存；非法副本名被丢弃", () => {
    const raw = JSON.stringify({
      version: 1,
      localDesired: "running",
      entries: [
        { kind: "local", nodeId: "local", baseURL: "" },
        { kind: "local", role: "replica", nodeId: "office-1", baseURL: "", replica: { remoteBaseUrl: "http://a" } },
        { kind: "local", role: "replica", nodeId: "office-1", baseURL: "", replica: { remoteBaseUrl: "http://b" } },
        { kind: "local", role: "replica", nodeId: "a/b", baseURL: "", replica: { remoteBaseUrl: "http://c" } },
        { kind: "local", role: "replica", nodeId: "office-2", baseURL: "", replica: { remoteBaseUrl: "http://d" } },
      ],
    });
    const s = parseRegistry(raw);
    expect(replicaEntries(s).map((e) => e.nodeId).sort()).toEqual(["office-1", "office-2"]);
    expect(getEntry(s, "office-1")?.replica?.remoteBaseUrl).toBe("http://a"); // 保留首个
    expect(hasLocal(s)).toBe(true);
    expect(s.localDesired).toBe("running");
  });

  it("parse：无主库仅副本时 localDesired 为 null；active 指向不存在副本→null", () => {
    const onlyRep = JSON.stringify({
      version: 1,
      localDesired: "running",
      entries: [
        { kind: "local", role: "replica", nodeId: "office-1", baseURL: "", replica: { remoteBaseUrl: "http://a" } },
      ],
    });
    const s = parseRegistry(onlyRep);
    expect(hasLocal(s)).toBe(false);
    expect(s.localDesired).toBeNull(); // localDesired 仅由 primary 决定
    const dangling = JSON.stringify({
      version: 1,
      activeNodeId: "ghost",
      entries: [
        { kind: "local", role: "replica", nodeId: "office-1", baseURL: "", replica: { remoteBaseUrl: "http://a" } },
      ],
    });
    expect(parseRegistry(dangling).activeNodeId).toBeNull();
  });
});

// registry.ts 测试（纯 node、无 jsdom、无新依赖）。
// 锁定启动器多节点模型（DESIGN-MACOS-APP.md §8.5）的全部不变量：
// 新装空册不启本地 / 本地唯一不可删不可重建 / 本地可停止但保留 / 远端可多可删 /
// 单活且断开后活动指针安全回落 / 持久化不含凭据 / parse 对脏数据强制收敛。

import { describe, it, expect } from "vitest";
import {
  emptyRegistry,
  addLocalNode,
  addRemoteNode,
  removeNode,
  connectNode,
  disconnectNode,
  renameNode,
  getEntry,
  hasLocal,
  localEntry,
  remoteEntries,
  activeEntry,
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

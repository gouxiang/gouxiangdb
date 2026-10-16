// launcherViewModel.ts 纯派生层单测（node 环境，无 DOM/React）。
import { describe, it, expect } from "vitest";
import {
  buildNodeRows,
  buildLauncherViewModel,
  hostLabel,
} from "./launcherViewModel";
import { emptyRegistry, type NodeRegistryState, type StoredNodeEntry } from "./registry";
import type { RemoteSessionView } from "./remoteSessions";

const local = (over: Partial<StoredNodeEntry> = {}): StoredNodeEntry => ({
  kind: "local",
  nodeId: "local",
  baseURL: "",
  label: "本机",
  lastConnectedAt: null,
  ...over,
});
const remote = (over: Partial<StoredNodeEntry> & { nodeId: string }): StoredNodeEntry => ({
  kind: "remote",
  baseURL: `http://${over.nodeId}:3001`,
  label: null,
  lastConnectedAt: null,
  ...over,
});
const session = (nodeId: string, user: RemoteSessionView["user"]): RemoteSessionView => ({
  nodeId,
  token: "t",
  user,
});

describe("hostLabel", () => {
  it("取 host:port，畸形回落原串", () => {
    expect(hostLabel("https://nas.local:8443/app")).toBe("nas.local:8443");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("buildNodeRows", () => {
  it("空注册表 → 空行", () => {
    expect(buildNodeRows(emptyRegistry(), new Map())).toEqual([]);
  });

  it("本地行：默认标题本机/副标题/不可删/期望态/活动标记", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [local()],
      activeNodeId: "local",
      localDesired: "running",
    };
    const [row] = buildNodeRows(state, new Map());
    expect(row).toMatchObject({
      kind: "local",
      nodeId: "local",
      title: "本机",
      subtitle: "本机数据",
      active: true,
      connected: true,
      removable: false,
      localDesired: "running",
      account: null,
    });
  });

  it("本地自定义名优先；stopped 期望态透传", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [local({ label: "我的小主机" })],
      localDesired: "stopped",
    };
    const [row] = buildNodeRows(state, new Map());
    expect(row!.title).toBe("我的小主机");
    expect(row!.localDesired).toBe("stopped");
    expect(row!.active).toBe(false);
    expect(row!.connected).toBe(false);
  });

  it("远端行：自定义名优先，否则用 host；副标题为基址；可删", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [remote({ nodeId: "abc", baseURL: "http://nas:3001", label: "公司库" })],
    };
    let [row] = buildNodeRows(state, new Map());
    expect(row!.title).toBe("公司库");
    expect(row!.subtitle).toBe("http://nas:3001");
    expect(row!.removable).toBe(true);
    expect(row!.kind).toBe("remote");

    const state2 = { ...state, entries: [remote({ nodeId: "abc", baseURL: "http://nas:3001" })] };
    [row] = buildNodeRows(state2, new Map());
    expect(row!.title).toBe("nas:3001");
  });

  it("未活动但有已存会话：active=false、connected=true、account 显示邮箱", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [remote({ nodeId: "abc" })],
      activeNodeId: null,
    };
    const sessions = new Map([["abc", session("abc", { id: "u", email: "a@b.com" } as never)]]);
    const [row] = buildNodeRows(state, sessions);
    expect(row!.active).toBe(false);
    expect(row!.connected).toBe(true);
    expect(row!.account).toBe("a@b.com");
  });

  it("排序：本地恒在最前；远端按最近连接时间倒序，从未连接垫底", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [
        remote({ nodeId: "old", lastConnectedAt: "2026-09-01T00:00:00Z" }),
        remote({ nodeId: "never" }),
        local(),
        remote({ nodeId: "new", lastConnectedAt: "2026-10-01T00:00:00Z" }),
      ],
    };
    const rows = buildNodeRows(state, new Map()).map((r) => r.nodeId);
    expect(rows).toEqual(["local", "new", "old", "never"]);
  });
});

describe("buildLauncherViewModel", () => {
  it("汇总标记：空/有本地/有活动", () => {
    expect(buildLauncherViewModel(emptyRegistry(), new Map()).isEmpty).toBe(true);
    const withLocal: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [local()],
      localDesired: "running",
    };
    const vm1 = buildLauncherViewModel(withLocal, new Map());
    expect(vm1.hasLocal).toBe(true);
    expect(vm1.hasActive).toBe(false);

    const active: NodeRegistryState = { ...withLocal, activeNodeId: "local" };
    const vm2 = buildLauncherViewModel(active, new Map());
    expect(vm2.hasActive).toBe(true);
    expect(vm2.activeNodeId).toBe("local");
  });
});

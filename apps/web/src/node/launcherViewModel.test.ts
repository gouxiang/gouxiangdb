// launcherViewModel.ts 纯派生层单测（node 环境，无 DOM/React）。
import { describe, it, expect } from "vitest";
import {
  applyLocalRuntime,
  buildNodeRows,
  buildLauncherViewModel,
  ensureLocalRow,
  hostLabel,
} from "./launcherViewModel";
import type { LocalRuntimeLike, NodeRow } from "./launcherViewModel";
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

describe("buildLauncherViewModel", () => {  it("汇总标记：空/有本地/有活动", () => {
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

describe("ensureLocalRow", () => {
  it("已有本机行：原样保留（不重复、不改顺序、真实行 canRename=true）", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [remote({ nodeId: "abc" }), local()],
    };
    const rows = ensureLocalRow(buildNodeRows(state, new Map()));
    expect(rows.map((r) => r.kind)).toEqual(["local", "remote"]);
    expect(rows[0]!.canRename).toBe(true);
  });

  it("只有远端、无本机：最前补占位本机行（nodeId=local、未活动、不可删、不可改名）", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [remote({ nodeId: "abc" })],
      activeNodeId: "abc",
    };
    const rows = ensureLocalRow(buildNodeRows(state, new Map()));
    expect(rows.map((r) => r.nodeId)).toEqual(["local", "abc"]);
    const p = rows[0]!;
    expect(p).toMatchObject({
      kind: "local",
      nodeId: "local",
      title: "本机",
      active: false,
      removable: false,
      canRename: false,
      localDesired: "stopped",
    });
    // 占位行不顶替当前活动远端。
    expect(rows[1]!.active).toBe(true);
  });

  it("空行：仍补一个占位本机行（全新装欢迎页本身不消费它，仅保证函数全情形有本机入口）", () => {
    const rows = ensureLocalRow([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("local");
    expect(rows[0]!.canRename).toBe(false);
  });

  it("占位本机行经 applyLocalRuntime（壳内 added=false）映射为 absent，驱动『未启用+进入本机+启动』", () => {
    const status: LocalRuntimeLike = {
      added: false,
      initialized: false,
      running: false,
      ready: false,
      kernelPort: null,
    };
    const [row] = applyLocalRuntime(ensureLocalRow([]), status, false);
    expect(row!.runtime).toBe("absent");
  });
});

describe("applyLocalRuntime", () => {
  const vmLike = (over: Partial<NodeRow> = {}): NodeRow =>
    ({
      kind: "local",
      nodeId: "local",
      title: "本机",
      label: null,
      subtitle: "本机数据",
      baseURL: "",
      active: false,
      connected: false,
      account: null,
      localDesired: "running",
      removable: false,
      lastConnectedAt: null,
      ...over,
    }) as NodeRow;
  const remoteRow = (): NodeRow =>
    ({
      kind: "remote",
      nodeId: "abc",
      title: "nas:3001",
      label: null,
      subtitle: "http://nas:3001",
      baseURL: "http://nas:3001",
      active: false,
      connected: false,
      account: null,
      localDesired: null,
      removable: true,
      lastConnectedAt: null,
    }) as NodeRow;
  const st = (over: Partial<LocalRuntimeLike> = {}): LocalRuntimeLike => ({
    added: true,
    initialized: true,
    running: true,
    ready: true,
    kernelPort: 3001,
    ...over,
  });

  it("status=null → 本地 unknown、带 kernelPort=null；远端行引用不变", () => {
    const remote = remoteRow();
    const local = vmLike();
    const rows = [local, remote];
    const out = applyLocalRuntime(rows, null, false);
    expect(out[0]!.runtime).toBe("unknown");
    expect(out[0]!.kernelPort).toBeNull();
    expect(out[1]).toBe(remote);
    expect(rows[0]).toEqual(local); // 入参不被改
  });

  it("!added → absent（busy 时为 starting）", () => {
    const out = applyLocalRuntime([vmLike()], st({ added: false }), false);
    expect(out[0]!.runtime).toBe("absent");
    const busy = applyLocalRuntime([vmLike()], st({ added: false }), true);
    expect(busy[0]!.runtime).toBe("starting");
  });

  it("added 但未运行 → stopped", () => {
    const out = applyLocalRuntime([vmLike()], st({ running: false, ready: false }), false);
    expect(out[0]!.runtime).toBe("stopped");
  });

  it("运行中但未就绪 → starting", () => {
    const out = applyLocalRuntime([vmLike()], st({ running: true, ready: false }), false);
    expect(out[0]!.runtime).toBe("starting");
  });

  it("运行且就绪 → ready 并带 kernelPort", () => {
    const out = applyLocalRuntime([vmLike()], st({ kernelPort: 4100 }), false);
    expect(out[0]!.runtime).toBe("ready");
    expect(out[0]!.kernelPort).toBe(4100);
  });

  it("busyLocal 把 stopped 拉成 starting，但 ready 不降级", () => {
    const stopped = applyLocalRuntime(
      [vmLike()],
      st({ running: false, ready: false }),
      true,
    );
    expect(stopped[0]!.runtime).toBe("starting");
    const ready = applyLocalRuntime([vmLike()], st(), true);
    expect(ready[0]!.runtime).toBe("ready");
  });

  it("结果未变化时返回同一数组引用（幂等）", () => {
    const rows = applyLocalRuntime([vmLike()], st(), false);
    expect(applyLocalRuntime(rows, st(), false)).toBe(rows);
  });
});

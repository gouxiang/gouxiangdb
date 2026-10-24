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
// 离线副本条目（kind:"local" + 显式 role:"replica"），nodeId 走白名单副本名（绝不收中文）。
const replica = (
  nodeId: string,
  over: Partial<StoredNodeEntry> = {},
): StoredNodeEntry => ({
  kind: "local",
  role: "replica",
  nodeId,
  baseURL: "",
  label: null,
  lastConnectedAt: null,
  replica: { remoteBaseUrl: "http://nas.example:3001" },
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

  it("副本行：保留自身 nodeId（P0：不被串成 local）、role/默认标题/副标题/可删可改名/无期望态无 runtime", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [local(), replica("replica-1", { lastConnectedAt: "2026-09-01T00:00:00Z" })],
      activeNodeId: null,
    };
    const rows = buildNodeRows(state, new Map());
    const repRow = rows.find((r) => r.nodeId === "replica-1");
    expect(repRow).toMatchObject({
      kind: "local",
      role: "replica",
      nodeId: "replica-1", // 旧码在此硬编码 LOCAL_NODE_ID，会把副本串成主库
      title: "本机副本",
      label: null,
      subtitle: "http://nas.example:3001",
      baseURL: "",
      active: false,
      connected: false,
      account: null,
      localDesired: null,
      removable: true,
      canRename: true,
      lastConnectedAt: "2026-09-01T00:00:00Z",
    });
    // 副本不承载壳内实时相位/端口（runtime 只属于主库行）。
    expect(repRow!.runtime).toBeUndefined();
    expect(repRow!.kernelPort).toBeUndefined();
  });

  it("副本行：自定义名优先；成为活动节点或有分键会话时 connected=true 且 account 取分键会话", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [replica("replica-2", { label: "办公室副本" })],
      activeNodeId: "replica-2",
    };
    const sessions = new Map([
      ["replica-2", session("replica-2", { id: "u", email: "r@b.com" } as never)],
    ]);
    const [row] = buildNodeRows(state, sessions);
    expect(row!.title).toBe("办公室副本");
    expect(row!.label).toBe("办公室副本");
    expect(row!.active).toBe(true);
    expect(row!.connected).toBe(true);
    expect(row!.account).toBe("r@b.com");

    // 非活动但该副本 nodeId 已有分键会话：仍 connected=true（按 entry.nodeId 分键，不串主库）。
    const idle: NodeRegistryState = { ...state, activeNodeId: null };
    const [idleRow] = buildNodeRows(idle, sessions);
    expect(idleRow!.active).toBe(false);
    expect(idleRow!.connected).toBe(true);
    expect(idleRow!.account).toBe("r@b.com");
  });

  it("排序：主库 0 → 副本 1 → 远端 2，角色权重压过连接时间", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [
        remote({ nodeId: "r-old", lastConnectedAt: "2026-08-01T00:00:00Z" }),
        replica("replica-b", { lastConnectedAt: "2026-09-01T00:00:00Z" }),
        local(),
        replica("replica-a", { lastConnectedAt: "2026-10-01T00:00:00Z" }),
        remote({ nodeId: "r-new", lastConnectedAt: "2026-12-01T00:00:00Z" }),
      ],
    };
    // 即便远端 r-new 时间最新，也因权重 2 排到全部副本（权重 1）之后。
    expect(buildNodeRows(state, new Map()).map((r) => r.nodeId)).toEqual([
      "local",
      "replica-a", // 副本组内 10月 > 9月
      "replica-b",
      "r-new", // 远端组内 12月 > 8月
      "r-old",
    ]);
  });

  it("排序：同角色都从未连接时按 nodeId 升序兜底（确定性）", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [replica("replica-3"), local(), replica("replica-1"), replica("replica-2")],
    };
    expect(buildNodeRows(state, new Map()).map((r) => r.nodeId)).toEqual([
      "local",
      "replica-1",
      "replica-2",
      "replica-3",
    ]);
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

  it("hasLocal 只认真主库：仅有离线副本（哪怕是活动副本）时仍为 false", () => {
    const replicaOnly: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [replica("replica-1")],
      activeNodeId: "replica-1",
    };
    const vm = buildLauncherViewModel(replicaOnly, new Map());
    expect(vm.hasLocal).toBe(false); // kind:"local" 但 role:"replica" 不算本机主库
    expect(vm.isEmpty).toBe(false); // 有副本就不是全新空态
    expect(vm.hasActive).toBe(true); // 活动指针可以指向副本
    expect(vm.activeRow?.role).toBe("replica");
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

  it("仅有离线副本、无主库：仍在最前补占位主库（副本不是『进入本机』入口）", () => {
    const state: NodeRegistryState = {
      ...emptyRegistry(),
      entries: [replica("replica-1", { label: "办公室副本" })],
      activeNodeId: "replica-1",
    };
    const rows = ensureLocalRow(buildNodeRows(state, new Map()));
    expect(rows.map((r) => r.nodeId)).toEqual(["local", "replica-1"]);
    const p = rows[0]!;
    expect(p.role).toBe("primary");
    expect(p.canRename).toBe(false); // 占位主库不可改名
    expect(p.active).toBe(false); // 不顶替当前活动副本
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
      // role 是 applyLocalRuntime 的运行时判别真源（as 断言绕过 tsc 但绕不过运行时）：
      // 缺它则 role===undefined !== "primary" 提前 return，所有本地相位用例都会挂。
      role: "primary",
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
      role: null, // 同上：role 是运行时判别字段，字面量必须显式给。
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

  it("副本行（kind:local + role:replica）不被实时相位映射，任意 status 都原样返回同一引用", () => {
    const replicaRow: NodeRow = {
      kind: "local",
      role: "replica",
      nodeId: "replica-1",
      title: "本机副本",
      label: null,
      subtitle: "http://nas.example:3001",
      baseURL: "",
      active: false,
      connected: false,
      account: null,
      localDesired: null,
      removable: true,
      canRename: true,
      lastConnectedAt: null,
    };
    // 主库在 ready，副本也不得被染上 runtime/kernelPort。
    const out = applyLocalRuntime([vmLike(), replicaRow], st(), false);
    expect(out[1]).toBe(replicaRow);
    expect(out[1]!.runtime).toBeUndefined();
    expect(out[1]!.kernelPort).toBeUndefined();
    // status=null（非壳/首拍未回）同样原样返回副本。
    const nullOut = applyLocalRuntime([replicaRow], null, false);
    expect(nullOut[0]).toBe(replicaRow);
  });
});

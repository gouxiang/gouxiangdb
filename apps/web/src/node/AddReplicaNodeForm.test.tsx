// AddReplicaNodeForm 测试（node + react-dom/server，无 jsdom/无新依赖）。
//
// 分两半：
//   A. View SSR 结构锁：三字段/占位/密码掩码、busy 禁用与加载文案、重连只读预填、
//      §7.3 确定错误文案 + alert 角色、成功 status；
//   B. submitReplicaConnection 纯异步编排（fake void store，对齐真实 LauncherStore）：
//      成功入册→通电、非法网址 form_error 且不通电、通电 reject 不回滚登记、
//      既有副本跳过入册直连、空令牌 fail-closed，以及令牌零持久化（注册表 JSON 对拍）。
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AddReplicaNodeFormView,
  EMPTY_ADD_REPLICA_VALUES,
  submitReplicaConnection,
  type AddReplicaFormValues,
  type ExistingReplica,
  type ReplicaConnectPort,
} from "./AddReplicaNodeForm";
import {
  addReplicaNode,
  emptyRegistry,
  type AddReplicaInput,
  type NodeRegistryState,
  type StoredNodeEntry,
} from "./registry";

// ── A. View SSR ───────────────────────────────────────────────────────────────

function render(
  values: AddReplicaFormValues = EMPTY_ADD_REPLICA_VALUES,
  extra: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    React.createElement(AddReplicaNodeFormView, {
      values,
      onField: vi.fn(),
      onSubmit: vi.fn(),
      ...extra,
    }),
  );
}

describe("AddReplicaNodeFormView", () => {
  it("渲染服务器网址/连接令牌/副本名称三字段，令牌为 password 掩码", () => {
    const html = render();
    expect(html).toContain("服务器网址");
    expect(html).toContain("http://192.168.1.5:3001");
    expect(html).toContain("连接令牌");
    expect(html).toContain('type="password"');
    expect(html).toContain("粘贴服务器管理员给的连接令牌");
    expect(html).toContain("副本名称（可选）");
    expect(html).toContain("添加并进入");
    // 说明必须明示令牌不保存（零持久化的用户可见承诺）。
    expect(html).toContain("连接令牌只用于本次启动，不会被保存");
  });

  it("busy：按钮显示正在连接、aria-busy，字段禁用", () => {
    const html = render(EMPTY_ADD_REPLICA_VALUES, { busy: true });
    expect(html).toContain("正在连接…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    // busy 时提交按钮不显示常态文案
    expect(html).not.toContain("添加并进入");
  });

  it("登记类失败渲染 §7.3 确定文案且带 alert 角色", () => {
    const html = render(EMPTY_ADD_REPLICA_VALUES, {
      error: { stage: "form", code: "invalid_url" },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("请输入有效的节点网址");
  });

  it("通电类失败（字符串）渲染 alert 文案", () => {
    const html = render(EMPTY_ADD_REPLICA_VALUES, {
      connectError: "当前环境不支持连接离线副本",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("当前环境不支持连接离线副本");
  });

  it("无错误不渲染 alert；成功渲染 status", () => {
    expect(render()).not.toContain('role="alert"');
    const html = render(EMPTY_ADD_REPLICA_VALUES, { succeeded: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("已连接，正在进入副本");
  });

  it("重连形态：网址/名称只读预填、按钮文案为连接并进入、只收令牌", () => {
    const existing: ExistingReplica = {
      nodeId: "replica-1",
      remoteBaseUrl: "http://nas:3001",
      label: "办公本",
    };
    const html = render(
      { url: "http://nas:3001", remoteToken: "", label: "办公本" },
      { existingReplica: existing },
    );
    expect(html).toContain("http://nas:3001");
    expect(html).toContain("办公本");
    // 只读用 readOnly/aria-readonly，不是 disabled（仍可选中复制）。
    expect(html).toContain('readonly=""');
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain("连接并进入");
    expect(html).not.toContain("添加并进入");
  });

  it("带取消回调时渲染取消按钮", () => {
    const html = render(EMPTY_ADD_REPLICA_VALUES, { onCancel: vi.fn() });
    expect(html).toContain("取消");
  });
});

// ── B. 纯异步编排 submitReplicaConnection ──────────────────────────────────────

const REMOTE_URL = "http://nas:3001";
const TOKEN = "s3cret-token";

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
 * void 版 fake store：结构对齐真实 LauncherStore——addReplica 返回 void（仅入册），
 * 内核仍走真 registry.addReplicaNode（重名/非法名走真路径）；connectReplica 可编排成功/失败。
 */
function fakeStore(opts: {
  initial?: StoredNodeEntry[];
  failConnectWith?: Error;
} = {}) {
  let state: NodeRegistryState = { ...emptyRegistry(), entries: [...(opts.initial ?? [])] };
  const registerCalls: AddReplicaInput[] = [];
  const connectCalls: Array<{ nodeId: string; token: string }> = [];

  const store: ReplicaConnectPort = {
    getState: () => state,
    addReplica(input: AddReplicaInput): void {
      registerCalls.push(input);
      const result = addReplicaNode(state, input);
      if (result.error) throw new Error(result.error.message);
      state = result.state;
    },
    async connectReplica(nodeId: string, token: string) {
      connectCalls.push({ nodeId, token });
      if (opts.failConnectWith) throw opts.failConnectWith;
      // 模拟成功选路：active 指向该副本（真实 store 内 connectNodeById 会把它置活动）。
      state = { ...state, activeNodeId: nodeId };
      return { active: { nodeId } };
    },
  };

  return {
    store,
    registerCalls,
    connectCalls,
    entries: () => state.entries,
    serialized: () => JSON.stringify(state),
  };
}

describe("submitReplicaConnection — 新副本", () => {
  it("成功：先入册（只传三键、自动 replica-1），再用当次令牌通电并返回 connected", async () => {
    const f = fakeStore();
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "办公本", remoteToken: TOKEN },
      { store: f.store },
    );

    expect(r.kind).toBe("connected");
    if (r.kind === "connected") expect(r.nodeId).toBe("replica-1");

    expect(f.registerCalls).toHaveLength(1);
    expect(f.registerCalls[0]).toEqual({
      nodeId: "replica-1",
      label: "办公本",
      remoteBaseUrl: REMOTE_URL,
    });
    // 入册入参不得夹带任何凭据。
    expect(JSON.stringify(f.registerCalls[0])).not.toContain(TOKEN);

    expect(f.connectCalls).toHaveLength(1);
    expect(f.connectCalls[0]).toEqual({ nodeId: "replica-1", token: TOKEN });
  });

  it("非法网址：form_error，既不入册也不通电", async () => {
    const f = fakeStore();
    const r = await submitReplicaConnection(
      { url: "not a url", label: "", remoteToken: TOKEN },
      { store: f.store },
    );
    expect(r.kind).toBe("form_error");
    if (r.kind === "form_error") {
      expect(r.error).toEqual({ stage: "form", code: "invalid_url" });
    }
    expect(f.registerCalls).toHaveLength(0);
    expect(f.connectCalls).toHaveLength(0);
  });

  it("通电 reject：connect_error 带确定中文文案，且不回滚已登记条目，可改令牌重连", async () => {
    const f = fakeStore({ failConnectWith: new Error("主库正在运行，无法启动副本") });
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "", remoteToken: TOKEN },
      { store: f.store },
    );
    expect(r.kind).toBe("connect_error");
    if (r.kind === "connect_error") {
      expect(r.nodeId).toBe("replica-1");
      expect(r.message).toBe("主库正在运行，无法启动副本");
    }
    // 已入册一次、通电一次；条目仍保留（不回滚）。
    expect(f.registerCalls).toHaveLength(1);
    expect(f.connectCalls).toHaveLength(1);
    expect(f.entries().some((e) => e.nodeId === "replica-1")).toBe(true);
  });

  it("非 Error 拒绝值收敛为兜底中文文案", async () => {
    const f = fakeStore({ failConnectWith: "boom" as unknown as Error });
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "", remoteToken: TOKEN },
      { store: f.store },
    );
    expect(r.kind).toBe("connect_error");
    if (r.kind === "connect_error") expect(r.message).toBe("副本连接失败，请重试");
  });

  it("空令牌：发任何 IPC/入册前 fail-closed", async () => {
    const f = fakeStore();
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "", remoteToken: "   " },
      { store: f.store },
    );
    expect(r.kind).toBe("connect_error");
    if (r.kind === "connect_error") expect(r.message).toBe("请输入连接令牌");
    expect(f.registerCalls).toHaveLength(0);
    expect(f.connectCalls).toHaveLength(0);
  });

  it("零持久化：登记完成后注册表序列化结果不含令牌，副本条目无凭据字段", async () => {
    const f = fakeStore();
    await submitReplicaConnection(
      { url: REMOTE_URL, label: "", remoteToken: TOKEN },
      { store: f.store },
    );
    expect(f.serialized()).not.toContain(TOKEN);
    const entry = f.entries().find((e) => e.nodeId === "replica-1");
    expect(entry).toBeDefined();
    expect(entry?.replica).toEqual({
      remoteBaseUrl: REMOTE_URL,
      clientId: null,
      syncIntervalMs: null,
    });
    expect(JSON.stringify(entry)).not.toMatch(/token|password|secret/i);
  });
});

describe("submitReplicaConnection — 既有副本重连", () => {
  const existing: ExistingReplica = {
    nodeId: "replica-1",
    remoteBaseUrl: REMOTE_URL,
    label: "办公本",
  };

  it("跳过入册，直接用当次令牌对该 nodeId 通电", async () => {
    const f = fakeStore({ initial: [replicaEntry("replica-1")] });
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "办公本", remoteToken: TOKEN, existing },
      { store: f.store },
    );
    expect(r.kind).toBe("connected");
    if (r.kind === "connected") expect(r.nodeId).toBe("replica-1");
    expect(f.registerCalls).toHaveLength(0);
    expect(f.connectCalls).toEqual([{ nodeId: "replica-1", token: TOKEN }]);
  });

  it("重连失败：connect_error 指向该副本且不新增条目", async () => {
    const f = fakeStore({
      initial: [replicaEntry("replica-1")],
      failConnectWith: new Error("当前环境不支持连接离线副本"),
    });
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "办公本", remoteToken: TOKEN, existing },
      { store: f.store },
    );
    expect(r.kind).toBe("connect_error");
    if (r.kind === "connect_error") {
      expect(r.nodeId).toBe("replica-1");
      expect(r.message).toBe("当前环境不支持连接离线副本");
    }
    expect(f.registerCalls).toHaveLength(0);
    expect(f.entries().filter((e) => e.nodeId === "replica-1")).toHaveLength(1);
    expect(f.serialized()).not.toContain(TOKEN);
  });

  it("重连时空令牌 fail-closed，不通电", async () => {
    const f = fakeStore({ initial: [replicaEntry("replica-1")] });
    const r = await submitReplicaConnection(
      { url: REMOTE_URL, label: "办公本", remoteToken: "", existing },
      { store: f.store },
    );
    expect(r.kind).toBe("connect_error");
    expect(f.connectCalls).toHaveLength(0);
  });
});

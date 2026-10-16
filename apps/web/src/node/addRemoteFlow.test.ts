// apps/web/src/node/addRemoteFlow.test.ts
// S4-1 启动器 UI 纯逻辑地基：门控布尔、§7.3 文案映射、添加并连接远端节点编排器（含失败回滚）。
// node 环境（无 jsdom / 无 React / 无新依赖），网络与哈希全部注入。

import { describe, it, expect, vi } from "vitest";
import { isLauncherFlagEnabled, launcherEnabled } from "./desktopGate";
import {
  handshakeErrorMessage,
  loginErrorMessage,
  formErrorMessage,
  addNodeErrorMessage,
  type AddNodeFormErrorCode,
} from "./nodeMessages";
import { addAndConnectRemote, connectExistingRemote, type AddRemoteStorePort } from "./addRemoteFlow";
import {
  HandshakeError,
  RemoteLoginError,
  type HandshakeErrorCode,
  type LoginErrorCode,
  type NodeHandshake,
} from "./handshake";
import type { RemoteLoginResult } from "./launcher";
import type { StoredNodeEntry } from "./registry";

const fixedHasher = async () => "abcdef012345";
const okHandshake: NodeHandshake = {
  version: "0.2.4",
  initialized: true,
  signupOpen: false,
  meta: null,
};

interface FakeStore extends AddRemoteStorePort {
  activeNodeId: string | null;
  entries: StoredNodeEntry[];
  calls: string[];
  getNode(nodeId: string): StoredNodeEntry | null;
}

function makeStore(opts: {
  login?: (entry: StoredNodeEntry, creds?: { email: string; password: string }) => Promise<RemoteLoginResult>;
  existing?: StoredNodeEntry[];
}): FakeStore {
  const entries = [...(opts.existing ?? [])];
  const store: FakeStore = {
    entries,
    activeNodeId: null,
    calls: [],
    getState: () => ({
      version: 1 as const,
      entries,
      activeNodeId: store.activeNodeId,
      localDesired: null,
    }),
    getNode: (nodeId: string) => entries.find((e) => e.nodeId === nodeId) ?? null,
    addRemote(input) {
      entries.push({
        kind: "remote",
        nodeId: input.nodeId,
        baseURL: input.baseURL,
        label: input.label ?? null,
        lastConnectedAt: null,
      });
      store.calls.push(`add:${input.nodeId}`);
    },
    async connectRemote(nodeId, creds) {
      const entry = entries.find((e) => e.nodeId === nodeId)!;
      const result = opts.login
        ? await opts.login(entry, creds)
        : { token: "rtok", user: { id: "u1" } as RemoteLoginResult["user"] };
      store.calls.push(`connect:${nodeId}`);
      store.activeNodeId = nodeId;
      return {
        state: store.getState(),
        active: {
          nodeId,
          kind: "remote" as const,
          baseURL: entry.baseURL,
          token: result.token,
          wsOrigin: "",
        },
      };
    },
    removeRemote(nodeId) {
      const i = entries.findIndex((e) => e.nodeId === nodeId);
      if (i >= 0) entries.splice(i, 1);
      store.calls.push(`remove:${nodeId}`);
      if (store.activeNodeId === nodeId) store.activeNodeId = null;
    },
  };
  return store;
}

const baseInput = { url: "http://192.168.1.5:3001", email: "a@b.com", password: "pw" };

describe("desktopGate", () => {
  it("默认关闭：未设/空/假值均为 false", () => {
    for (const raw of [undefined, null, "", "  ", "0", "false", "no", "2"]) {
      expect(isLauncherFlagEnabled(raw)).toBe(false);
    }
  });
  it("仅显式 1/true（忽略大小写与空白）开启", () => {
    for (const raw of ["1", " 1 ", "true", "TRUE", "True"]) {
      expect(isLauncherFlagEnabled(raw)).toBe(true);
    }
  });
  it("launcherEnabled 显式注入优先于环境", () => {
    expect(launcherEnabled("0")).toBe(false);
    expect(launcherEnabled("1")).toBe(true);
  });
  it("默认构建（未注入 VITE_NODE_LAUNCHER）恒为关闭——现网零变化的总闸", () => {
    // vitest 不注入该 env，锁死默认必须是 false（桌面需显式 VITE_NODE_LAUNCHER=1）。
    expect(launcherEnabled()).toBe(false);
  });
});

describe("nodeMessages", () => {
  it("每种握手错误码都有非空确定文案", () => {
    const codes: HandshakeErrorCode[] = [
      "unreachable",
      "not_a_node",
      "version_incompatible",
      "not_initialized",
      "bad_response",
    ];
    for (const c of codes) {
      const msg = handshakeErrorMessage(c);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(4);
    }
    expect(handshakeErrorMessage("unreachable")).toContain("无法连接");
    expect(handshakeErrorMessage("version_incompatible")).toContain("版本不受支持");
    expect(handshakeErrorMessage("not_initialized")).toContain("尚未完成初始化");
  });
  it("每种登录错误码都有非空文案", () => {
    const codes: LoginErrorCode[] = [
      "unreachable",
      "invalid_credentials",
      "signup_closed",
      "must_change_password",
      "error",
    ];
    for (const c of codes) expect(loginErrorMessage(c).length).toBeGreaterThan(2);
    expect(loginErrorMessage("invalid_credentials")).toContain("邮箱或密码错误");
  });
  it("表单错误码文案 + 统一分类分发", () => {
    const codes: AddNodeFormErrorCode[] = [
      "invalid_url",
      "duplicate",
      "missing_credentials",
      "node_not_found",
      "label_invalid",
    ];
    for (const c of codes) expect(formErrorMessage(c).length).toBeGreaterThan(2);
    expect(addNodeErrorMessage({ stage: "form", code: "invalid_url" })).toBe(
      formErrorMessage("invalid_url"),
    );
    expect(addNodeErrorMessage({ stage: "handshake", code: "not_a_node" })).toBe(
      handshakeErrorMessage("not_a_node"),
    );
    expect(addNodeErrorMessage({ stage: "login", code: "invalid_credentials" })).toBe(
      loginErrorMessage("invalid_credentials"),
    );
  });
});

describe("addAndConnectRemote", () => {
  it("网址非法（空/含空格/畸形 host）→ invalid_url，且不触仓库/不握手", async () => {
    const store = makeStore({});
    const performHandshake = vi.fn(async () => okHandshake);
    for (const url of ["", "   ", "ht tp://x:1", "!!!", "http://", "http://  "]) {
      const res = await addAndConnectRemote(
        { ...baseInput, url },
        { store, nodeIdFor: fixedHasher, performHandshake },
      );
      expect(res.kind === "error" && res.error.code).toBe("invalid_url");
    }
    expect(performHandshake).not.toHaveBeenCalled();
    expect(store.entries).toHaveLength(0);
    expect(store.calls).toEqual([]);
  });

  it("缺账号或密码 → missing_credentials（探活前拦截）", async () => {
    const store = makeStore({});
    const performHandshake = vi.fn(async () => okHandshake);
    for (const patch of [{ email: "  " }, { password: "" }]) {
      const res = await addAndConnectRemote(
        { ...baseInput, ...patch },
        { store, nodeIdFor: fixedHasher, performHandshake },
      );
      expect(res.kind === "error" && res.error).toEqual({
        stage: "form",
        code: "missing_credentials",
      });
    }
    expect(performHandshake).not.toHaveBeenCalled();
    expect(store.entries).toHaveLength(0);
  });

  it("同规范化基址已在注册表 → duplicate，不再握手", async () => {
    const existing: StoredNodeEntry = {
      kind: "remote",
      nodeId: "abcdef012345",
      baseURL: "http://host:3001",
      label: null,
      lastConnectedAt: null,
    };
    const store = makeStore({ existing: [existing] });
    const performHandshake = vi.fn(async () => okHandshake);
    const res = await addAndConnectRemote(
      { url: "http://host:3001/", email: "a@b.com", password: "pw" },
      { store, nodeIdFor: fixedHasher, performHandshake },
    );
    expect(res.kind === "error" && res.error.code).toBe("duplicate");
    expect(performHandshake).not.toHaveBeenCalled();
    expect(store.entries).toHaveLength(1);
  });

  it.each([
    ["unreachable"],
    ["not_a_node"],
    ["version_incompatible"],
    ["not_initialized"],
    ["bad_response"],
  ] as HandshakeErrorCode[][])(
    "握手失败 %s → 对应分类，且不入册不切换",
    async (code) => {
      const store = makeStore({});
      const performHandshake = vi.fn(async () => {
        throw new HandshakeError(code);
      });
      const res = await addAndConnectRemote(baseInput, {
        store,
        nodeIdFor: fixedHasher,
        performHandshake,
      });
      expect(res).toEqual({ kind: "error", error: { stage: "handshake", code } });
      expect(store.entries).toHaveLength(0);
      expect(store.activeNodeId).toBeNull();
    },
  );

  it("握手抛出非 HandshakeError → fail-closed 归为 unreachable，不入册", async () => {
    const store = makeStore({});
    const res = await addAndConnectRemote(baseInput, {
      store,
      nodeIdFor: fixedHasher,
      performHandshake: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(res).toEqual({
      kind: "error",
      error: { stage: "handshake", code: "unreachable" },
    });
    expect(store.entries).toHaveLength(0);
  });

  it("成功：规范化网址/补协议去尾斜杠、入册、带凭据连接并成为活动源", async () => {
    const store = makeStore({
      login: vi.fn(async (_entry, creds) => {
        // 邮箱去空格，密码原样保留（含首尾空格也不裁剪）。
        expect(creds?.email).toBe("user@x.com");
        expect(creds?.password).toBe(" p w ");
        return { token: "rtok", user: { id: "ru" } as RemoteLoginResult["user"] };
      }),
    });
    const res = await addAndConnectRemote(
      {
        url: "HOST:3001/app/", // 裸 host + 大写 host + 尾斜杠
        email: "  user@x.com ",
        password: " p w ",
        label: "  家里的库  ",
      },
      { store, nodeIdFor: fixedHasher, performHandshake: vi.fn(async () => okHandshake) },
    );
    expect(res.kind).toBe("connected");
    if (res.kind !== "connected") throw new Error("should connect");
    expect(res.nodeId).toBe("abcdef012345");
    expect(res.baseURL).toBe("http://host:3001/app");
    expect(res.outcome.active?.nodeId).toBe("abcdef012345");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.label).toBe("家里的库");
    expect(store.entries[0]!.baseURL).toBe("http://host:3001/app");
    expect(store.activeNodeId).toBe("abcdef012345");
    expect(store.calls).toEqual(["add:abcdef012345", "connect:abcdef012345"]);
  });

  it("空白显示名归一为 null（用默认名）", async () => {
    const store = makeStore({});
    const res = await addAndConnectRemote(
      { ...baseInput, label: "   " },
      { store, nodeIdFor: fixedHasher, performHandshake: vi.fn(async () => okHandshake) },
    );
    expect(res.kind).toBe("connected");
    expect(store.entries[0]!.label).toBeNull();
  });

  it("登录失败（401 凭据错）→ 回滚刚加入的残条目，活动源保持 null", async () => {
    const store = makeStore({
      login: vi.fn(async () => {
        throw new RemoteLoginError("invalid_credentials", 401, {});
      }),
    });
    const res = await addAndConnectRemote(baseInput, {
      store,
      nodeIdFor: fixedHasher,
      performHandshake: vi.fn(async () => okHandshake),
    });
    expect(res).toEqual({ kind: "error", error: { stage: "login", code: "invalid_credentials" } });
    expect(store.entries).toHaveLength(0); // 回滚
    expect(store.activeNodeId).toBeNull();
    expect(store.calls).toEqual(["add:abcdef012345", "remove:abcdef012345"]);
  });

  it("登录环节抛非预期错 → login/error 并回滚", async () => {
    const store = makeStore({
      login: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const res = await addAndConnectRemote(baseInput, {
      store,
      nodeIdFor: fixedHasher,
      performHandshake: vi.fn(async () => okHandshake),
    });
    expect(res).toEqual({ kind: "error", error: { stage: "login", code: "error" } });
    expect(store.entries).toHaveLength(0);
    expect(store.calls).toEqual(["add:abcdef012345", "remove:abcdef012345"]);
  });

  it("默认 performHandshake 走 handshakeNode：对显式规范化 baseURL 探活（注入 fetch 成功）", async () => {
    const calls: string[] = [];
    const json = (obj: unknown) => new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/health")) return json({ version: "0.2.4" });
      if (url.endsWith("/api/auth/bootstrap-status")) return json({ initialized: true });
      return new Response("{}", { status: 404 }); // meta 匿名 404 → null，不阻断
    });
    const store = makeStore({});
    // 不注入 performHandshake，改走默认实现；用 global fetch 桩 + 固定哈希。
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const res = await addAndConnectRemote(baseInput, { nodeIdFor: fixedHasher, store });
      expect(res.kind).toBe("connected");
    } finally {
      globalThis.fetch = origFetch;
    }
    // health + bootstrap + meta 三探针，全部对显式 baseURL，不经当前活动源。
    expect(calls).toEqual([
      "http://192.168.1.5:3001/api/health",
      "http://192.168.1.5:3001/api/auth/bootstrap-status",
      "http://192.168.1.5:3001/api/v1/meta",
    ]);
  });
});

describe("connectExistingRemote", () => {
  function seeded(login?: NonNullable<Parameters<typeof makeStore>[0]>["login"]): FakeStore {
    return makeStore({
      existing: [
        {
          kind: "remote",
          nodeId: "abcdef012345",
          baseURL: "http://nas:3001",
          label: null,
          lastConnectedAt: null,
        },
      ],
      login,
    });
  }

  it("目标不存在 / 非远端 → node_not_found", async () => {
    const store = seeded();
    const r1 = await connectExistingRemote(
      { nodeId: "nope", email: "a@b.com", password: "pw" },
      store,
    );
    expect(r1).toEqual({ kind: "error", error: { stage: "form", code: "node_not_found" } });
    expect(store.calls).toEqual([]);
  });

  it("缺账号或密码 → missing_credentials，不调用连接", async () => {
    const store = seeded();
    for (const patch of [{ email: " " }, { password: "" }]) {
      const r = await connectExistingRemote(
        { nodeId: "abcdef012345", email: "a@b.com", password: "pw", ...patch },
        store,
      );
      expect(r).toEqual({
        kind: "error",
        error: { stage: "form", code: "missing_credentials" },
      });
    }
    expect(store.calls).toEqual([]);
  });

  it("凭据正确 → 登录连接成功，邮箱去空格", async () => {
    const login = vi.fn(
      async (_e: StoredNodeEntry, _c?: { email: string; password: string }) => ({
        token: "t",
        user: { id: "u" } as RemoteLoginResult["user"],
      }),
    );
    const store = seeded(login);
    const r = await connectExistingRemote(
      { nodeId: "abcdef012345", email: "  a@b.com ", password: "pw" },
      store,
    );
    expect(r.kind).toBe("connected");
    expect(login.mock.calls[0]![1]?.email).toBe("a@b.com");
    expect(store.activeNodeId).toBe("abcdef012345");
  });

  it("401 → invalid_credentials，活动源不切换", async () => {
    const store = seeded(
      vi.fn(async () => {
        throw new RemoteLoginError("invalid_credentials", 401, {});
      }),
    );
    const r = await connectExistingRemote(
      { nodeId: "abcdef012345", email: "a@b.com", password: "bad" },
      store,
    );
    expect(r).toEqual({ kind: "error", error: { stage: "login", code: "invalid_credentials" } });
    expect(store.activeNodeId).toBeNull();
  });
});

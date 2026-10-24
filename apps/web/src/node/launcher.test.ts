// launcher.ts 测试（纯 node：注入内存存储、固定 local base/token/origin）。
// 锁定：新装空态 resolver 回落 local 兜底；添加并连接本地→活动数据源 local；
// 「连接＝只选路」connectRemote 不登录、不发凭据请求，只把活动指针指向远端——
// 无会话即 token=null（remote-empty），有记住会话带 JWT；JWT 经 commitRemoteSession 落分键；
// 401 用 deauthenticateRemote 清会话但保持选路；断开本地=stopped 且无活动；
// restore 按已存会话恢复、无会话不自动连（在线纯选路与重启 fail-closed 的差别）。

import { describe, it, expect, vi } from "vitest";
import type { UserDTO } from "@gx/shared-types";
import { newLauncherController, deriveActiveDataSource } from "./launcher";
import type { RemoteLoginFn } from "./launcher";
import type { KvStorage } from "./remoteSessions";
import { LOCAL_NODE_ID } from "./resolve";
import {
  addLocalNode,
  connectNode,
  addRemoteNode,
  addReplicaNode,
  emptyRegistry,
} from "./registry";
import type { NodeRegistryState, StoredNodeEntry } from "./registry";
import { createDataSourceResolver } from "./datasource";

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

function makeController(initial?: NodeRegistryState, loginRemote?: Parameters<typeof newLauncherController>[0]["loginRemote"]) {
  const storage = new MemStorage();
  const getLocalBase = () => "";
  const getOrigin = () => "http://127.0.0.1:5999";
  const getLocalToken = vi.fn(() => "local-jwt");
  const controller = newLauncherController({
    storage,
    getLocalBase,
    getOrigin,
    getLocalToken,
    now: () => "2026-10-17T00:00:00.000Z",
    initialRegistry: initial,
    loginRemote,
  });
  return { controller, storage, getLocalToken };
}

const seededWithRemote = () => {
  let s = addLocalNode(emptyRegistry()).state;
  s = addRemoteNode(s, { nodeId: "aaaa1111bbbb", baseURL: "http://nas:3001" }).state;
  return s;
};

describe("deriveActiveDataSource 纯推导", () => {
  it("无活动→null；local 用相对 base+http→ws；remote 用绝对 URL", () => {
    const lb = () => "";
    const og = () => "http://127.0.0.1:5999";
    expect(deriveActiveDataSource(null, null, lb, og)).toBeNull();
    const local = deriveActiveDataSource(
      { kind: "local", nodeId: LOCAL_NODE_ID, baseURL: "", label: null, lastConnectedAt: null },
      "t",
      lb,
      og,
    );
    expect(local).toEqual({
      nodeId: "local",
      kind: "local",
      baseURL: "",
      token: "t",
      wsOrigin: "ws://127.0.0.1:5999",
    });
    const remote = deriveActiveDataSource(
      { kind: "remote", nodeId: "r1", baseURL: "https://s.example/gx", label: null, lastConnectedAt: null },
      "rt",
      lb,
      og,
    );
    expect(remote).toMatchObject({
      nodeId: "r1",
      kind: "remote",
      baseURL: "https://s.example/gx",
      token: "rt",
      wsOrigin: "wss://s.example/gx",
    });
  });
});

describe("新装空态", () => {
  it("无节点、无活动；resolver.current() 回落 local 兜底且可读不抛", () => {
    const { controller } = makeController();
    expect(controller.listNodes()).toEqual([]);
    expect(controller.getActiveNode()).toBeNull();
    const cur = controller.resolver().current();
    expect(cur.kind).toBe("local"); // S1 等价兜底
  });
});

describe("本地节点", () => {
  it("connectLocal 首次：添加+连接，活动数据源=local 带本地 token，desired=running", () => {
    const { controller } = makeController();
    const out = controller.connectLocal();
    expect(out.active?.kind).toBe("local");
    expect(out.active?.token).toBe("local-jwt");
    expect(controller.getState().localDesired).toBe("running");
    expect(controller.resolver().current().nodeId).toBe(LOCAL_NODE_ID);
  });

  it("已添加后 connectLocal 幂等（不再报已存在，仍连上）", () => {
    const { controller } = makeController(seededWithRemote());
    // 当前 active 是远端 id
    const out = controller.connectLocal();
    expect(out.active?.kind).toBe("local");
    expect(controller.listNodes().filter((n) => n.kind === "local")).toHaveLength(1);
  });
});

describe("远端连接 / 切换（连接＝只选路）", () => {
  it("addRemote 不连接；connectRemote 只选路：resolver 切到远端绝对 URL/ws、token=null（remote-empty）并通知订阅者", async () => {
    let notify = 0;
    const login = vi.fn(async () => ({ token: "should-never-login", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    controller.resolver().subscribe(() => {
      notify += 1;
    });

    expect(controller.getActiveNode()).toBeNull();
    const out = await controller.connectRemote("aaaa1111bbbb");
    // 纯选路：绝不调用登录网络动作、绝不写会话分键
    expect(login).not.toHaveBeenCalled();
    expect(controller.getActiveNode()?.nodeId).toBe("aaaa1111bbbb");
    const cur = controller.resolver().current();
    expect(cur.kind).toBe("remote");
    expect(cur.baseURL).toBe("http://nas:3001");
    expect(cur.token).toBeNull();
    expect(cur.wsOrigin).toBe("ws://nas:3001");
    expect(out.active?.token).toBeNull();
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
    expect(notify).toBeGreaterThan(0);
  });

  it("纯选路不吃凭据：传入 creds 也绝不登录、不抛错、仍切到 remote-empty", async () => {
    const login = vi.fn(
      async (_entry: Parameters<RemoteLoginFn>[0], _creds?: Parameters<RemoteLoginFn>[1]) => ({
        token: "remote-jwt",
        user: null,
      }),
    );
    const { controller } = makeController(seededWithRemote(), login);
    const creds = { email: "a@b.c", password: "secret" };
    const out = await controller.connectRemote("aaaa1111bbbb", creds);
    expect(login).not.toHaveBeenCalled();
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBeNull();
  });

  it("已记住会话：纯选路激活的数据源直接带 JWT，仍不调用 loginRemote", async () => {
    const login = vi.fn(async () => ({ token: "should-not-be-used", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    // 预置一份有效会话（模拟上次登录已记住）
    storage.setItem(
      "gx-node-session:aaaa1111bbbb",
      JSON.stringify({ version: 1, token: "saved-rt", user: null }),
    );

    const out = await controller.connectRemote("aaaa1111bbbb"); // 不传凭据
    expect(login).not.toHaveBeenCalled();
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBe("saved-rt");
    expect(controller.getActiveNode()?.nodeId).toBe("aaaa1111bbbb");
  });

  it("目标不是远端/不存在 → 不切换活动，active=null", async () => {
    const { controller } = makeController(seededWithRemote());
    const out = await controller.connectRemote("does-not-exist");
    expect(out.active).toBeNull();
    expect(controller.getActiveNode()).toBeNull();
    expect(controller.resolver().current().kind).toBe("local");
  });

  it("注入 resolver 单例：connectRemote 驱动的是传入的那个 resolver（生产网络层共用）", async () => {
    const storage = new MemStorage();
    const sharedResolver = createDataSourceResolver({
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:5999",
      getLocalToken: () => "local-jwt",
    });
    const controller = newLauncherController({
      storage,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:5999",
      getLocalToken: () => "local-jwt",
      now: () => "2026-10-17T00:00:00.000Z",
      initialRegistry: seededWithRemote(),
      resolver: sharedResolver,
    });
    await controller.connectRemote("aaaa1111bbbb");
    // 启动器控制器的 resolver 与注入的是同一实例，且已切到远端（无会话 → token=null）
    expect(controller.resolver()).toBe(sharedResolver);
    expect(sharedResolver.current().kind).toBe("remote");
    expect(sharedResolver.current().token).toBeNull();
  });

  it("从远端切回本地：活动变 local、远端会话仍保留（切回免登）", async () => {
    const { controller, storage } = makeController(seededWithRemote());
    await controller.connectRemote("aaaa1111bbbb");
    // 远端自己的登录页提交成功后由 activeAuth 调 commitRemoteSession 落分键
    const commit = controller.commitRemoteSession("aaaa1111bbbb", "remote-jwt", null);
    expect(commit.active?.token).toBe("remote-jwt");
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toContain("remote-jwt");
    // 切回本机：远端会话分键原样保留
    controller.connectLocal();
    expect(controller.resolver().current().kind).toBe("local");
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toContain("remote-jwt");
    // 再纯选路到该远端：记住的会话直接带上 JWT，无需重登
    const again = await controller.connectRemote("aaaa1111bbbb");
    expect(again.active?.token).toBe("remote-jwt");
  });
});

describe("远端会话动作（commit/patch/deauthenticate）", () => {
  // 只需覆盖会话视图关心的字段；UserDTO 完整形状由契约测试保证，这里按最小集构造并断言。
  const remoteUser = (): UserDTO =>
    ({
      id: "u1",
      email: "a@b.c",
      displayName: "A",
      mustChangePassword: true,
      updatedAt: "2026-10-17T00:00:00.000Z",
    }) as UserDTO;

  it("commitRemoteSession：活动节点落分键并重推带 token 的数据源（remote-empty → 已登录）", async () => {
    const { controller } = makeController(seededWithRemote());
    await controller.connectRemote("aaaa1111bbbb");
    expect(controller.resolver().current().token).toBeNull();

    const out = controller.commitRemoteSession("aaaa1111bbbb", "jwt-1", remoteUser());
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBe("jwt-1");
    expect(controller.resolver().current().token).toBe("jwt-1");
  });

  it("commitRemoteSession：给非活动节点写会话只记住账号，不动当前活动数据源", () => {
    let s = seededWithRemote();
    s = addRemoteNode(s, { nodeId: "cccc2222dddd", baseURL: "http://office:3001" }).state;
    s = connectNode(s, LOCAL_NODE_ID, "t").state; // 活动是本机
    const storage = new MemStorage();
    const controller = newLauncherController({
      storage,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:5999",
      getLocalToken: () => "local-jwt",
      now: () => "2026-10-17T00:00:00.000Z",
      initialRegistry: s,
    });
    const before = controller.resolver().current();
    const out = controller.commitRemoteSession("cccc2222dddd", "jwt-2", remoteUser());
    // 当前活动仍是本机（local 槽 current() 每次新建对象，只比值不比起用）
    expect(out.active?.kind).toBe("local");
    const after = controller.resolver().current();
    expect(after.kind).toBe(before.kind);
    expect(after.nodeId).toBe(before.nodeId);
    expect(after.token).toBe(before.token);
    // 会话分键已写入：用同 storage + 指向该远端的注册表新建控制器 restore，应免登恢复
    let routed = s;
    routed = connectNode(routed, "cccc2222dddd", "t").state;
    const restored = newLauncherController({
      storage,
      getLocalBase: () => "",
      getOrigin: () => "http://127.0.0.1:5999",
      getLocalToken: () => "local-jwt",
      now: () => "2026-10-17T00:00:00.000Z",
      initialRegistry: routed,
    });
    const r = restored.restore();
    expect(r.active?.kind).toBe("remote");
    expect(r.active?.token).toBe("jwt-2");
  });

  it("patchRemoteSessionUser：改密 me() 失败兜底，仅合并 user 字段、token 沿用", async () => {
    const { controller, storage } = makeController(seededWithRemote());
    controller.commitRemoteSession("aaaa1111bbbb", "jwt-1", remoteUser());
    controller.patchRemoteSessionUser("aaaa1111bbbb", { mustChangePassword: false });
    const raw = JSON.parse(storage.getItem("gx-node-session:aaaa1111bbbb") as string);
    expect(raw.token).toBe("jwt-1");
    expect(raw.user.mustChangePassword).toBe(false);
    expect(raw.user.id).toBe("u1");
  });

  it("patchRemoteSessionUser：无会话/无 user 时 no-op，不抛错", () => {
    const { controller, storage } = makeController(seededWithRemote());
    expect(() =>
      controller.patchRemoteSessionUser("aaaa1111bbbb", { mustChangePassword: false }),
    ).not.toThrow();
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
  });

  it("deauthenticateRemote：清该远端会话但保持选路态——活动仍指该远端、token=null（remote-empty）", async () => {
    const { controller, storage } = makeController(seededWithRemote());
    await controller.connectRemote("aaaa1111bbbb");
    controller.commitRemoteSession("aaaa1111bbbb", "jwt-1", remoteUser());
    expect(controller.resolver().current().token).toBe("jwt-1");

    const out = controller.deauthenticateRemote("aaaa1111bbbb");
    // 不 regDisconnect：activeNodeId 仍是该远端
    expect(controller.getActiveNode()?.nodeId).toBe("aaaa1111bbbb");
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBeNull();
    expect(controller.resolver().current().token).toBeNull();
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
  });
});

describe("断开 / 删除", () => {
  it("disconnect 远端：清其会话，活动回落（resolver 回 local 兜底）", async () => {
    const login = vi.fn(async () => ({ token: "rt", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    await controller.connectRemote("aaaa1111bbbb");
    const out = controller.disconnect("aaaa1111bbbb");
    expect(out.active).toBeNull();
    expect(controller.getActiveNode()).toBeNull();
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
    expect(controller.resolver().current().kind).toBe("local"); // 兜底
  });

  it("disconnect 本地：desired=stopped、无活动、条目保留", () => {
    let s = seededWithRemote();
    s = connectNode(s, LOCAL_NODE_ID, "t").state;
    const { controller } = makeController(s);
    const out = controller.disconnect(LOCAL_NODE_ID);
    expect(out.active).toBeNull();
    expect(controller.getState().localDesired).toBe("stopped");
    expect(controller.listNodes().some((n) => n.kind === "local")).toBe(true);
  });

  it("removeRemote 清会话并移除条目", async () => {
    const login = vi.fn(async () => ({ token: "rt", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    await controller.connectRemote("aaaa1111bbbb");
    controller.removeRemote("aaaa1111bbbb");
    expect(controller.getNode("aaaa1111bbbb")).toBeNull();
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
  });
});

describe("独立启停的注册表动作（W2）", () => {
  it("ensureLocalRegistered：空册出现 local 条目、desired=running，但 activeNodeId 仍 null", () => {
    const { controller } = makeController();
    const next = controller.ensureLocalRegistered();
    expect(next.entries.filter((e) => e.kind === "local")).toHaveLength(1);
    expect(next.localDesired).toBe("running");
    expect(next.activeNodeId).toBeNull();
    expect(controller.getActiveNode()).toBeNull();
    // 不驱动 resolver（仍回落 local 兜底，但没有活动条目）
    expect(controller.getState().activeNodeId).toBeNull();
  });

  it("ensureLocalRegistered：已有 local 时幂等，返回同一 state 引用", () => {
    const { controller } = makeController(seededWithRemote());
    const before = controller.getState();
    const next = controller.ensureLocalRegistered();
    expect(next).toBe(before);
    expect(next.entries.filter((e) => e.kind === "local")).toHaveLength(1);
  });

  it("setLocalDesiredOnly：只改 desired，activeNodeId/resolver 不动", () => {
    let s = addLocalNode(emptyRegistry()).state;
    s = connectNode(s, LOCAL_NODE_ID, "t").state; // active=local、desired=running
    const { controller } = makeController(s);
    const next = controller.setLocalDesiredOnly("stopped");
    expect(next.localDesired).toBe("stopped");
    // active 指针与 resolver 都仍指向 local（停止进程不等于断开活动数据源）
    expect(next.activeNodeId).toBe(LOCAL_NODE_ID);
    expect(controller.resolver().current().nodeId).toBe(LOCAL_NODE_ID);
  });

  it("setLocalDesiredOnly：无 local 条目时安全 no-op", () => {
    const { controller } = makeController();
    const before = controller.getState();
    expect(controller.setLocalDesiredOnly("stopped")).toBe(before);
    expect(before.localDesired).toBeNull();
  });
});

describe("跨重启 restore", () => {
  it("活动远端且会话已存 → restore 重建远端数据源（免登）", () => {
    let s = seededWithRemote();
    s = connectNode(s, "aaaa1111bbbb", "t").state;
    const { controller, storage } = makeController(s);
    storage.setItem(
      "gx-node-session:aaaa1111bbbb",
      JSON.stringify({ version: 1, token: "saved-rt", user: null }),
    );
    const out = controller.restore();
    expect(out.active?.kind).toBe("remote");
    expect(out.active?.token).toBe("saved-rt");
    expect(controller.resolver().current().nodeId).toBe("aaaa1111bbbb");
  });

  it("活动远端但无已存会话（未记住）→ 不自动连，active=null", () => {
    let s = seededWithRemote();
    s = connectNode(s, "aaaa1111bbbb", "t").state;
    const { controller } = makeController(s);
    const out = controller.restore();
    expect(out.active).toBeNull();
  });

  it("活动本地 → restore 重建 local 数据源（带当前 gx-auth token）", () => {
    let s = seededWithRemote();
    s = connectNode(s, LOCAL_NODE_ID, "t").state;
    const { controller } = makeController(s);
    const out = controller.restore();
    expect(out.active?.kind).toBe("local");
    expect(out.active?.token).toBe("local-jwt");
  });
});

// ── 离线副本（第三入口 2a）：账号/令牌按 nodeId 与主库分流，传输仍 kind:local ─────────────

const replicaEntry = (nodeId: string): StoredNodeEntry => ({
  kind: "local",
  role: "replica",
  nodeId,
  baseURL: "",
  label: "办公室副本",
  lastConnectedAt: null,
  replica: { remoteBaseUrl: "http://nas:3001", clientId: null, syncIntervalMs: null },
});

/** 注册表：仅一个副本、无主库。 */
function replicaOnlyState(nodeId = "office-1"): NodeRegistryState {
  return addReplicaNode(emptyRegistry(), { nodeId, remoteBaseUrl: "http://nas:3001" }).state;
}
/** 注册表：主库 + 一个副本（active 可分别指向）。 */
function primaryAndReplicaState(nodeId = "office-1"): NodeRegistryState {
  const withPrimary = addLocalNode(emptyRegistry()).state;
  return addReplicaNode(withPrimary, { nodeId, remoteBaseUrl: "http://nas:3001" }).state;
}

describe("deriveActiveDataSource 副本（非壳构建器）", () => {
  it("replica：nodeId 保留副本名、kind='local'、baseURL=''、wsOrigin 回落页面 origin，不被改成 local", () => {
    const lb = () => "/app/gouxiangdb"; // 即便注入本地子路径前缀，副本也不使用（恒同源根）
    const og = () => "http://127.0.0.1:5999";
    const ds = deriveActiveDataSource(replicaEntry("office-1"), "rep-jwt", lb, og);
    expect(ds).toEqual({
      nodeId: "office-1",
      kind: "local",
      baseURL: "",
      token: "rep-jwt",
      wsOrigin: "ws://127.0.0.1:5999",
    });
  });
});

describe("applyActive 副本：冷启动 fail-closed、在线空令牌可激活，绝不读 gx-auth", () => {
  it("冷启动 restore() 无分键会话 → fail-closed 不激活（active=null），绝不自动连入副本", () => {
    // 注册表只有副本、active=副本（模拟上次退出时停在副本；store 层另会在构造前把 activeNodeId 归一化 null）。
    let s = replicaOnlyState();
    s = connectNode(s, "office-1", "t").state;
    const { controller } = makeController(s); // getLocalToken 恒 "local-jwt"
    // restore 走 applyActive(state) 默认 allowEmptyRemote=false：副本无会话必须 fail-closed。
    const out = controller.restore();
    expect(out.active).toBeNull();
    expect(controller.getActiveNode()?.nodeId).toBe("office-1"); // 注册表活动指针未被 restore 改写
    // 但在线显式 connectNodeById(true) 允许空令牌激活进副本自己的登录引导：
    const online = controller.connectNodeById("office-1");
    expect(online.active).not.toBeNull();
    expect(online.active?.nodeId).toBe("office-1");
    expect(online.active?.kind).toBe("local");
    expect(online.active?.token).toBeNull(); // 不是 "local-jwt"！证明在线空激活也不串主库令牌
  });

  it("主库 gx-auth 有 token 但副本分键为空：restore fail-closed，在线选路空令牌仍可激活", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller } = makeController(s);
    // 冷启动：即使主库 gx-auth 有 token，副本无自己的分键会话也不激活。
    expect(controller.restore().active).toBeNull();
    // 在线纯选路：副本空令牌槽（token=null），绝不拿主库 gx-auth 顶替。
    const online = controller.connectNodeById("office-1");
    expect(online.active?.nodeId).toBe("office-1");
    expect(online.active?.token).toBeNull();
  });

  it("restore() 副本有自己分键会话 → 正常激活并带该 token（不读 gx-auth）", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller, storage, getLocalToken } = makeController(s);
    // 预置副本自己的分键会话（信封 version:1；冷启动唯一应自动激活副本的情形）。
    storage.setItem(
      "gx-node-session:office-1",
      JSON.stringify({ version: 1, token: "rep-jwt", user: null }),
    );
    const out = controller.restore();
    expect(out.active?.nodeId).toBe("office-1");
    expect(out.active?.token).toBe("rep-jwt");
    expect(getLocalToken).not.toHaveBeenCalled(); // 副本 derive 不读 gx-auth
  });

  it("commitRemoteSession(副本名) 写 gx-node-session:<副本名>，随后活动副本 ds 带该 token；主库 gx-auth 不受影响", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller, storage, getLocalToken } = makeController(s);
    const out = controller.commitRemoteSession("office-1", "rep-jwt", null);
    expect(out.active?.nodeId).toBe("office-1");
    expect(out.active?.token).toBe("rep-jwt");
    expect(storage.getItem("gx-node-session:office-1")).toContain("rep-jwt");
    // 主库 gx-auth 是注入的 getLocalToken（本测试内存里不存在 gx-auth 键），副本写绝不动它
    expect(getLocalToken).not.toHaveBeenCalled(); // 副本 derive 不读 gx-auth
  });

  it("refreshActiveLocal：活动是副本时返回 null，且数据源 token 不随 gx-auth 变化", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller } = makeController(s);
    expect(controller.getActiveNode()?.nodeId).toBe("office-1");
    const before = controller.resolver().current().token;
    expect(controller.refreshActiveLocal()).toBeNull();
    expect(controller.resolver().current().token).toBe(before);
  });
});

describe("connectNodeById / connectLocal 在'仅副本无主库'下的主库补建", () => {
  it("connectNodeById(副本名)：纯选路激活副本（空 token），不补建主库", () => {
    const { controller } = makeController(replicaOnlyState());
    const out = controller.connectNodeById("office-1");
    expect(out.active?.nodeId).toBe("office-1");
    expect(out.active?.kind).toBe("local");
    expect(out.active?.token).toBeNull();
    expect(controller.getState().entries.some((e) => e.nodeId === LOCAL_NODE_ID)).toBe(false);
  });

  it("connectNodeById 未知节点 → active=null 不切换", () => {
    const { controller } = makeController(replicaOnlyState());
    expect(controller.connectNodeById("nope").active).toBeNull();
  });

  it("仅副本注册表里 connectLocal/ensureLocalRegistered/setLocalDesiredOnly 仍会补建/识别 primary", () => {
    const { controller } = makeController(replicaOnlyState());
    // ensureLocalRegistered：只有副本时应补建主库
    const ensured = controller.ensureLocalRegistered();
    expect(ensured.entries.filter((e) => e.kind === "local")).toHaveLength(2); // 主库 + 副本
    expect(ensured.localDesired).toBe("running");

    // 新控制器（仅副本）验证 setLocalDesiredOnly 无主库时 no-op，补建后才生效
    const c2 = makeController(replicaOnlyState()).controller;
    expect(c2.setLocalDesiredOnly("stopped").localDesired).toBeNull(); // 无主库 no-op
    const out = c2.connectLocal(); // 补建主库并连接
    expect(out.active?.nodeId).toBe(LOCAL_NODE_ID);
    expect(c2.getState().localDesired).toBe("running");
    // 副本条目仍在
    expect(c2.getNode("office-1")?.role).toBe("replica");
  });
});

describe("副本 disconnect / remove 清其分键、不动主库", () => {
  it("disconnect 副本：清 gx-node-session:副本名，活动回落；主库条目/期望态不受影响", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller, storage } = makeController(s);
    controller.commitRemoteSession("office-1", "rep-jwt", null);
    expect(storage.getItem("gx-node-session:office-1")).toContain("rep-jwt");
    const out = controller.disconnect("office-1");
    expect(out.active).toBeNull();
    expect(storage.getItem("gx-node-session:office-1")).toBeNull();
    // 主库仍在、其期望态不被副本断开改动（连副本本就不改 localDesired）
    expect(controller.getNode(LOCAL_NODE_ID)?.role).toBe("primary");
  });

  it("removeRemote(副本名)：移除副本条目并清分键；主库不可删", () => {
    const s = primaryAndReplicaState();
    const { controller, storage } = makeController(s);
    controller.commitRemoteSession("office-1", "rep-jwt", null);
    controller.removeRemote("office-1");
    expect(controller.getNode("office-1")).toBeNull();
    expect(storage.getItem("gx-node-session:office-1")).toBeNull();
    expect(controller.getNode(LOCAL_NODE_ID)).not.toBeNull(); // 主库保留
  });

  it("deauthenticateRemote(副本名)：清副本分键但保持选路态（仍指副本、token=null）", () => {
    let s = primaryAndReplicaState();
    s = connectNode(s, "office-1", "t").state;
    const { controller, storage } = makeController(s);
    controller.commitRemoteSession("office-1", "rep-jwt", null);
    const out = controller.deauthenticateRemote("office-1");
    expect(controller.getActiveNode()?.nodeId).toBe("office-1"); // 不 regDisconnect
    expect(out.active?.nodeId).toBe("office-1");
    expect(out.active?.token).toBeNull();
    expect(storage.getItem("gx-node-session:office-1")).toBeNull();
  });
});

describe("controller.addReplica：仅入册、不自动激活", () => {
  it("成功返回新建副本条目（kind=local/role=replica/baseURL 空），但 activeNodeId 不变、resolver 不切", () => {
    const { controller } = makeController(primaryAndReplicaState()); // 已含主库 + office-1
    expect(controller.getState().activeNodeId).toBeNull(); // 初始无活动
    const created = controller.addReplica({
      nodeId: "branch-2",
      label: "分公司副本",
      remoteBaseUrl: "https://nas.example.com:3001/sub/path", // 子路径应被剥成裸 origin
    });
    expect(created.role).toBe("replica");
    expect(created.kind).toBe("local");
    expect(created.nodeId).toBe("branch-2");
    expect(created.baseURL).toBe("");
    expect(created.replica?.remoteBaseUrl).toBe("https://nas.example.com:3001");
    // 不自动激活：注册表活动指针仍为 null，活动数据源不被改成新副本。
    expect(controller.getState().activeNodeId).toBeNull();
    expect(controller.getActiveNode()).toBeNull();
  });

  it("重名 / 非法 id / 非法远端地址 → throw 中文 Error，state 不变", () => {
    const { controller } = makeController(replicaOnlyState());
    const entriesBefore = controller.getState().entries.length;
    expect(() =>
      controller.addReplica({ nodeId: "office-1", remoteBaseUrl: "http://nas:3001" }),
    ).toThrowError(/同名副本/);
    expect(() =>
      controller.addReplica({ nodeId: "bad/id", remoteBaseUrl: "http://nas:3001" }),
    ).toThrowError();
    // 含裸空格的地址必无法规范化（REPLICA_REMOTE_INVALID）。
    expect(() =>
      controller.addReplica({ nodeId: "branch-9", remoteBaseUrl: "http://bad host:3001" }),
    ).toThrowError();
    expect(controller.getState().entries).toHaveLength(entriesBefore);
  });
});

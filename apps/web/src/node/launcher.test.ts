// launcher.ts 测试（纯 node：注入内存存储、假登录、固定 local base/token/origin）。
// 锁定：新装空态 resolver 回落 local 兜底；添加并连接本地→活动数据源 local；
// 添加+连接远端→登录落会话、resolver 切到远端绝对 URL/ws；切换清缓存由订阅触发；
// 断开本地=stopped 且无活动；远端登录失败不切换；restore 按已存会话恢复、无会话不自动连。

import { describe, it, expect, vi } from "vitest";
import { newLauncherController, deriveActiveDataSource } from "./launcher";
import type { KvStorage } from "./remoteSessions";
import { LOCAL_NODE_ID } from "./resolve";
import { addLocalNode, connectNode, addRemoteNode, emptyRegistry } from "./registry";
import type { NodeRegistryState } from "./registry";
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

describe("远端连接 / 切换", () => {
  it("addRemote 不连接；connectRemote 跑登录、落会话、resolver 切到远端并通知订阅者", async () => {
    let notify = 0;
    const login = vi.fn(async () => ({ token: "remote-jwt", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    controller.resolver().subscribe(() => {
      notify += 1;
    });

    expect(controller.getActiveNode()).toBeNull();
    await controller.connectRemote("aaaa1111bbbb");
    expect(login).toHaveBeenCalledOnce();
    expect(controller.getActiveNode()?.nodeId).toBe("aaaa1111bbbb");
    const cur = controller.resolver().current();
    expect(cur.kind).toBe("remote");
    expect(cur.baseURL).toBe("http://nas:3001");
    expect(cur.token).toBe("remote-jwt");
    expect(cur.wsOrigin).toBe("ws://nas:3001");
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toContain("remote-jwt");
    expect(notify).toBeGreaterThan(0);
  });

  it("登录失败 throw → 不切换活动、不写会话", async () => {
    const login = vi.fn(async () => {
      throw new Error("401");
    });
    const { controller, storage } = makeController(seededWithRemote(), login);
    await expect(controller.connectRemote("aaaa1111bbbb")).rejects.toThrow("401");
    expect(controller.getActiveNode()).toBeNull();
    expect(controller.resolver().current().kind).toBe("local");
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toBeNull();
  });

  it("无已存会话：当次凭据原样透传给 loginRemote", async () => {
    const login = vi.fn(async () => ({ token: "remote-jwt", user: null }));
    const { controller } = makeController(seededWithRemote(), login);
    const creds = { email: "a@b.c", password: "secret" };
    await controller.connectRemote("aaaa1111bbbb", creds);
    expect(login).toHaveBeenCalledOnce();
    const [entryArg, credsArg] = login.mock.calls[0]!;
    expect(entryArg.baseURL).toBe("http://nas:3001");
    expect(credsArg).toBe(creds);
  });

  it("已存会话（跨重启记住/断开未删）：免密直连，不调用 loginRemote", async () => {
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

  it("注入 resolver 单例：connectRemote 驱动的是传入的那个 resolver（生产网络层共用）", async () => {
    const login = vi.fn(async () => ({ token: "rt", user: null }));
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
      loginRemote: login,
      resolver: sharedResolver,
    });
    await controller.connectRemote("aaaa1111bbbb");
    // 启动器控制器的 resolver 与注入的是同一实例，且已切到远端
    expect(controller.resolver()).toBe(sharedResolver);
    expect(sharedResolver.current().kind).toBe("remote");
    expect(sharedResolver.current().token).toBe("rt");
  });

  it("从远端切回本地：活动变 local、远端会话仍保留（切回免登）", async () => {
    const login = vi.fn(async () => ({ token: "remote-jwt", user: null }));
    const { controller, storage } = makeController(seededWithRemote(), login);
    await controller.connectRemote("aaaa1111bbbb");
    controller.connectLocal();
    expect(controller.resolver().current().kind).toBe("local");
    expect(storage.getItem("gx-node-session:aaaa1111bbbb")).toContain("remote-jwt"); // 保留
    // 再连远端：已有会话时即使不重登也能 restore；这里 connect 仍走 login（在线刷新），但可断开后 restore
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

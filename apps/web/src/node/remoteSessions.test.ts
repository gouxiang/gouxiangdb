// remoteSessions.ts 测试（纯 node，注入内存 fake Storage，无 jsdom）。
// 锁定：远端按 nodeId 分键隔离 / 切走保留切回可读 / 绝不触碰本地 local / 脏数据 fail-closed /
// 空 token 拒写 / 批量清点与清理只认给定 nodeId。

import { describe, it, expect } from "vitest";
import type { UserDTO } from "@gx/shared-types";
import {
  REMOTE_SESSION_KEY_PREFIX,
  remoteSessionKey,
  parseRemoteSession,
  readRemoteSession,
  writeRemoteSession,
  clearRemoteSession,
  readAllRemoteSessions,
  clearAllRemoteSessions,
  type KvStorage,
} from "./remoteSessions";

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

const userA = { id: "u1", name: "A", email: "a@x.com" } as unknown as UserDTO;

describe("分键命名与 local 隔离", () => {
  it("远端键 = gx-node-session:<nodeId>", () => {
    expect(remoteSessionKey("abc123")).toBe(`${REMOTE_SESSION_KEY_PREFIX}:abc123`);
  });

  it("非法 nodeId 抛错", () => {
    expect(() => remoteSessionKey("")).toThrow();
    // @ts-expect-error 运行时非字符串
    expect(() => remoteSessionKey(undefined)).toThrow();
  });

  it("local 永远不能进远端会话存储（读键/写视图都拒）", () => {
    const store = new MemStorage();
    expect(() => remoteSessionKey("local")).toThrow();
    expect(() => writeRemoteSession(store, { nodeId: "local", token: "x", user: null })).toThrow();
  });
});

describe("写入/读取：按 nodeId 隔离、切走保留", () => {
  it("两个远端各存各的，互不覆盖，可分别读回", () => {
    const store = new MemStorage();
    writeRemoteSession(store, { nodeId: "aaaa", token: "tok-a", user: userA });
    writeRemoteSession(store, { nodeId: "bbbb", token: "tok-b", user: null });
    expect(readRemoteSession(store, "aaaa")?.token).toBe("tok-a");
    expect(readRemoteSession(store, "aaaa")?.user).toEqual(userA);
    expect(readRemoteSession(store, "bbbb")?.token).toBe("tok-b");
    // 切走再切回：数据仍在（免重登）
    expect(store.m.size).toBe(2);
  });

  it("空 token 拒写（避免落无效会话）", () => {
    const store = new MemStorage();
    expect(() => writeRemoteSession(store, { nodeId: "aaaa", token: "", user: null })).toThrow();
    expect(readRemoteSession(store, "aaaa")).toBeNull();
  });
});

describe("清除", () => {
  it("clearRemoteSession 只清指定节点", () => {
    const store = new MemStorage();
    writeRemoteSession(store, { nodeId: "aaaa", token: "ta", user: null });
    writeRemoteSession(store, { nodeId: "bbbb", token: "tb", user: null });
    clearRemoteSession(store, "aaaa");
    expect(readRemoteSession(store, "aaaa")).toBeNull();
    expect(readRemoteSession(store, "bbbb")?.token).toBe("tb");
  });

  it("clearAllRemoteSessions 清给定节点，跳过 local 名且不碰其它未知键", () => {
    const store = new MemStorage();
    writeRemoteSession(store, { nodeId: "aaaa", token: "ta", user: null });
    writeRemoteSession(store, { nodeId: "bbbb", token: "tb", user: null });
    store.setItem("gx-auth", '{"state":{"token":"LOCAL"}}'); // 本地真相源，绝不能被清
    clearAllRemoteSessions(store, ["aaaa", "bbbb", "local"]);
    expect(readRemoteSession(store, "aaaa")).toBeNull();
    expect(readRemoteSession(store, "bbbb")).toBeNull();
    expect(store.getItem("gx-auth")).toBe('{"state":{"token":"LOCAL"}}');
  });
});

describe("批量清点 readAllRemoteSessions", () => {
  it("只解析给定远端 nodeId，忽略 local 与未提供的节点", () => {
    const store = new MemStorage();
    writeRemoteSession(store, { nodeId: "aaaa", token: "ta", user: null });
    writeRemoteSession(store, { nodeId: "bbbb", token: "tb", user: null });
    writeRemoteSession(store, { nodeId: "cccc", token: "tc", user: null });
    const got = readAllRemoteSessions(store, ["aaaa", "bbbb", "local"]);
    expect(got.map((g) => g.nodeId).sort()).toEqual(["aaaa", "bbbb"]);
  });

  it("脏条目被跳过不炸", () => {
    const store = new MemStorage();
    writeRemoteSession(store, { nodeId: "aaaa", token: "ta", user: null });
    store.setItem(remoteSessionKey("bbbb"), "{broken");
    const got = readAllRemoteSessions(store, ["aaaa", "bbbb"]);
    expect(got.map((g) => g.nodeId)).toEqual(["aaaa"]);
  });
});

describe("parseRemoteSession fail-closed", () => {
  it("null/空/非法 JSON/错 version/空 token/非对象 → null", () => {
    expect(parseRemoteSession("n", null)).toBeNull();
    expect(parseRemoteSession("n", "")).toBeNull();
    expect(parseRemoteSession("n", "xxx")).toBeNull();
    expect(parseRemoteSession("n", "[]")).toBeNull();
    expect(parseRemoteSession("n", JSON.stringify({ version: 9, token: "t" }))).toBeNull();
    expect(parseRemoteSession("n", JSON.stringify({ version: 1, token: "" }))).toBeNull();
    expect(parseRemoteSession("n", JSON.stringify({ version: 1, token: 123 }))).toBeNull();
  });

  it("合法（含 user=null）解析回视图并钉住 nodeId", () => {
    const v = parseRemoteSession("n9", JSON.stringify({ version: 1, token: "t", user: null }));
    expect(v).toEqual({ nodeId: "n9", token: "t", user: null });
  });
});

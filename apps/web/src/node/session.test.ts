// session.ts 测试（纯 node、无 jsdom、无新依赖）。
// S1 只锁：键名常量与 store/auth.ts 实际 persist 键逐字节一致、槽位判定/键映射纯函数、
// 远端槽内存占位恒 null、隔离不变量。**不**在此持久化本地 token（单一真相源是 auth store）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LOCAL_SESSION_STORAGE_KEY,
  REMOTE_SESSION_STORAGE_KEY,
  NODE_PROFILES_STORAGE_KEY,
  getRemoteSession,
  isLocalNodeId,
  slotForNodeId,
  storageKeyForSlot,
  sessionsOccupyDistinctSlots,
  type NodeSession,
} from "./session";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const localSession: NodeSession = {
  nodeId: "local",
  baseURL: "",
  token: "local-jwt",
  user: null,
};
const remoteSession: NodeSession = {
  nodeId: "abcdef012345",
  baseURL: "http://remote:3001",
  token: "remote-jwt",
  user: null,
};

describe("本地槽键名与 store/auth.ts 实际 persist 键一致（防两套键）", () => {
  it('常量 === "gx-auth"', () => {
    expect(LOCAL_SESSION_STORAGE_KEY).toBe("gx-auth");
  });

  it("store/auth.ts 源码确实以同名 persist 落盘（源码断言）", () => {
    const src = read("../store/auth.ts");
    expect(src).toContain(`name: "${LOCAL_SESSION_STORAGE_KEY}"`);
    expect(src).toContain('name: "gx-auth"');
  });
});

describe("存储键常量（远端/档案预留，互不相同且不撞本地键）", () => {
  it("远端会话键 = gx-node-session", () => {
    expect(REMOTE_SESSION_STORAGE_KEY).toBe("gx-node-session");
  });

  it("档案键 = gx-node-profiles", () => {
    expect(NODE_PROFILES_STORAGE_KEY).toBe("gx-node-profiles");
  });

  it("三键两两不同（杜绝串槽/覆盖）", () => {
    const keys = [
      LOCAL_SESSION_STORAGE_KEY,
      REMOTE_SESSION_STORAGE_KEY,
      NODE_PROFILES_STORAGE_KEY,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("槽位判定纯函数", () => {
  it("isLocalNodeId：仅固定 local id 为真", () => {
    expect(isLocalNodeId("local")).toBe(true);
    expect(isLocalNodeId("abcdef012345")).toBe(false);
    expect(isLocalNodeId("")).toBe(false);
  });

  it("slotForNodeId：local→local，其余→remote", () => {
    expect(slotForNodeId("local")).toBe("local");
    expect(slotForNodeId("abcdef012345")).toBe("remote");
  });

  it("storageKeyForSlot：两槽映射到各自键，绝不共用", () => {
    expect(storageKeyForSlot("local")).toBe("gx-auth");
    expect(storageKeyForSlot("remote")).toBe("gx-node-session");
    expect(storageKeyForSlot("local")).not.toBe(storageKeyForSlot("remote"));
  });
});

describe("远端槽 S1 内存占位", () => {
  it("getRemoteSession() 恒为 null（本阶段无任何写入出口）", () => {
    expect(getRemoteSession()).toBeNull();
  });
});

describe("隔离不变量 sessionsOccupyDistinctSlots（DESIGN §10.2）", () => {
  it("local 与 remote 不同 nodeId → 可区分", () => {
    expect(sessionsOccupyDistinctSlots(localSession, remoteSession)).toBe(true);
  });

  it("两个相同 nodeId 会话 → 视为串槽，返回 false", () => {
    expect(
      sessionsOccupyDistinctSlots({ ...remoteSession }, { ...remoteSession }),
    ).toBe(false);
  });

  it("两个 local 会话也判为重叠（同槽不可同时持有两份）", () => {
    expect(sessionsOccupyDistinctSlots(localSession, { ...localSession })).toBe(false);
  });
});

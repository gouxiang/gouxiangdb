// apps/web/src/features/collab/__tests__/lease-registry.test.ts
// 块级租约的正确性回归。三条释放路径（显式释放 / 超时释放 / awareness 消失即释放）与
// 多声明者的确定性裁决是这个软锁能不能用的全部前提，缺一条就会出现幽灵锁或双头编辑。

import { beforeEach, describe, expect, it } from "vitest";
import type { CollabLease, CollabPresenceEntry } from "@gx/shared-types";
import {
  LEASE_TTL_MS,
  getLeaseRegistry,
  resetLeaseRegistry,
  type LeaseHolder,
} from "../lease-registry";

const NOW = 1_700_000_000_000;

function lease(unit: string, sinceOffset = 0): CollabLease {
  return { unit, since: NOW + sinceOffset, expiresAt: NOW + LEASE_TTL_MS };
}

function peer(id: string, leases: CollabLease[], nick = id): CollabPresenceEntry {
  return {
    id,
    kind: "user",
    userId: `u-${id}`,
    nick,
    color: "#3A6DF0",
    selection: null,
    leases,
    role: "editor",
  };
}

describe("lease-registry", () => {
  beforeEach(() => {
    resetLeaseRegistry();
  });

  it("getLeaseRegistry 是同一个对象（单例语义：跨组件/跨实例共享）", () => {
    expect(getLeaseRegistry()).toBe(getLeaseRegistry());
  });

  it("acquire → holderOf 命中且标记为 self", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    const holder = r.holderOf("b1", NOW);
    expect(holder?.self).toBe(true);
    expect(holder?.unit).toBe("b1");
  });

  it("release 后不再有人占用", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    r.release("b1");
    expect(r.holderOf("b1", NOW)).toBeNull();
  });

  it("releaseAll 清空全部本地租约", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    r.acquire("b2", NOW);
    r.releaseAll();
    expect(r.heldUnits(NOW).size).toBe(0);
  });

  it("acquire 幂等：重复调用只续期，since 保持不变（since 是裁决依据，必须稳定）", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    const first = r.holderOf("b1", NOW)!;
    r.acquire("b1", NOW + 5_000);
    const second = r.holderOf("b1", NOW + 5_000)!;
    expect(second.since).toBe(first.since);
    expect(second.expiresAt).toBe(NOW + 5_000 + LEASE_TTL_MS);
  });

  it("重点：超时释放 —— 超过 30s 未续约即自动解除（对方断线/不续约的兜底）", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    expect(r.holderOf("b1", NOW + LEASE_TTL_MS - 1)).not.toBeNull();
    expect(r.holderOf("b1", NOW + LEASE_TTL_MS + 1)).toBeNull();
  });

  it("sweep：过期返回 true 并清除；未过期返回 false", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    expect(r.sweep(NOW + 1_000)).toBe(false);
    expect(r.sweep(NOW + LEASE_TTL_MS + 1)).toBe(true);
    expect(r.holderOf("b1", NOW + LEASE_TTL_MS + 1)).toBeNull();
  });

  it("单个 peer 的租约 → holderOf 返回该 peer，nick/color 取自 entry", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p1", [lease("b1")], "张三")], NOW);
    const holder = r.holderOf("b1", NOW) as LeaseHolder;
    expect(holder.self).toBe(false);
    expect(holder.id).toBe("p1");
    expect(holder.nick).toBe("张三");
    expect(holder.color).toBe("#3A6DF0");
  });

  it("重点：多声明者裁决 —— since 小者胜（两端必须得出同一胜者）", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p-fast", [lease("b1", 0)]), peer("p-slow", [lease("b1", 5_000)])], NOW);
    expect(r.holderOf("b1", NOW)?.id).toBe("p-fast");
  });

  it("重点：since 相同时按 id 字典序裁决（无需时钟同步的确定性兜底）", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p-z", [lease("b1", 0)]), peer("p-a", [lease("b1", 0)])], NOW);
    expect(r.holderOf("b1", NOW)?.id).toBe("p-a");
  });

  it("重点：awareness 消失即释放：peer 从名单里消失，租约随之消失（无需服务端解锁消息）", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p1", [lease("b1")])], NOW);
    expect(r.holderOf("b1", NOW)?.id).toBe("p1");
    r.syncRemote([], NOW);
    expect(r.holderOf("b1", NOW)).toBeNull();
  });

  it("本地优先：即使远端也声明了同一单元，仍判给本地自己", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    r.syncRemote([peer("p1", [lease("b1")])], NOW);
    expect(r.holderOf("b1", NOW)?.self).toBe(true);
  });

  it("本地释放后，远端声明者接管", () => {
    const r = getLeaseRegistry();
    r.acquire("b1", NOW);
    r.syncRemote([peer("p1", [lease("b1")])], NOW);
    r.release("b1");
    expect(r.holderOf("b1", NOW)?.id).toBe("p1");
  });

  it("已过期的远端租约不参与占用", () => {
    const r = getLeaseRegistry();
    const stale: CollabLease = { unit: "b1", since: NOW - 100_000, expiresAt: NOW - 1 };
    r.syncRemote([peer("p1", [stale])], NOW);
    expect(r.holderOf("b1", NOW)).toBeNull();
  });

  it("远端租约超时后自动解除", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p1", [lease("b1")])], NOW);
    expect(r.holderOf("b1", NOW + LEASE_TTL_MS + 1)).toBeNull();
  });

  it("heldUnits 返回所有被占用单元，且本地覆盖远端", () => {
    const r = getLeaseRegistry();
    r.syncRemote([peer("p1", [lease("b1"), lease("b2")])], NOW);
    r.acquire("b2", NOW);
    const units = r.heldUnits(NOW);
    expect(units.get("b1")?.self).toBe(false);
    expect(units.get("b2")?.self).toBe(true);
  });

  it("订阅者只在真的变化时被打扰", () => {
    const r = getLeaseRegistry();
    let calls = 0;
    const stop = r.subscribe(() => (calls += 1));

    r.acquire("b1", NOW);
    expect(calls).toBe(1);

    // 同样的名单重复灌入 → 无变化 → 不通知（否则渲染层会空转）
    r.syncRemote([peer("p1", [lease("b2")])], NOW);
    expect(calls).toBe(2);
    r.syncRemote([peer("p1", [lease("b2")])], NOW);
    expect(calls).toBe(2);

    // 未过期时 sweep 也不该通知
    expect(r.sweep(NOW + 1_000)).toBe(false);
    expect(calls).toBe(2);

    r.release("b1");
    expect(calls).toBe(3);

    stop();
    r.acquire("b3", NOW);
    expect(calls).toBe(3);
  });

  it("unsubscribe 幂等且退订后不再收到通知", () => {
    const r = getLeaseRegistry();
    let calls = 0;
    const stop = r.subscribe(() => (calls += 1));
    stop();
    stop();
    r.acquire("b1", NOW);
    expect(calls).toBe(0);
  });
});

// useHasActiveNode 纯判定单测（node 环境）。
//
// 锁的是 2026-10-19 修的「断开当前活动节点后卡死业务页」死锁：
// 壳内必须以注册表 activeNodeId 为「连着节点」的唯一事实；门控关/非壳则 fail-open 恒 true，
// 浏览器/fnOS 现网零变化（不引入活动节点概念）。
import { describe, it, expect } from "vitest";
import { hasActiveNodeFor, isNodeGateExemptPath } from "./useHasActiveNode";
import { emptyRegistry } from "./registry";

describe("hasActiveNodeFor（活动节点守卫纯判定）", () => {
  it("门控关：无论是否在壳/有无活动节点，恒 true（现网浏览器/fnOS fail-open）", () => {
    expect(hasActiveNodeFor(false, false, emptyRegistry())).toBe(true);
    expect(hasActiveNodeFor(false, true, emptyRegistry())).toBe(true);
    expect(hasActiveNodeFor(false, true, null)).toBe(true);
  });

  it("门控开但物理不在壳内：恒 true（直访 dist-shell 也不拦）", () => {
    expect(hasActiveNodeFor(true, false, emptyRegistry())).toBe(true);
    expect(hasActiveNodeFor(true, false, null)).toBe(true);
  });

  it("门控开 + 在壳内：只认 activeNodeId；为 null（断开/空册/状态缺失）→ false，应回启动器", () => {
    expect(hasActiveNodeFor(true, true, emptyRegistry())).toBe(false);
    expect(hasActiveNodeFor(true, true, null)).toBe(false);
    expect(hasActiveNodeFor(true, true, undefined)).toBe(false);
    const withActive = { ...emptyRegistry(), activeNodeId: "abc123" };
    expect(hasActiveNodeFor(true, true, withActive)).toBe(true);
  });
});

describe("isNodeGateExemptPath（哪些页面无活动节点也可停留）", () => {
  it("启动器本身豁免（无活动节点时的落点）", () => {
    expect(isNodeGateExemptPath("/launcher")).toBe(true);
  });

  it("公开匿名页豁免：分享/加入/邀请", () => {
    expect(isNodeGateExemptPath("/s/tok")).toBe(true);
    expect(isNodeGateExemptPath("/s/tok/doc/d1")).toBe(true);
    expect(isNodeGateExemptPath("/share/tok")).toBe(true);
    expect(isNodeGateExemptPath("/join/tok")).toBe(true);
    expect(isNodeGateExemptPath("/invite/tok")).toBe(true);
  });

  it("登录页【不】豁免——这是登录页断开死锁的关键，断开必须回启动器", () => {
    expect(isNodeGateExemptPath("/login")).toBe(false);
  });

  it("业务页/改密页不豁免", () => {
    expect(isNodeGateExemptPath("/base/b1/table/t1/view/v1")).toBe(false);
    expect(isNodeGateExemptPath("/kb/k1")).toBe(false);
    expect(isNodeGateExemptPath("/force-change-password")).toBe(false);
  });
});

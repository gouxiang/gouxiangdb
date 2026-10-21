// apps/web/src/features/sync/resolveFlow.test.ts
import { describe, it, expect } from "vitest";
import {
  canCustomResolve,
  canUseTheirs,
  canUseMine,
  isConflictResolved,
  removeResolved,
  nextConflict,
} from "./resolveFlow";
import type { PendingConflict } from "../../store/sync";
import type { ResolveSyncConflictResult } from "../../api/localSync";

function conflict(over: Partial<PendingConflict> = {}): PendingConflict {
  return {
    incomingId: "i1",
    clientOpId: "c1",
    baseId: "b1",
    entityType: "record",
    entityId: "e1",
    op: "update",
    mine: { a: 1 },
    theirs: { a: 2 },
    reasonCode: "SYNC_VERSION_CONFLICT",
    reasonDetail: null,
    status: "conflict",
    ...over,
  };
}

function result(over: Partial<ResolveSyncConflictResult> = {}): ResolveSyncConflictResult {
  return {
    resolveOf: "c1", decision: null, status: null, baseId: null, entityId: null,
    newClientOpId: null, seq: null, newVersion: null, reasonCode: null, reasonDetail: null,
    serverVersion: null, ...over,
  };
}

describe("按钮可用性", () => {
  it("mine 恒可用；custom/theirs 需服务端快照", () => {
    expect(canUseMine(conflict())).toBe(true);
    expect(canUseTheirs(conflict())).toBe(true);
    expect(canCustomResolve(conflict())).toBe(true);

    const noSnap = conflict({ theirs: null });
    expect(canUseMine(noSnap)).toBe(true);
    expect(canUseTheirs(noSnap)).toBe(false);
    expect(canCustomResolve(noSnap)).toBe(false);

    expect(canUseMine(null)).toBe(false);
  });
});

describe("isConflictResolved 裁决终态", () => {
  it("theirs 仅在 dropped 时算解决", () => {
    expect(isConflictResolved("theirs", result({ decision: "theirs", status: "dropped" }))).toBe(true);
    expect(isConflictResolved("theirs", result({ decision: "theirs", status: "conflict" }))).toBe(false);
  });
  it("mine/custom 仅在 accepted 时算解决", () => {
    expect(isConflictResolved("mine", result({ decision: "mine", status: "accepted" }))).toBe(true);
    expect(isConflictResolved("custom", result({ decision: "custom", status: "accepted" }))).toBe(true);
    expect(isConflictResolved("mine", result({ decision: "mine", status: "conflict", reasonCode: "SYNC_VERSION_CONFLICT" }))).toBe(false);
    expect(isConflictResolved("mine", result({ decision: "mine", status: "quarantined" }))).toBe(false);
  });
  it("null 结果不算解决", () => {
    expect(isConflictResolved("mine", null)).toBe(false);
  });
});

describe("队列出队/下一条", () => {
  const q = [conflict({ incomingId: "i1", clientOpId: "c1" }), conflict({ incomingId: "i2", clientOpId: "c2" })];
  it("按 incomingId 移除（不可变）", () => {
    const next = removeResolved(q, { incomingId: "i1" });
    expect(next).toHaveLength(1);
    expect(next[0]!.clientOpId).toBe("c2");
    expect(q).toHaveLength(2); // 原数组不变
  });
  it("按 clientOpId 兜底移除", () => {
    expect(removeResolved(q, { clientOpId: "c2" })[0]!.clientOpId).toBe("c1");
  });
  it("nextConflict 取队首 / 空队 null", () => {
    expect(nextConflict(q)!.clientOpId).toBe("c1");
    expect(nextConflict([])).toBeNull();
  });
});

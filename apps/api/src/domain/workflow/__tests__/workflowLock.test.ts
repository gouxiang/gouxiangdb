// 刀 B1 workflowLock 单写者锁测试：纯函数表驱动 + 真临时库短事务生命周期。
// 不 mock DB、不碰 dev.db；workflowLock 仅 import type {DbTx} 与 indexerSchedule 纯函数，
// 故锁文件可顶层静态 import；withWriteTx（牵 db.ts）在 setupOrgHarness 之后动态 import。
// 与 domain/sync/__tests__/replicaIdMapAndLock.test.ts 同构。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import { formatLockValue } from "../../search/indexerSchedule.js";
import {
  WORKFLOW_RUNTIME_LOCK_KEY,
  acquireWorkflowLockTx,
  canAcquireWorkflowLock,
  releaseWorkflowLockTx,
  renewWorkflowLockTx,
  workflowWorkerId,
} from "../workflowLock.js";

let h: OrgHarness;
let withWriteTx: typeof import("../../../db.js").withWriteTx;

beforeAll(async () => {
  delete process.env.GX_WORKFLOW_ENGINE;
  h = await setupOrgHarness();
  ({ withWriteTx } = await import("../../../db.js"));
}, 120_000);

afterAll(async () => {
  await h.cleanup();
});

describe("canAcquireWorkflowLock（纯函数表驱动）", () => {
  const w1 = workflowWorkerId("host", 1);
  const w2 = workflowWorkerId("host", 2);
  const now = 1_000_000;
  const stalled = 30_000;

  it("无锁 / 自有锁 -> 可取", () => {
    expect(canAcquireWorkflowLock(null, w1, now, stalled)).toBe(true);
    expect(canAcquireWorkflowLock(undefined, w1, now, stalled)).toBe(true);
    expect(canAcquireWorkflowLock(formatLockValue(w1, now - 1000), w1, now, stalled)).toBe(true);
  });
  it("他人新鲜锁 -> 不抢", () => {
    expect(canAcquireWorkflowLock(formatLockValue(w2, now - 1000), w1, now, stalled)).toBe(false);
  });
  it("他人过期锁（超过 stalled）-> 可接管", () => {
    expect(canAcquireWorkflowLock(formatLockValue(w2, now - stalled * 2), w1, now, stalled)).toBe(true);
  });
  it("无法解析的锁值 -> 保守不抢", () => {
    expect(canAcquireWorkflowLock("foreign-convention", w1, now, stalled)).toBe(false);
  });
});

describe("workflow 锁事务原语（真临时库）", () => {
  const wA = workflowWorkerId("host", 11);
  const wB = workflowWorkerId("host", 22);

  async function readLock(): Promise<string | null> {
    const row = await h.prisma.appSetting.findUnique({ where: { k: WORKFLOW_RUNTIME_LOCK_KEY } });
    return row?.v ?? null;
  }

  it("acquire 建行且属我；他人新鲜锁 acquire/renew 失败；release 后他人可取", async () => {
    const t0 = 1_000_000;
    const got = await withWriteTx("t.wflock.a1", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wA, nowMs: t0, stalledMs: 30_000 }));
    expect(got).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wA, t0));

    const bGot = await withWriteTx("t.wflock.b1", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wB, nowMs: t0 + 10_000, stalledMs: 30_000 }));
    expect(bGot).toBe(false);
    const bRenew = await withWriteTx("t.wflock.b2", (tx) =>
      renewWorkflowLockTx(tx, { workerId: wB, nowMs: t0 + 10_000 }));
    expect(bRenew).toBe(false);
    expect(await readLock()).toBe(formatLockValue(wA, t0));

    const aRenew = await withWriteTx("t.wflock.a2", (tx) =>
      renewWorkflowLockTx(tx, { workerId: wA, nowMs: t0 + 10_000 }));
    expect(aRenew).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wA, t0 + 10_000));

    await withWriteTx("t.wflock.rel", (tx) => releaseWorkflowLockTx(tx, wA));
    expect(await readLock()).toBeNull();
    const bAfter = await withWriteTx("t.wflock.b3", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wB, nowMs: t0 + 10_000, stalledMs: 30_000 }));
    expect(bAfter).toBe(true);
    await withWriteTx("t.wflock.relb", (tx) => releaseWorkflowLockTx(tx, wB));
  });

  it("崩退不释放：超过 stalled 后他 worker 可接管", async () => {
    const t0 = 2_000_000;
    expect(await withWriteTx("t.wflock.c1", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wA, nowMs: t0, stalledMs: 1_000 }))).toBe(true);
    expect(await withWriteTx("t.wflock.c2", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wB, nowMs: t0 + 500, stalledMs: 1_000 }))).toBe(false);
    expect(await withWriteTx("t.wflock.c3", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: wB, nowMs: t0 + 2_000, stalledMs: 1_000 }))).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wB, t0 + 2_000));
    // A 已失锁，release 不动 B 的锁。
    await withWriteTx("t.wflock.crel", (tx) => releaseWorkflowLockTx(tx, wA));
    expect(await readLock()).toBe(formatLockValue(wB, t0 + 2_000));
    await withWriteTx("t.wflock.crelb", (tx) => releaseWorkflowLockTx(tx, wB));
    expect(await readLock()).toBeNull();
  });
});

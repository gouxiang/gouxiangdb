// beta.2 S3-runtime：sync_id_map 三原语 + app_settings 单写者锁原语的真临时库短事务测试。
// 不 mock DB、不碰 dev.db；idMap/replicaSyncLock 仅 `import type {DbTx}` 且锁文件只依赖纯函数
// indexerSchedule，故二者可顶层静态 import；withWriteTx（牵 db.ts）在 setupOrgHarness 之后动态 import。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import { putIdMapTx, bindRemoteIdTx, resolveLocalIdTx } from "../idMap.js";
import {
  REPLICA_SYNC_LOCK_KEY,
  replicaWorkerId,
  canAcquireReplicaLock,
  acquireReplicaLockTx,
  renewReplicaLockTx,
  releaseReplicaLockTx,
} from "../replicaSyncLock.js";
import { formatLockValue } from "../../search/indexerSchedule.js";

let h: OrgHarness;
let withWriteTx: typeof import("../../../db.js").withWriteTx;

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  h = await setupOrgHarness();
  ({ withWriteTx } = await import("../../../db.js"));
}, 120_000);

afterAll(async () => {
  await h.cleanup();
});

// ───────────────────────── id_map 三原语 ─────────────────────────

describe("sync_id_map：put / bind / resolve", () => {
  const key = { nodeId: "nmap", entityType: "record", localEntityId: "loc1" };

  it("put 预登记（无 remote）后 resolve 为 null；带 remote put 后 resolve 命中", async () => {
    await withWriteTx("t.idmap.put1", (tx) =>
      putIdMapTx(tx, { ...key, clientOpId: "op-1" }));
    await withWriteTx("t.idmap.res1", async (tx) => {
      expect(await resolveLocalIdTx(tx, { nodeId: "nmap", entityType: "record", remoteEntityId: "rem1" })).toBeNull();
    });

    await withWriteTx("t.idmap.put2", (tx) =>
      putIdMapTx(tx, { ...key, clientOpId: "op-1", remoteEntityId: "rem1" }));
    await withWriteTx("t.idmap.res2", async (tx) => {
      expect(await resolveLocalIdTx(tx, { nodeId: "nmap", entityType: "record", remoteEntityId: "rem1" })).toBe("loc1");
    });
  });

  it("同 clientOpId 重复 put 不带 remote：绝不清空既有映射；带新 remote 才回填", async () => {
    await withWriteTx("t.idmap.reput", (tx) =>
      putIdMapTx(tx, { ...key, localEntityId: "loc2", clientOpId: "op-2", remoteEntityId: "rem2" }));
    // 重复登记且本次不带 remote。
    await withWriteTx("t.idmap.reput2", (tx) =>
      putIdMapTx(tx, { ...key, localEntityId: "loc2", clientOpId: "op-2" }));
    await withWriteTx("t.idmap.res3", async (tx) => {
      expect(await resolveLocalIdTx(tx, { nodeId: "nmap", entityType: "record", remoteEntityId: "rem2" })).toBe("loc2");
    });
    // 仍只一行（clientOpId @unique，幂等不建行）。
    const count = await h.prisma.syncIdMap.count({ where: { clientOpId: "op-2" } });
    expect(count).toBe(1);
  });

  it("bind：ack 时行不存在则 upsert 补建；空串 remote 不绑定", async () => {
    // 无预登记行，直接 bind（S2 只登记 outbox 的真实情形）。
    await withWriteTx("t.idmap.bind1", (tx) =>
      bindRemoteIdTx(tx, { ...key, localEntityId: "loc3", clientOpId: "op-3", remoteEntityId: "rem3" }));
    await withWriteTx("t.idmap.res4", async (tx) => {
      expect(await resolveLocalIdTx(tx, { nodeId: "nmap", entityType: "record", remoteEntityId: "rem3" })).toBe("loc3");
    });
    // 空串：直接 no-op，不建行。
    await withWriteTx("t.idmap.bind2", (tx) =>
      bindRemoteIdTx(tx, { ...key, localEntityId: "loc4", clientOpId: "op-4", remoteEntityId: "   " }));
    const count = await h.prisma.syncIdMap.count({ where: { clientOpId: "op-4" } });
    expect(count).toBe(0);
  });

  it("resolve 按 nodeId/entityType 隔离：他节点/他实体类型查不到", async () => {
    await withWriteTx("t.idmap.res5", async (tx) => {
      expect(await resolveLocalIdTx(tx, { nodeId: "other", entityType: "record", remoteEntityId: "rem1" })).toBeNull();
      expect(await resolveLocalIdTx(tx, { nodeId: "nmap", entityType: "table", remoteEntityId: "rem1" })).toBeNull();
    });
  });
});

// ───────────────────────── 单写者锁：纯函数 ─────────────────────────

describe("canAcquireReplicaLock（纯函数表驱动）", () => {
  const w1 = replicaWorkerId("host", 1);
  const w2 = replicaWorkerId("host", 2);
  const now = 1_000_000;
  const stalled = 30_000;

  it("无锁 / 自有锁 -> 可取", () => {
    expect(canAcquireReplicaLock(null, w1, now, stalled)).toBe(true);
    expect(canAcquireReplicaLock(undefined, w1, now, stalled)).toBe(true);
    expect(canAcquireReplicaLock(formatLockValue(w1, now - 1000), w1, now, stalled)).toBe(true);
  });
  it("他人新鲜锁 -> 不抢", () => {
    expect(canAcquireReplicaLock(formatLockValue(w2, now - 1000), w1, now, stalled)).toBe(false);
  });
  it("他人过期锁（超过 stalled）-> 可接管", () => {
    expect(canAcquireReplicaLock(formatLockValue(w2, now - stalled * 2), w1, now, stalled)).toBe(true);
  });
  it("无法解析的锁值 -> 保守不抢", () => {
    expect(canAcquireReplicaLock("some-foreign-value", w1, now, stalled)).toBe(false);
  });
});

// ───────────────────────── 单写者锁：事务生命周期 ─────────────────────────

describe("replica 锁事务原语", () => {
  const wA = replicaWorkerId("host", 11);
  const wB = replicaWorkerId("host", 22);

  async function readLock(): Promise<string | null> {
    const row = await h.prisma.appSetting.findUnique({ where: { k: REPLICA_SYNC_LOCK_KEY } });
    return row?.v ?? null;
  }

  it("acquire 建行且属我；他人新鲜锁 acquire 失败、renew 失败；release 后他人可取", async () => {
    const t0 = 1_000_000;
    const got = await withWriteTx("t.lock.a1", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wA, nowMs: t0, stalledMs: 30_000 }));
    expect(got).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wA, t0));

    // 新鲜期内 B 抢不到。
    const bGot = await withWriteTx("t.lock.b1", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wB, nowMs: t0 + 10_000, stalledMs: 30_000 }));
    expect(bGot).toBe(false);
    // B 续期失败（锁不属它），锁值仍是 A 的旧心跳。
    const bRenew = await withWriteTx("t.lock.b2", (tx) =>
      renewReplicaLockTx(tx, { workerId: wB, nowMs: t0 + 10_000 }));
    expect(bRenew).toBe(false);
    expect(await readLock()).toBe(formatLockValue(wA, t0));

    // A 续期成功推进心跳。
    const aRenew = await withWriteTx("t.lock.a2", (tx) =>
      renewReplicaLockTx(tx, { workerId: wA, nowMs: t0 + 10_000 }));
    expect(aRenew).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wA, t0 + 10_000));

    // A 主动释放；随后 B 立即可取（无需等 stalled）。
    await withWriteTx("t.lock.rel", (tx) => releaseReplicaLockTx(tx, wA));
    expect(await readLock()).toBeNull();
    const bAfter = await withWriteTx("t.lock.b3", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wB, nowMs: t0 + 10_000, stalledMs: 30_000 }));
    expect(bAfter).toBe(true);
    await withWriteTx("t.lock.relb", (tx) => releaseReplicaLockTx(tx, wB));
  });

  it("崩退不释放：超过 stalled 后他 worker 可接管", async () => {
    const t0 = 2_000_000;
    expect(await withWriteTx("t.lock.c1", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wA, nowMs: t0, stalledMs: 1_000 }))).toBe(true);
    // 1 个 stalled 窗口内不抢。
    expect(await withWriteTx("t.lock.c2", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wB, nowMs: t0 + 500, stalledMs: 1_000 }))).toBe(false);
    // 超过 3s（runtime 传 stalled=3*interval，这里用 1000 演示）后接管成功。
    expect(await withWriteTx("t.lock.c3", (tx) =>
      acquireReplicaLockTx(tx, { workerId: wB, nowMs: t0 + 2_000, stalledMs: 1_000 }))).toBe(true);
    expect(await readLock()).toBe(formatLockValue(wB, t0 + 2_000));
    // A 此时已失锁，release 不动 B 的锁。
    await withWriteTx("t.lock.crel", (tx) => releaseReplicaLockTx(tx, wA));
    expect(await readLock()).toBe(formatLockValue(wB, t0 + 2_000));
    await withWriteTx("t.lock.crelb", (tx) => releaseReplicaLockTx(tx, wB));
  });
});

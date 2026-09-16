// M5/S5 认领/防双开/stalled 回收/状态机测试：真主库 change_events + 真临时 search.db。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeIndexerHarness, seedTable, seedRecord, enqueue, type IndexerHarness,
} from "./indexerHarness.js";
import { claimNext, SearchIndexer } from "../indexer.js";
import { META_KEYS, getMeta } from "../schema.js";
import { formatLockValue } from "../indexerSchedule.js";

let h: IndexerHarness;
const T = 2_000_000_000_000; // 固定时钟，退避时间可精确断言

beforeAll(async () => {
  h = await makeIndexerHarness("gx-m5-s5-claim-");
  await seedTable(h, "s5c", [
    { id: "s5c_f1", name: "名", type: "singleLineText", order: 0 },
  ]);
}, 120000);

afterAll(async () => { await h.cleanup(); });

async function statusOf(entityId: string) {
  const rows = await h.prisma.changeEvent.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
  return rows;
}

describe("原子认领（UPDATE...RETURNING）", () => {
  it("并发两个 worker 只有一个拿到同一行；拿到后 status=processing、attempts+1、workerId 带令牌", async () => {
    await seedRecord(h, "s5c_t", "s5c_r1", { s5c_f1: "甲" });
    await enqueue(h, { entityType: "record", entityId: "s5c_r1", op: "upsert" });
    const [a, b] = await Promise.all([
      claimNext(h.prisma, "wa", T),
      claimNext(h.prisma, "wb", T),
    ]);
    const got = [a, b].filter(Boolean);
    expect(got).toHaveLength(1);
    expect(got[0]!.entityId).toBe("s5c_r1");
    expect(got[0]!.attempts).toBe(1);
    expect(got[0]!.workerId).toMatch(/^w[ab]@\d+$/);
    const row = (await statusOf("s5c_r1"))[0]!;
    expect(row.status).toBe("processing");
  });

  it("pending 与 failed（nextRunAt 到期）都会被认领；认完返回 null", async () => {
    await seedRecord(h, "s5c_t", "s5c_r2", { s5c_f1: "乙" });
    await seedRecord(h, "s5c_t", "s5c_r3", { s5c_f1: "丙" });
    await enqueue(h, { entityType: "record", entityId: "s5c_r2", op: "upsert", status: "pending" });
    await enqueue(h, {
      entityType: "record", entityId: "s5c_r3", op: "upsert", status: "failed",
      attempts: 2, nextRunAt: new Date(T - 1000),
    });
    const c1 = await claimNext(h.prisma, "w", T);
    const c2 = await claimNext(h.prisma, "w", T);
    expect([c1?.entityId, c2?.entityId].sort()).toEqual(["s5c_r2", "s5c_r3"]);
    expect(c1?.attempts).toBeGreaterThanOrEqual(1);
    expect(await claimNext(h.prisma, "w", T)).toBeNull();
  });

  it("未到期（nextRunAt 在未来）的 failed 不认领", async () => {
    await seedRecord(h, "s5c_t", "s5c_r4", { s5c_f1: "丁" });
    await enqueue(h, {
      entityType: "record", entityId: "s5c_r4", op: "upsert", status: "failed",
      nextRunAt: new Date(T + 60_000),
    });
    expect(await claimNext(h.prisma, "w", T)).toBeNull();
  });
});

describe("stalled processing 回收", () => {
  it("认领时间超 stalledMs 的 processing 重置回 pending；新鲜行不回收", async () => {
    await seedRecord(h, "s5c_t", "s5c_old", { s5c_f1: "旧" });
    await seedRecord(h, "s5c_t", "s5c_new", { s5c_f1: "新" });
    await enqueue(h, { entityType: "record", entityId: "s5c_old", op: "upsert", status: "processing", workerId: `wx@${T - 5000}` });
    await enqueue(h, { entityType: "record", entityId: "s5c_new", op: "upsert", status: "processing", workerId: `wx@${T}` });
    const store = h.openStore("stall", false);
    const idx = new SearchIndexer({
      prisma: h.prisma, store, mode: "off", provider: null, workerId: "wy",
      stalledMs: 1000, nowMs: () => T, startDelayMs: 0,
    });
    const reclaimed = await idx.recoverStalled();
    expect(reclaimed).toBe(1);
    const old = (await statusOf("s5c_old"))[0]!;
    const fresh = (await statusOf("s5c_new"))[0]!;
    expect(old.status).toBe("pending");
    expect(fresh.status).toBe("processing");
    store.close();
  });
});

describe("worker_lock 防双开", () => {
  it("新鲜且属他人的锁挡住第二个 worker；锁过期/自己可抢占", () => {
    const store = h.openStore("lock", false);
    const a = new SearchIndexer({ prisma: h.prisma, store, mode: "off", provider: null, workerId: "lockA", nowMs: () => T, startDelayMs: 999_999 });
    const b = new SearchIndexer({ prisma: h.prisma, store, mode: "off", provider: null, workerId: "lockB", nowMs: () => T, startDelayMs: 999_999 });
    expect(a.start()).toBe(true);
    expect(getMeta(store.db, META_KEYS.workerLock)).toBe(formatLockValue("lockA", T));
    expect(b.start()).toBe(false); // 活锁属 A
    a.stop();

    // A 锁停滞（15 分钟默认阈值）后 B 可抢占
    const future = T + 16 * 60_000;
    const c = new SearchIndexer({ prisma: h.prisma, store, mode: "off", provider: null, workerId: "lockC", nowMs: () => future, startDelayMs: 999_999 });
    expect(c.start()).toBe(true);
    expect(getMeta(store.db, META_KEYS.workerLock)).toBe(formatLockValue("lockC", future));
    c.stop();
    store.close();
  });
});

describe("处理状态机：成功 done / 失败退避 / 8 次 dead", () => {
  it("成功处理 -> done + processedAt", async () => {
    const store = h.openStore("ok", false);
    await seedRecord(h, "s5c_t", "s5c_ok", { s5c_f1: "成功" });
    await enqueue(h, { entityType: "record", entityId: "s5c_ok", op: "upsert" });
    const idx = new SearchIndexer({
      prisma: h.prisma, store, mode: "off", provider: null, workerId: "wok",
      nowMs: () => T, startDelayMs: 0,
    });
    const n = await idx.runOnce();
    expect(n).toBeGreaterThanOrEqual(1);
    const row = (await statusOf("s5c_ok"))[0]!;
    expect(row.status).toBe("done");
    expect(row.processedAt).not.toBeNull();
    store.close();
  });

  it("处理失败 -> failed + attempts 自增 + nextRunAt=T+10s", async () => {
    const store = h.openStore("fail", false);
    await seedRecord(h, "s5c_t", "s5c_fail", { s5c_f1: "失败" });
    await enqueue(h, { entityType: "record", entityId: "s5c_fail", op: "upsert" });
    // 先认领到 processing，再把底层 store 关闭迫使派生写抛错。
    await claimNext(h.prisma, "wok", T);
    store.close();
    const closed = new SearchIndexer({
      prisma: h.prisma, store, mode: "off", provider: null, workerId: "wok",
      nowMs: () => T, startDelayMs: 0,
    });
    // 直接处理该已认领行（runOnce 会因锁元失败，故直接 processOne 该事件）。
    const ev = (await h.prisma.changeEvent.findFirst({ where: { entityId: "s5c_fail" } }))!;
    await closed.processOne({
      id: ev.id, entityType: ev.entityType, entityId: ev.entityId, version: ev.version,
      op: ev.op, attempts: ev.attempts, workerId: ev.workerId ?? "wok@0",
    });
    const row = (await statusOf("s5c_fail"))[0]!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.nextRunAt.getTime()).toBe(T + 10_000);
    expect(row.lastError).toBeTruthy();
  });

  it("attempts 已达 8 的处理失败 -> dead", async () => {
    const store = h.openStore("dead", false);
    await seedRecord(h, "s5c_t", "s5c_dead", { s5c_f1: "死信" });
    await enqueue(h, { entityType: "record", entityId: "s5c_dead", op: "upsert", status: "failed", attempts: 7 });
    await claimNext(h.prisma, "wok", T); // attempts 7 -> 8
    store.close();
    const idx = new SearchIndexer({
      prisma: h.prisma, store, mode: "off", provider: null, workerId: "wok",
      nowMs: () => T, startDelayMs: 0,
    });
    const ev = (await h.prisma.changeEvent.findFirst({ where: { entityId: "s5c_dead" } }))!;
    await idx.processOne({
      id: ev.id, entityType: ev.entityType, entityId: ev.entityId, version: ev.version,
      op: ev.op, attempts: ev.attempts, workerId: ev.workerId ?? "wok@0",
    });
    const row = (await statusOf("s5c_dead"))[0]!;
    expect(row.status).toBe("dead");
  });
});

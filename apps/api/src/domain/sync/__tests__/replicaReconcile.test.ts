// beta.2 S4d：失权对账编排器 reconcileVisibilityOnce / reconcileVisibilityTx 真临时库测试
// （不 mock DB、不碰 dev.db、不起 HTTP；网络用假 transport，审计用 push 数组假 sink）。
// 设计权威：DESIGN-OFFLINE-SYNC §9.3（受限重快照）、§9.5（sync_visibility_purged）、决策 D2。
//
// 加载纪律（同 replicaPull.test.ts）：编排器运行时依赖链含 ../../db.js（模块加载即 new
// PrismaClient），故 vitest/harness/纯 tx 的 advanceReconcileAuthzTx 顶层静态 import，
// replicaReconcile.js 的【值】在 beforeAll setupOrgHarness（注入临时 DATABASE_URL + migrate deploy）
// 之后【动态 import】；编排器的【类型】用 import type（编译期擦除，零运行时加载）。
// beforeAll 先 delete GX_OFFLINE_REPLICA（off 建库）。
//
// 每个 it 用独立 base id（tag 后缀）+ 独立 seed 隔离；断言一律在事务外用 h.prisma 查。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import { advanceReconcileAuthzTx } from "../replicaReconcileState.js";
import { ReplicaTransportError } from "../replicaPushTransport.js";
import type { VisibilityReport } from "../visibility.js";
import type {
  ReplicaVisibilityTransport,
  ReconcileAuditEvent,
  ReconcileDeps,
} from "../replicaReconcile.js";

let h: OrgHarness;
const NODE = "reconnode";
const FIXED_NOW = new Date("2026-10-20T00:00:00.000Z");

type ReconcileMod = typeof import("../replicaReconcile.js");
let mod: ReconcileMod;

function withReplicaOn<K>(fn: () => Promise<K>): Promise<K> {
  const keys = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID"] as const;
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = NODE;
  return fn().finally(() => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  });
}

// ───────────────────────── seed / fakes ─────────────────────────

interface SeedOpts {
  /** replica_state.authzVersion 初值；不给＝不建行（纯本地 base）。 */
  authz?: string | null;
}

/** 一表两活记录（r1 将被行擦 / r2 保留但被抹 fa2）+ 一条 r1→r2 link。 */
async function seedBase(tag: string, opts: SeedOpts = {}): Promise<{ base: string; ta: string }> {
  const base = `b_${tag}`;
  const ta = `ta_${tag}`;
  const id = (p: string) => `${p}_${tag}`;
  await h.prisma.base.create({ data: { id: base, name: tag, createdBy: "t" } });
  await h.prisma.table.create({
    data: { id: ta, baseId: base, name: "A", primaryFieldId: id("fa1"), createdBy: "t" },
  });
  await h.prisma.field.create({
    data: { id: id("fa1"), tableId: ta, name: "标题", type: "text", order: 0 },
  });
  await h.prisma.record.createMany({
    data: [
      { id: id("r1"), tableId: ta, fields: JSON.stringify({ [id("fa1")]: "x", fa2: 1 }), createdBy: "t", updatedBy: "t" },
      { id: id("r2"), tableId: ta, fields: JSON.stringify({ [id("fa1")]: "y", fa2: 2 }), createdBy: "t", updatedBy: "t" },
    ] as never,
  });
  await h.prisma.linkRow.create({
    data: { id: id("L1"), linkFieldId: "faLink", parentRowId: id("r1"), childRowId: id("r2") } as never,
  });
  if (opts.authz !== undefined) {
    await h.prisma.replicaState.create({
      data: { nodeId: NODE, remoteBaseId: base, localBaseId: base, authzVersion: opts.authz },
    });
  }
  return { base, ta };
}

/** r1 行级失权、r2 仅 fa1 可见的收缩报告（authzVersion 可配）。 */
function shrunkReport(tag: string, authzVersion: number): VisibilityReport {
  const id = (p: string) => `${p}_${tag}`;
  return {
    baseId: `b_${tag}`, authzVersion, serverTime: "2026-10-20T00:00:00.000Z",
    tables: [
      { tableId: `ta_${tag}`, readable: true, visibleEntityIds: [id("r2")], visibleFieldIds: [id("fa1")] },
    ],
  };
}

/** 全可见报告（零差集；visibleFieldIds=null 表示字段不裁剪）。 */
function fullReport(tag: string, authzVersion: number): VisibilityReport {
  const id = (p: string) => `${p}_${tag}`;
  return {
    baseId: `b_${tag}`, authzVersion, serverTime: "2026-10-20T00:00:00.000Z",
    tables: [
      { tableId: `ta_${tag}`, readable: true, visibleEntityIds: [id("r1"), id("r2")], visibleFieldIds: null },
    ],
  };
}

type Responder = (baseId: string) => Promise<VisibilityReport> | VisibilityReport;

class FakeVisibilityTransport implements ReplicaVisibilityTransport {
  calls: string[] = [];
  constructor(private readonly responder: Responder) {}
  async fetchVisibility(baseId: string): Promise<VisibilityReport> {
    this.calls.push(baseId);
    return this.responder(baseId);
  }
}

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  h = await setupOrgHarness();
  mod = await import("../replicaReconcile.js");
}, 120_000);

afterAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  await h.cleanup();
});

// ① off 门
describe("① 默认关：ran:false、transport 零调用、零查零写、sink 不触发", () => {
  it("关态返回空 summary", async () => {
    delete process.env.GX_OFFLINE_REPLICA;
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport(() => {
      throw new Error("关态绝不能发 HTTP");
    });
    const r = await mod.reconcileVisibilityOnce({
      transport, baseIds: ["b_off"], now: FIXED_NOW, auditSink: (e) => events.push(e),
    });
    expect(r).toEqual({ ran: false, nodeId: "local", results: [], deniedBaseIds: [], transportError: false });
    expect(transport.calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

// ② 版本相同
describe("② authzVersion 相同：identical_authz_version，不读 inventory/不写/不记账/不审计", () => {
  it("outcome=identical、advanced:false、列保持 5、r1 仍活", async () => {
    const s = await seedBase("t2", { authz: "5" });
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((b) => (b === s.base ? shrunkReport("t2", 5) : fullReport("t2", 5)));
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [s.base], now: FIXED_NOW, auditSink: (e) => events.push(e),
    }));
    expect(r.ran).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ outcome: "identical_authz_version", advanced: false });
    expect(events).toEqual([]);
    expect((await h.prisma.replicaState.findUnique({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: s.base } },
    }))?.authzVersion).toBe("5");
    expect((await h.prisma.record.findUnique({ where: { id: "r1_t2" } }))?.deletedAt).toBeNull();
  });
});

// ③ 端到端软擦 + 记账 + 审计（无 id 泄露；sink 在提交后）
describe("③ 端到端失权软擦：r1/L1 墓碑、r2 抹 fa2、版本 3→5、审计恰好 1 条且无 id/字段值", () => {
  it("purged + apply 计数 + 列前进；事件 JSON 不含任何 record/link/field id 或字段值", async () => {
    const s = await seedBase("t3", { authz: "3" });
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((b) => (b === s.base ? shrunkReport("t3", 5) : fullReport("t3", 5)));
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [s.base], actorUserId: "purger", now: FIXED_NOW, auditSink: (e) => events.push(e),
    }));
    const item = r.results[0];
    expect(item.outcome).toBe("purged");
    expect(item.advanced).toBe(true);
    expect(item.apply).toMatchObject({
      recordsSoftDeleted: 1, linksSoftDeleted: 1, recordsRescoped: 1, fieldKeysStripped: 1,
    });

    expect((await h.prisma.record.findUnique({ where: { id: "r1_t3" } }))?.deletedAt).toBeInstanceOf(Date);
    const r2 = await h.prisma.record.findUnique({ where: { id: "r2_t3" } });
    expect(JSON.parse(r2!.fields as string)).toEqual({ fa1_t3: "y" });
    expect((await h.prisma.linkRow.findUnique({ where: { id: "L1_t3" } }))?.deletedAt).toBeInstanceOf(Date);
    expect((await h.prisma.replicaState.findUnique({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: s.base } },
    }))?.authzVersion).toBe("5");

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({
      actorId: "purger", baseId: s.base, fromAuthzVersion: "3", toAuthzVersion: "5",
      reasonCode: "ok", triggered: true,
      recordsSoftDeleted: 1, linksSoftDeleted: 1, recordsRescoped: 1, fieldKeysStripped: 1,
    });
    const blob = JSON.stringify(e);
    for (const leaked of ["r1_t3", "r2_t3", "L1_t3", "fa1_t3", "fa2", "ta_t3"]) {
      expect(blob).not.toContain(leaked);
    }
  });
});

// ④ 纯本地 base
describe("④ 纯本地 base（无 replica_state 行）：skipped_local_only，数据原样、不建行、不审计", () => {
  it("transport 被调但库零写；results 有 skipped 项；replica_state 仍无行", async () => {
    const s = await seedBase("t4"); // 不建 replica_state
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((b) => (b === s.base ? shrunkReport("t4", 9) : fullReport("t4", 9)));
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [s.base], now: FIXED_NOW, auditSink: (e) => events.push(e),
    }));
    expect(transport.calls).toEqual([s.base]);
    expect(r.results[0]).toMatchObject({ outcome: "skipped_local_only", advanced: false, localAuthzVersion: null });
    expect(events).toEqual([]);
    expect(await h.prisma.replicaState.count({
      where: { nodeId: NODE, remoteBaseId: s.base },
    })).toBe(0);
    const r1 = await h.prisma.record.findUnique({ where: { id: "r1_t4" } });
    expect(r1?.deletedAt).toBeNull();
    expect(r1?.fields).toBe(JSON.stringify({ fa1_t4: "x", fa2: 1 }));
  });
});

// ⑤ 403 denied 继续
describe("⑤ visibility 403：deniedBaseIds 登记、不擦不抛不记账不审计，后续 base 继续", () => {
  it("被拒 base 不入 results；其后 base 正常 purged", async () => {
    const denied = `b_denied_t5`;
    const s = await seedBase("t5", { authz: "3" });
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((b) => {
      if (b === denied) throw new ReplicaTransportError("forbidden", 403);
      if (b === s.base) return shrunkReport("t5", 5);
      throw new Error("unexpected base");
    });
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [denied, s.base], now: FIXED_NOW, auditSink: (e) => events.push(e),
    }));
    expect(r.deniedBaseIds).toEqual([denied]);
    expect(r.transportError).toBe(false);
    expect(r.results.map((x) => x.baseId)).toEqual([s.base]);
    expect(r.results[0].outcome).toBe("purged");
    expect(events).toHaveLength(1);
  });
});

// ⑥ 500 即停
describe("⑥ 其他传输错（500）：transportError=true 立即停本轮，其后 base transport 不再被调", () => {
  it("results 为空、第二个 base 未请求", async () => {
    const a = "b_a_t6";
    const b = "b_b_t6";
    const requested: string[] = [];
    const transport = new FakeVisibilityTransport((baseId) => {
      requested.push(baseId);
      throw new ReplicaTransportError("server error", 500);
    });
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [a, b], now: FIXED_NOW,
    }));
    expect(r.transportError).toBe(true);
    expect(r.deniedBaseIds).toEqual([]);
    expect(r.results).toEqual([]);
    expect(requested).toEqual([a]);
  });
});

// ⑦ 单调不回退
describe("⑦ 服务端版本更小（10→3，全可见零差集）：不擦、noop、advanced:false、列保持 10", () => {
  it("authzVersion 列不回退；无审计；记录零变化", async () => {
    const s = await seedBase("t7", { authz: "10" });
    const before = await h.prisma.record.findUnique({ where: { id: "r1_t7" } });
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((x) => (x === s.base ? fullReport("t7", 3) : fullReport("t7", 3)));
    const r = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport, baseIds: [s.base], now: FIXED_NOW, auditSink: (e) => events.push(e),
    }));
    expect(r.results[0]).toMatchObject({ outcome: "noop", advanced: false });
    expect(events).toEqual([]);
    expect((await h.prisma.replicaState.findUnique({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: s.base } },
    }))?.authzVersion).toBe("10");
    const after = await h.prisma.record.findUnique({ where: { id: "r1_t7" } });
    expect(after?.deletedAt).toBeNull();
    expect(after?.fields).toBe(before?.fields);
  });
});

// ⑧ 两轮幂等
describe("⑧ 同一收缩报告跑两轮：首轮 purged+审计，次轮 identical 全 0、审计不重复", () => {
  it("第二轮无 purged 事件；终态墓碑/抹 key 持久", async () => {
    const s = await seedBase("t8", { authz: "3" });
    const events: ReconcileAuditEvent[] = [];
    const transport = new FakeVisibilityTransport((b) => (b === s.base ? shrunkReport("t8", 5) : fullReport("t8", 5)));
    const deps = (): ReconcileDeps => ({
      transport, baseIds: [s.base], actorUserId: "purger", now: FIXED_NOW, auditSink: (e) => events.push(e),
    });
    const first = await withReplicaOn(() => mod.reconcileVisibilityOnce(deps()));
    expect(first.results[0].outcome).toBe("purged");
    expect(events).toHaveLength(1);

    const second = await withReplicaOn(() => mod.reconcileVisibilityOnce(deps()));
    expect(second.results[0]).toMatchObject({ outcome: "identical_authz_version", advanced: false });
    expect(second.results[0].apply).toBeUndefined();
    expect(events).toHaveLength(1);
    expect((await h.prisma.record.findUnique({ where: { id: "r1_t8" } }))?.deletedAt).toBeInstanceOf(Date);
    expect(JSON.parse((await h.prisma.record.findUnique({ where: { id: "r2_t8" } }))!.fields as string))
      .toEqual({ fa1_t8: "y" });
  });
});

// ⑨ 审计仅提交后；事务失败不触发
describe("⑨ 审计时机：sink 调用时数据已提交；事务体抛错（回滚）时无审计事件外逃", () => {
  it("sink 内查库可见墓碑与新版本；包裹 sentinel 失败的事务回滚且事件数 0", async () => {
    // 探针：sink 被调的同一刻另开连接发起读，其 resolve 值必须反映"已提交"（墓碑可见）。
    // sink 签名是同步的，故在 sink 内把查询 promise 收集起来，轮次结束后 await。
    const sProbe = await seedBase("t9p", { authz: "3" });
    const committedAtSink: Array<Promise<boolean>> = [];
    const probeEvents: ReconcileAuditEvent[] = [];
    const transportProbe = new FakeVisibilityTransport((b) =>
      (b === sProbe.base ? shrunkReport("t9p", 5) : fullReport("t9p", 5)));
    const probed = await withReplicaOn(() => mod.reconcileVisibilityOnce({
      transport: transportProbe, baseIds: [sProbe.base], now: FIXED_NOW,
      auditSink: (e) => {
        probeEvents.push(e);
        // sink 在提交后被调：此刻另开连接必须已能读到墓碑。
        committedAtSink.push(h.prisma.record.findUnique({ where: { id: "r1_t9p" } })
          .then((row) => row?.deletedAt instanceof Date));
      },
    }));
    expect(probed.results[0].outcome).toBe("purged");
    expect(probeEvents).toHaveLength(1);
    expect(await Promise.all(committedAtSink)).toEqual([true]);

    // 事务体成功算出 purged 但提交前抛 sentinel：编排调用点语义＝withWriteTx reject → sink 行不可达。
    const s2 = await seedBase("t9b", { authz: "3" });
    const events2: ReconcileAuditEvent[] = [];
    const { withWriteTx } = await import("../../../db.js");
    await expect(withWriteTx("test.reconcile.fail", async (tx) => {
      const result = await mod.reconcileVisibilityTx(tx, {
        nodeId: NODE, localBaseId: s2.base, report: shrunkReport("t9b", 5), now: FIXED_NOW,
      });
      expect(result.outcome).toBe("purged");
      // 复刻编排器：只有提交后才允许调 sink；这里主动让事务失败。
      throw new Error("sentinel-rollback");
    })).rejects.toThrow("sentinel-rollback");
    expect(events2).toEqual([]);
    // 回滚落地：r1 仍活、版本仍 3。
    expect((await h.prisma.record.findUnique({ where: { id: "r1_t9b" } }))?.deletedAt).toBeNull();
    expect((await h.prisma.replicaState.findUnique({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: s2.base } },
    }))?.authzVersion).toBe("3");
  });
});

// advanceReconcileAuthzTx 单测
describe("advanceReconcileAuthzTx：单调 max 一列原语", () => {
  async function stateOf(base: string): Promise<string | null> {
    return (await h.prisma.replicaState.findUnique({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: base } },
    }))?.authzVersion ?? null;
  }

  it("null 前进到 5", async () => {
    const s = await seedBase("s_null", { authz: null });
    const r = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: s.base, authzVersion: 5 }));
    expect(r).toEqual({ advanced: true, from: null, to: "5" });
    expect(await stateOf(s.base)).toBe("5");
  });

  it("数字串：3→5 前进；10→5 不回退；5→5 相等不写", async () => {
    const a = await seedBase("s_up", { authz: "3" });
    const up = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: a.base, authzVersion: 5 }));
    expect(up).toEqual({ advanced: true, from: "3", to: "5" });
    expect(await stateOf(a.base)).toBe("5");

    const b = await seedBase("s_down", { authz: "10" });
    const down = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: b.base, authzVersion: 5 }));
    expect(down).toEqual({ advanced: false, from: "10", to: "10" });
    expect(await stateOf(b.base)).toBe("10");

    const c = await seedBase("s_eq", { authz: "5" });
    const eq = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: c.base, authzVersion: 5 }));
    expect(eq.advanced).toBe(false);
    expect(eq.to).toBe("5");
    expect(await stateOf(c.base)).toBe("5");
  });

  it("脏非数字串当作前进；无行不 create", async () => {
    const a = await seedBase("s_dirty", { authz: "abc" });
    const dirty = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: a.base, authzVersion: 5 }));
    expect(dirty).toMatchObject({ advanced: true, from: "abc", to: "5" });
    expect(await stateOf(a.base)).toBe("5");

    const missing = "b_never_seeded";
    const none = await h.prisma.$transaction((tx) =>
      advanceReconcileAuthzTx(tx, { nodeId: NODE, remoteBaseId: missing, authzVersion: 5 }));
    expect(none).toEqual({ advanced: false, from: null, to: "5" });
    expect(await h.prisma.replicaState.count({
      where: { nodeId: NODE, remoteBaseId: missing },
    })).toBe(0);
  });
});

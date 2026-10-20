// beta.2 S3b-3b：三轨下行同步泵 pullReplicaOnce 契约测试（真临时库 + 真迁移，不 mock DB，不碰 dev.db）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（subscribe→bootstrap→pull）、§8.3（seq keyset）、§8.4（保 id）、
// §8.6（结构/树走注册表 apply）、§13；默认关、纯增量、下行绝不回流 outbox/oplog/version/incoming。
//
// 加载铁律（同 replicaPush/yn11）：顶层只静态 import vitest + setupOrgHarness（+ import type）；
// beforeAll 先 delete GX_OFFLINE_REPLICA 再 setupOrgHarness（off 建库）；db 依赖链一律在 harness 注入
// 临时 DATABASE_URL 后【动态 import】。网络用假 transport（记录调用 + 回 canned 页），不起 HTTP。
//
// 覆盖 7 类：
//  ① off 默认：ran:false、transport 零调用、零查零写。
//  ② 空副本 base：subscribe→bootstrap（表/权威子实体 id/活 record/link）→空 pull 页：保 id 直插 + 游标=anchorSeq。
//  ③ 增量一页三序 [create_table, record create, record patch]：新表默认子实体 id==payload、游标推进、opsApplied。
//  ④ record delete/restore：墓碑/link_row 软删/sidecar 撤 → 恢复撤销+回填+重建；全程 outbox/oplog/version 零写。
//  ⑤ 树增量 create_group×2/move/reorder：navnode 落地、replica_tree_state 游标/treeVersion 推进、空树首个 after="0"。
//  ⑥ 两页：第一页提交后第二页抛 ReplicaTransportError → transportError=true 且第一页游标不回滚。
//  ⑦ 未登记结构 op / 未知 record op / 未登记树 op → skipped，不抛、游标照常推进。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import type { ReplicaPullTransport } from "../replicaPull.js";
import type { ReplicaBootstrapPage, BootstrapField } from "../bootstrap.js";
import type { PullOp, PullPage, TreePullPage } from "../pull.js";
import type { SubscribeResult, TreeSubscribeResult } from "../snapshot.js";

let h: OrgHarness;
const OWNER = "rp_owner";
const NODE = "rpnode";
const CLIENT = "rpclient";

function withReplicaOn<K>(fn: () => Promise<K>): Promise<K> {
  const keys = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID", "GX_OFFLINE_CLIENT_ID"] as const;
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = NODE;
  process.env.GX_OFFLINE_CLIENT_ID = CLIENT;
  return fn().finally(() => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  });
}

type PullMod = typeof import("../replicaPull.js");
let mod: PullMod;

// ───────────────────────── canned 夹具 builders ─────────────────────────

function field(partial: Partial<BootstrapField> & Pick<BootstrapField, "id" | "tableId" | "name" | "type">): BootstrapField {
  return {
    description: "", order: 0, required: false, unique: false, options: null, maxLength: null,
    defaultNow: false, precision: null, recordFilter: null, linkFieldId: null, relatedTableId: null,
    relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null,
    lookupFieldId: null, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null,
    visibleFieldIds: null, defaultConfig: null, numberRule: null, ...partial,
  };
}

interface PageSpec {
  base: { id: string; name: string };
  tables: { id: string; name: string; primaryFieldId: string }[];
  fields: BootstrapField[];
  views: { id: string; tableId: string; name: string; type?: string; config?: string }[];
  records: { id: string; tableId: string; fields: Record<string, unknown> }[];
  links: { id: string; linkFieldId: string; parentRowId: string; childRowId: string; ord: number }[];
  anchorSeq: string;
  authzVersion?: number;
}

function bootstrapPage(spec: PageSpec): ReplicaBootstrapPage {
  return {
    kind: "replica-bootstrap",
    baseId: spec.base.id,
    anchorSeq: spec.anchorSeq,
    authzVersion: spec.authzVersion ?? 1,
    serverTime: new Date().toISOString(),
    recordsTruncated: false,
    base: { id: spec.base.id, name: spec.base.name, icon: null, iconColor: "#123456", shareEnabled: 0 },
    tables: spec.tables.map((t) => ({
      id: t.id, name: t.name, primaryFieldId: t.primaryFieldId, icon: null, iconColor: null, shareEnabled: 0,
    })),
    fields: spec.fields,
    views: spec.views.map((v) => ({
      id: v.id, tableId: v.tableId, name: v.name, type: v.type ?? "grid",
      lockMode: "collaborative", order: 0, config: v.config ?? "{}", adminConfig: null,
    })),
    records: spec.records,
    links: spec.links,
  };
}

let opSeqCounter = 1000;
function pullOp(partial: Partial<PullOp> & Pick<PullOp, "entityType" | "entityId" | "op" | "baseId">): PullOp {
  const seq = String(++opSeqCounter);
  return {
    seq, clientOpId: `cop-${seq}`, clientId: "srv", actorId: null,
    baseVersion: "0", newVersion: "1", payload: {}, result: "accepted", conflictOf: null,
    createdAt: new Date().toISOString(), ...partial,
  };
}
function basePullPage(baseId: string, ops: PullOp[], nextCursor: string, hasMore = false, authzVersion = 1): PullPage {
  return { baseId, ops, nextCursor, hasMore, authzVersion };
}
function treePullPage(ops: PullOp[], nextCursor: string, treeVersion: string, hasMore = false, authzVersion = 1): TreePullPage {
  return { scope: "workspace_tree", scopeId: "ws_default", ops, nextCursor, hasMore, treeVersion, authzVersion };
}

interface RecordedCall { name: string; args: unknown[] }
type Responder = (call: RecordedCall) => unknown;

class FakeTransport implements ReplicaPullTransport {
  calls: RecordedCall[] = [];
  constructor(private readonly responder: Responder) {}
  private run<T>(name: string, args: unknown[]): T {
    this.calls.push({ name, args });
    return this.responder({ name, args }) as T;
  }
  subscribeBase(baseId: string, clientId: string) {
    return this.run<Promise<SubscribeResult>>("subscribeBase", [baseId, clientId]);
  }
  subscribeTree(clientId: string) {
    return this.run<Promise<TreeSubscribeResult>>("subscribeTree", [clientId]);
  }
  fetchBootstrap(baseId: string, clientId: string, limit?: number) {
    return this.run<Promise<ReplicaBootstrapPage>>("fetchBootstrap", [baseId, clientId, limit]);
  }
  pullBase(baseId: string, after: bigint, clientId: string, limit: number) {
    return this.run<Promise<PullPage>>("pullBase", [baseId, after, clientId, limit]);
  }
  pullTree(after: bigint, clientId: string, limit: number) {
    return this.run<Promise<TreePullPage>>("pullTree", [after, clientId, limit]);
  }
}

const subOk: SubscribeResult = {
  clientId: CLIENT, scopeType: "base", scopeId: "", cursorSeq: "0", snapshotDone: false, authzVersion: 1,
};
const treeSubOk: TreeSubscribeResult = {
  ...subOk, scopeType: "workspace_tree", scopeId: "ws_default", scope: "workspace_tree", treeVersion: "0",
};

/** 按 (name, 首参 baseId) 返回脚本结果的简单响应器。 */
function scripted(script: Record<string, unknown>): Responder {
  const counters: Record<string, number> = {};
  return (call) => {
    if (call.name === "subscribeBase") return Promise.resolve({ ...subOk, scopeId: call.args[0] as string });
    if (call.name === "subscribeTree") return Promise.resolve(treeSubOk);
    // pullTree 首参是 after（BigInt，随游标变化），不能拿来做脚本键；树阶段每轮编排器总会执行一次，
    // 故 base-only 用例未显式编排树时默认回【空树页】（nextCursor 回显 after、hasMore:false），让树阶段
    // 自然 no-op；pullBase/fetchBootstrap 未编排仍抛错，以防用例夹具误配静默漏测。
    if (call.name === "pullTree") {
      const list = script["pullTree:__tree__"] as unknown[] | undefined;
      if (list === undefined) {
        return Promise.resolve(treePullPage([], String(call.args[0] ?? 0), "0", false));
      }
      const idx = counters.__tree__ ?? 0;
      counters.__tree__ = idx + 1;
      const v = list[Math.min(idx, list.length - 1)]!;
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v);
    }
    const key = `${call.name}:${String(call.args[0] ?? "")}`;
    const list = script[key] as unknown[] | undefined;
    if (list === undefined) throw new Error(`假 transport 未编排: ${key}`);
    const idx = counters[key] ?? 0;
    counters[key] = idx + 1;
    const v = list[Math.min(idx, list.length - 1)]!;
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v);
  };
}

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  h = await setupOrgHarness();
  mod = await import("../replicaPull.js");
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
}, 120_000);

afterAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  await h.cleanup();
});

async function sidecarCount(recordId: string): Promise<number> {
  const rows = await h.prisma.$queryRawUnsafe<unknown[]>(
    'SELECT COUNT(*) AS c FROM record_field_index WHERE "recordId" = ?',
    recordId,
  );
  return Number((rows[0] as { c: number | bigint }).c);
}

// ───────────────────────── ① off 默认零行为 ─────────────────────────

describe("① 默认关：pullReplicaOnce 零查零写", () => {
  it("GX_OFFLINE_REPLICA 未设 → ran:false、transport 零调用、replica_state/local_outbox 无写", async () => {
    const fake = new FakeTransport(() => { throw new Error("off 态不应触达 transport"); });
    const beforeState = await h.prisma.replicaState.count();
    const beforeOutbox = await h.prisma.localOutbox.count();
    const summary = await mod.pullReplicaOnce({
      transport: fake, ownerUserId: OWNER, baseIds: ["rp_base_off"], nodeId: NODE, clientId: CLIENT,
    });
    expect(summary.ran).toBe(false);
    expect(summary.transportError).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(await h.prisma.replicaState.count()).toBe(beforeState);
    expect(await h.prisma.localOutbox.count()).toBe(beforeOutbox);
  });
});

// ───────────────────────── ② 空副本引导 ─────────────────────────

describe("② 空副本 base：subscribe→bootstrap→空 pull，保 id 直插 + 游标=anchorSeq", () => {
  const BASE = "rp_base_b";
  const T = "rp_tbl_b";
  const PF = "rp_fld_b_pf";
  const QTY = "rp_fld_b_qty";
  const VIEW = "rp_view_b";
  const R1 = "rp_rec_b1";
  const C1 = "rp_rec_bc1";
  const FLINK = "rp_fld_b_link";
  const FREV = "rp_fld_b_rev";
  const TC = "rp_tbl_bc";
  const CPF = "rp_fld_bcpf";
  const L1 = "rp_link_b1";

  it("结构/record/link 保 cuid 落库，replica_state.pullCursorSeq=anchorSeq", () =>
    withReplicaOn(async () => {
      const page = bootstrapPage({
        base: { id: BASE, name: "B库" },
        anchorSeq: "100",
        tables: [
          { id: T, name: "主表", primaryFieldId: PF },
          { id: TC, name: "子表", primaryFieldId: CPF },
        ],
        fields: [
          field({ id: PF, tableId: T, name: "名称", type: "singleLineText", order: 0 }),
          field({ id: QTY, tableId: T, name: "数量", type: "number", order: 1 }),
          field({ id: CPF, tableId: TC, name: "名称", type: "singleLineText", order: 0 }),
          field({ id: FLINK, tableId: T, name: "子项", type: "links", order: 2,
            linkFieldId: FREV, relatedTableId: TC, relationKind: "hm" }),
          field({ id: FREV, tableId: TC, name: "子项反", type: "links", order: 1,
            linkFieldId: FLINK, reverseFieldId: FLINK, relatedTableId: T, relationKind: "hm", isReverse: true }),
        ],
        views: [{ id: VIEW, tableId: T, name: "网格" }],
        records: [
          { id: R1, tableId: T, fields: { [PF]: "甲", [QTY]: 3 } },
          { id: C1, tableId: TC, fields: { [CPF]: "子1" } },
        ],
        links: [{ id: L1, linkFieldId: FLINK, parentRowId: R1, childRowId: C1, ord: 0 }],
      });
      const emptyPull = basePullPage(BASE, [], "100", false);
      const fake = new FakeTransport(scripted({
        [`fetchBootstrap:${BASE}`]: [page],
        [`pullBase:${BASE}`]: [emptyPull],
      }));
      const summary = await mod.pullReplicaOnce({
        transport: fake, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT,
      });

      expect(summary.ran).toBe(true);
      expect(summary.transportError).toBe(false);
      const item = summary.bases.find((b) => b.baseId === BASE)!;
      expect(item.bootstrapped).toBe(true);
      expect(item.opsApplied).toBe(0);

      // 保 id 直插
      expect((await h.prisma.table.findUniqueOrThrow({ where: { id: T } })).primaryFieldId).toBe(PF);
      const fieldIds = (await h.prisma.field.findMany({ where: { tableId: T, deletedAt: null } })).map((f) => f.id).sort();
      expect(fieldIds).toEqual([FLINK, PF, QTY].sort());
      expect(await h.prisma.view.findUnique({ where: { id: VIEW } })).not.toBeNull();
      const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: R1 } });
      expect(JSON.parse(rec.fields)).toMatchObject({ [PF]: "甲", [QTY]: 3 });
      const link = await h.prisma.linkRow.findUniqueOrThrow({ where: { id: L1 } });
      expect(link.parentRowId).toBe(R1);
      expect(link.childRowId).toBe(C1);
      expect(link.deletedAt).toBeNull();

      const st = await h.prisma.replicaState.findUniqueOrThrow({
        where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } } });
      expect(st.pullCursorSeq).toBe(BigInt(100));
      expect(st.snapshotDone).toBe(true);
      // 下行不回流
      expect(await h.prisma.localOutbox.count()).toBe(0);
    }));
});

// ───────────────────────── ③ 增量三序：create_table→record create→record patch ─────────────────────────

describe("③ 增量一页三序：建表（保子实体 id）→ 建记录 → 改记录", () => {
  const BASE = "rp_base_c";
  const NEWT = "rp_tbl_c_new";
  const PF = "rp_fld_c_pf";
  const DEFAULTS = ["rp_fld_c_qty", "rp_fld_c_status", "rp_fld_c_date", "rp_fld_c_note"];
  const VIEW = "rp_view_c_grid";
  const REC = "rp_rec_c1";

  it("新表 5 字段/视图 id 与 payload 一致，记录值为 patch 后值，游标推进、opsApplied=3", () =>
    withReplicaOn(async () => {
      // 空 base 引导（无表），anchorSeq=5。
      const page = bootstrapPage({
        base: { id: BASE, name: "C库" }, anchorSeq: "5", tables: [], fields: [], views: [], records: [], links: [],
      });
      const createTable = pullOp({
        seq: "6", clientOpId: "cop-6", baseId: BASE, entityType: "table", entityId: NEWT, op: "create_table",
        payload: {
          name: "增量表", withDefaults: true, primaryFieldId: PF,
          defaultFieldIds: DEFAULTS, defaultViewId: VIEW,
        },
      });
      const recCreate = pullOp({
        seq: "7", clientOpId: "cop-7", baseId: BASE, entityType: "record", entityId: REC, op: "create",
        payload: { tableId: NEWT, changes: [{ fieldId: PF, fieldName: "名称", before: null, after: "初稿" }] },
      });
      const recPatch = pullOp({
        seq: "8", clientOpId: "cop-8", baseId: BASE, entityType: "record", entityId: REC, op: "patch",
        baseVersion: "1", newVersion: "2",
        payload: { tableId: NEWT, changes: [{ fieldId: PF, fieldName: "名称", before: "初稿", after: "定稿" }] },
      });
      const pullPage1 = basePullPage(BASE, [createTable, recCreate, recPatch], "8", false);
      const fake = new FakeTransport(scripted({
        [`fetchBootstrap:${BASE}`]: [page],
        [`pullBase:${BASE}`]: [pullPage1],
      }));
      const summary = await mod.pullReplicaOnce({
        transport: fake, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT,
      });

      const item = summary.bases.find((b) => b.baseId === BASE)!;
      expect(item.bootstrapped).toBe(true);
      expect(item.pages).toBe(1);
      expect(item.opsApplied).toBe(3);
      expect(item.skipped).toBe(0);

      const t = await h.prisma.table.findUniqueOrThrow({ where: { id: NEWT } });
      expect(t.name).toBe("增量表");
      expect(t.primaryFieldId).toBe(PF);
      const fieldIds = (await h.prisma.field.findMany({ where: { tableId: NEWT, deletedAt: null } }))
        .map((f) => f.id).sort();
      expect(fieldIds).toEqual([PF, ...DEFAULTS].sort());
      const v = await h.prisma.view.findUniqueOrThrow({ where: { id: VIEW } });
      expect(v.type).toBe("grid");
      expect(v.tableId).toBe(NEWT);
      const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: REC } });
      expect(JSON.parse(rec.fields)[PF]).toBe("定稿");

      const st = await h.prisma.replicaState.findUniqueOrThrow({
        where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } } });
      expect(st.pullCursorSeq).toBe(BigInt(8));
    }));
});

// ───────────────────────── ④ record delete/restore 不回流 ─────────────────────────

describe("④ record delete/restore：墓碑+link 软删+sidecar 撤，恢复撤销；全程不回流", () => {
  const BASE = "rp_base_d";
  const T = "rp_tbl_d";
  const PF = "rp_fld_d_pf";
  const TC = "rp_tbl_dc";
  const CPF = "rp_fld_dcpf";
  const FLINK = "rp_fld_d_link";
  const FREV = "rp_fld_d_rev";
  const VIEW = "rp_view_d";
  const R1 = "rp_rec_d1";
  const C1 = "rp_rec_dc1";
  const L1 = "rp_link_d1";

  async function boot(): Promise<ReplicaBootstrapPage> {
    return bootstrapPage({
      base: { id: BASE, name: "D库" }, anchorSeq: "10",
      tables: [{ id: T, name: "主", primaryFieldId: PF }, { id: TC, name: "子", primaryFieldId: CPF }],
      fields: [
        field({ id: PF, tableId: T, name: "名称", type: "singleLineText" }),
        field({ id: CPF, tableId: TC, name: "名称", type: "singleLineText" }),
        field({ id: FLINK, tableId: T, name: "子项", type: "links",
          linkFieldId: FREV, relatedTableId: TC, relationKind: "hm" }),
        field({ id: FREV, tableId: TC, name: "反", type: "links", isReverse: true,
          linkFieldId: FLINK, reverseFieldId: FLINK, relatedTableId: T, relationKind: "hm" }),
      ],
      views: [{ id: VIEW, tableId: T, name: "网格" }],
      records: [
        { id: R1, tableId: T, fields: { [PF]: "甲" } },
        { id: C1, tableId: TC, fields: { [CPF]: "子" } },
      ],
      links: [{ id: L1, linkFieldId: FLINK, parentRowId: R1, childRowId: C1, ord: 0 }],
    });
  }

  it("delete 软删行+link_row、撤 sidecar；restore 撤销+回填+重建；outbox/oplog/version 计数恒 0", () =>
    withReplicaOn(async () => {
      const page = await boot();
      // 引导后的空增量页（让 bootstrap 落地）。
      const fake0 = new FakeTransport(scripted({
        [`fetchBootstrap:${BASE}`]: [page], [`pullBase:${BASE}`]: [basePullPage(BASE, [], "10", false)],
      }));
      await mod.pullReplicaOnce({ transport: fake0, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT });
      expect(await sidecarCount(R1)).toBeGreaterThan(0);

      // delete
      const delOp = pullOp({ seq: "11", clientOpId: "cop-del", baseId: BASE, entityType: "record", entityId: R1, op: "delete",
        payload: { tableId: T, changes: [] } });
      const fake1 = new FakeTransport(scripted({ [`pullBase:${BASE}`]: [basePullPage(BASE, [delOp], "11", false)] }));
      const s1 = await mod.pullReplicaOnce({ transport: fake1, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT });
      expect(s1.bases[0]!.opsApplied).toBe(1);
      expect((await h.prisma.record.findUniqueOrThrow({ where: { id: R1 } })).deletedAt).toBeInstanceOf(Date);
      expect((await h.prisma.linkRow.findUniqueOrThrow({ where: { id: L1 } })).deletedAt).toBeInstanceOf(Date);
      expect(await sidecarCount(R1)).toBe(0);

      // restore
      const resOp = pullOp({ seq: "12", clientOpId: "cop-res", baseId: BASE, entityType: "record", entityId: R1, op: "restore",
        payload: { tableId: T, changes: [] } });
      const fake2 = new FakeTransport(scripted({ [`pullBase:${BASE}`]: [basePullPage(BASE, [resOp], "12", false)] }));
      const s2 = await mod.pullReplicaOnce({ transport: fake2, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT });
      expect(s2.bases[0]!.opsApplied).toBe(1);
      expect((await h.prisma.record.findUniqueOrThrow({ where: { id: R1 } })).deletedAt).toBeNull();
      expect((await h.prisma.linkRow.findUniqueOrThrow({ where: { id: L1 } })).deletedAt).toBeNull();
      expect(await sidecarCount(R1)).toBeGreaterThan(0);

      // 防回流关键断言
      expect(await h.prisma.localOutbox.count()).toBe(0);
      expect(await h.prisma.syncOpLog.count()).toBe(0);
      expect(await h.prisma.syncEntityVersion.count()).toBe(0);
    }));
});

// ───────────────────────── ⑤ 工作区树增量 ─────────────────────────

describe("⑤ 工作区树：create_group×2→move→reorder，空树首个 after=0，游标/treeVersion 推进", () => {
  const G1 = "rpgrp00001";
  const G2 = "rpgrp00002";

  it("navnode 落地且 G2 挂到 G1 下；replica_tree_state 游标/treeVersion 推进", () =>
    withReplicaOn(async () => {
      const ops: PullOp[] = [
        pullOp({ seq: "1", clientOpId: "tg1", baseId: null, entityType: "navnode", entityId: G1, op: "nav_create_group",
          payload: { name: "组1", parentId: null, ord: 0 } }),
        pullOp({ seq: "2", clientOpId: "tg2", baseId: null, entityType: "navnode", entityId: G2, op: "nav_create_group",
          payload: { name: "组2", parentId: null, ord: 1 } }),
        pullOp({ seq: "3", clientOpId: "tg3", baseId: null, entityType: "navnode", entityId: G2, op: "nav_move",
          payload: { to: { parentId: G1, ord: 0 } } }),
        // 服务端切面（nodes.ts）记 reorder 时 entityType 恒为 navnode、entityId=父位标识（根层 "root"）。
        pullOp({ seq: "4", clientOpId: "tg4", baseId: null, entityType: "navnode", entityId: "root", op: "nav_reorder",
          payload: { parentId: G1, orderedIds: [G2] } }),
      ];
      const fake = new FakeTransport(scripted({
        // 无 base 订阅；只编排树。
        "pullTree:__tree__": [treePullPage(ops, "4", "4", false)],
      }));
      const summary = await mod.pullReplicaOnce({
        transport: fake, ownerUserId: OWNER, baseIds: [], nodeId: NODE, clientId: CLIENT,
      });
      expect(summary.transportError).toBe(false);
      expect(summary.tree.pages).toBe(1);
      expect(summary.tree.opsApplied).toBe(4);
      expect(summary.tree.skipped).toBe(0);

      // 空副本树首个 pullTree 的 after 必须是 0。
      const treeCalls = fake.calls.filter((c) => c.name === "pullTree");
      expect(treeCalls).toHaveLength(1);
      expect(treeCalls[0]!.args[0]).toBe(0n);

      const g1 = await h.prisma.navNode.findFirstOrThrow({ where: { id: G1 } });
      const g2 = await h.prisma.navNode.findFirstOrThrow({ where: { id: G2 } });
      expect(g1.kind).toBe("group");
      expect(g2.parentId).toBe(G1);

      const ts = await h.prisma.replicaTreeState.findUniqueOrThrow({
        where: { nodeId_scopeId: { nodeId: NODE, scopeId: "ws_default" } } });
      expect(ts.pullCursorSeq).toBe(BigInt(4));
      expect(ts.treeVersion).toBe("4");
      expect(ts.snapshotDone).toBe(true);
    }));
});

// ───────────────────────── ⑥ 分页 + 第二页传输错：第一页游标不回滚 ─────────────────────────

describe("⑥ 分页：第一页提交后第二页 ReplicaTransportError → 停且第一页游标不回滚", () => {
  const BASE = "rp_base_f";
  const T = "rp_tbl_f";
  const PF = "rp_fld_f_pf";
  const VIEW = "rp_view_f";

  it("transportError=true，replica_state 停在第一页 nextCursor=20", () =>
    withReplicaOn(async () => {
      const page = bootstrapPage({
        base: { id: BASE, name: "F库" }, anchorSeq: "10",
        tables: [{ id: T, name: "F表", primaryFieldId: PF }],
        fields: [field({ id: PF, tableId: T, name: "名称", type: "singleLineText" })],
        views: [{ id: VIEW, tableId: T, name: "网格" }], records: [], links: [],
      });
      const recOp = pullOp({ baseId: BASE, entityType: "record", entityId: "rp_rec_f1", op: "create",
        payload: { tableId: T, changes: [{ fieldId: PF, fieldName: "名称", before: null, after: "x" }] } });
      const page1 = basePullPage(BASE, [recOp], "20", true);
      const page2Err = new mod.ReplicaTransportError("ECONNRESET");
      const fake = new FakeTransport(scripted({
        [`fetchBootstrap:${BASE}`]: [page],
        [`pullBase:${BASE}`]: [page1, page2Err],
      }));
      const summary = await mod.pullReplicaOnce({
        transport: fake, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT,
      });
      expect(summary.transportError).toBe(true);
      const item = summary.bases.find((b) => b.baseId === BASE)!;
      expect(item.pages).toBe(1);
      expect(item.opsApplied).toBe(1);
      const st = await h.prisma.replicaState.findUniqueOrThrow({
        where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } } });
      expect(st.pullCursorSeq).toBe(BigInt(20));
      // 第一页记录确实落库。
      expect(await h.prisma.record.findUnique({ where: { id: "rp_rec_f1" } })).not.toBeNull();
    }));
});

// ───────────────────────── ⑦ 未知/未登记 op → skipped ─────────────────────────

describe("⑦ 未登记结构 op / 未知 record op / 未登记树 op → skipped，不抛、游标推进", () => {
  const BASE = "rp_base_g";

  it("三类未知 op 全 skipped，opsApplied=0，游标仍推进到 nextCursor", () =>
    withReplicaOn(async () => {
      const page = bootstrapPage({
        base: { id: BASE, name: "G库" }, anchorSeq: "0", tables: [], fields: [], views: [], records: [], links: [],
      });
      const ops: PullOp[] = [
        pullOp({ baseId: BASE, entityType: "table", entityId: "rp_tbl_x", op: "frobnicate_table", payload: {} }),
        pullOp({ baseId: BASE, entityType: "record", entityId: "rp_rec_x", op: "explode", payload: { tableId: "t", changes: [] } }),
        pullOp({ baseId: null, entityType: "navnode", entityId: "rpgrp_x", op: "nav_frobnicate", payload: {} }),
        pullOp({ baseId: BASE, entityType: "doc", entityId: "d1", op: "yjs_merge", payload: {} }),
      ];
      const fake = new FakeTransport(scripted({
        [`fetchBootstrap:${BASE}`]: [page],
        [`pullBase:${BASE}`]: [basePullPage(BASE, ops.slice(0, 2).concat(ops[3]!), "77", false)],
        "pullTree:__tree__": [treePullPage([ops[2]!], "77", "1", false)],
      }));
      const summary = await mod.pullReplicaOnce({
        transport: fake, ownerUserId: OWNER, baseIds: [BASE], nodeId: NODE, clientId: CLIENT,
      });
      expect(summary.transportError).toBe(false);
      const item = summary.bases.find((b) => b.baseId === BASE)!;
      expect(item.opsApplied).toBe(0);
      expect(item.skipped).toBe(3); // 未登记结构 + 未知 record + doc 族
      expect(summary.tree.skipped).toBe(1);
      const st = await h.prisma.replicaState.findUniqueOrThrow({
        where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } } });
      expect(st.pullCursorSeq).toBe(BigInt(77));
    }));
});

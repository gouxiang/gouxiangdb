// S3b-2 空副本保 id 引导【写接缝】契约测试：importReplicaBootstrap(Tx) 把 ReplicaBootstrapPage
// 在单 withWriteTx 内原样保 cuid 落库（真迁移临时库，不 mock；不碰 dev.db）。
// 设计权威：DESIGN-OFFLINE-SYNC §6/§8.4/§9.4/§11；默认关、只增不毁、下行不写 outbox/oplog。
//
// 骨架对齐 yn10/yn2a：顶部仅静态 import vitest + setupOrgHarness（+ type）；beforeAll 先
// delete GX_OFFLINE_REPLICA 再 setupOrgHarness（off 建库）；db 依赖链（replicaBootstrapImport →
// db/nav/fieldIndex/authz）一律在 harness 注入临时 DATABASE_URL 后【动态 import】，防单例
// PrismaClient 先绑真实 dev.db；withEnv 在各用例内进程内开 GX_OFFLINE_REPLICA。
//
// page 用【手工 fixture】（单临时库即可，id 用全新固定 token，不与库内任何行冲突）。
// 不依赖服务端 /bootstrap 端点（读接缝由 yn10 端到端覆盖）；build→import 跨库冒烟端到端归 S3b-3。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";
import type { ReplicaBootstrapPage } from "../../../../domain/sync/bootstrap.js";

let h: OrgHarness;
const OWNER = "yn11_owner";
const NODE = "local";

function withEnv<K>(key: string, value: string | undefined, fn: () => Promise<K>): Promise<K> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

// ---- 固定 id（保 id 直插断言用；cuid 列本质 String，任意唯一串即可，无格式校验）----
const BASE = "yn11base0001";
const T_MAIN = "yn11tblmain01";
const T_CHILD = "yn11tblchild1";
const F_MAIN_PF = "yn11fldmainpf";
const F_CHILD_PF = "yn11fldchldpf";
const F_LINK = "yn11fldlinkfwd"; // 正向（挂主表）
const F_REV = "yn11fldlinkrev"; // 反向（挂子表）
const F_LOOKUP = "yn11fldlookup";
const F_ROLLUP = "yn11fldrollup";
const F_FORMULA = "yn11fldformula";
const V_MAIN = "yn11viewmain";
const V_CHILD = "yn11viewchild";
const R1 = "yn11recmain01";
const C1 = "yn11recchild1";
const C2 = "yn11recchild2";
const L1 = "yn11linkrow01";
const L2 = "yn11linkrow02";

/** 手工引导页：1 base / 2 表 / 一对 hm 正反向字段（不对称互指）+ lookup/rollup/formula /
 *  每表 1 grid 视图 / 3 记录 / 2 link_rows。 */
function makePage(kind: ReplicaBootstrapPage["kind"] = "replica-bootstrap"): ReplicaBootstrapPage {
  return {
    kind,
    baseId: BASE,
    anchorSeq: "42",
    authzVersion: 7,
    serverTime: new Date().toISOString(),
    recordsTruncated: false,
    base: { id: BASE, name: "yn11 库", icon: null, iconColor: "#123456", shareEnabled: 1 },
    tables: [
      { id: T_MAIN, name: "main", primaryFieldId: F_MAIN_PF, icon: null, iconColor: null, shareEnabled: 0 },
      { id: T_CHILD, name: "child", primaryFieldId: F_CHILD_PF, icon: null, iconColor: null, shareEnabled: 0 },
    ],
    fields: [
      { id: F_MAIN_PF, tableId: T_MAIN, name: "名称", type: "singleLineText", description: "", order: 0, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: null, relatedTableId: null, relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      { id: F_CHILD_PF, tableId: T_CHILD, name: "名称", type: "singleLineText", description: "", order: 0, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: null, relatedTableId: null, relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      // 正向：linkFieldId 指向反向、reverseFieldId=null（fieldServiceTx 实测不对称形状）。
      { id: F_LINK, tableId: T_MAIN, name: "子项", type: "links", description: "", order: 1, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: F_REV, relatedTableId: T_CHILD, relationKind: "hm", isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      // 反向：linkFieldId 与 reverseFieldId 都指正向。
      { id: F_REV, tableId: T_CHILD, name: "子项（反向）", type: "links", description: "", order: 1, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: F_LINK, relatedTableId: T_MAIN, relationKind: "hm", isReverse: true, reverseFieldId: F_LINK, linkDisplayFieldId: null, lookupFieldId: null, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      { id: F_LOOKUP, tableId: T_MAIN, name: "查子名", type: "lookup", description: "lk", order: 2, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: '{"op":"and"}', linkFieldId: F_REV, relatedTableId: T_CHILD, relationKind: "hm", isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: F_CHILD_PF, rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      { id: F_ROLLUP, tableId: T_MAIN, name: "汇总", type: "rollup", description: "", order: 3, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: F_REV, relatedTableId: T_CHILD, relationKind: "hm", isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: F_CHILD_PF, rollupFunction: "sum", formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
      { id: F_FORMULA, tableId: T_MAIN, name: "公式", type: "formula", description: "", order: 4, required: false, unique: false, options: null, maxLength: null, defaultNow: false, precision: null, recordFilter: null, linkFieldId: null, relatedTableId: null, relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null, rollupFunction: null, formula: "1+2", tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null, defaultConfig: null, numberRule: null },
    ],
    views: [
      { id: V_MAIN, tableId: T_MAIN, name: "网格", type: "grid", lockMode: "collaborative", order: 0, config: '{"x":1}', adminConfig: '{"locked":true}' },
      { id: V_CHILD, tableId: T_CHILD, name: "网格", type: "grid", lockMode: "collaborative", order: 0, config: '{"y":2}', adminConfig: null },
    ],
    records: [
      { id: R1, tableId: T_MAIN, fields: { [F_MAIN_PF]: "甲" } },
      { id: C1, tableId: T_CHILD, fields: { [F_CHILD_PF]: "子1" } },
      { id: C2, tableId: T_CHILD, fields: { [F_CHILD_PF]: "子2" } },
    ],
    links: [
      { id: L1, linkFieldId: F_LINK, parentRowId: R1, childRowId: C1, ord: 0 },
      { id: L2, linkFieldId: F_LINK, parentRowId: R1, childRowId: C2, ord: 1 },
    ],
  };
}

let importReplicaBootstrap: typeof import("../../../../domain/sync/replicaBootstrapImport.js").importReplicaBootstrap;
let navNodeId: typeof import("../../../../domain/nav/backfill.js").nodeId;

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA; // off 态建库
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
  const mod = await import("../../../../domain/sync/replicaBootstrapImport.js");
  importReplicaBootstrap = mod.importReplicaBootstrap;
  navNodeId = (await import("../../../../domain/nav/backfill.js")).nodeId;
}, 120_000);

afterAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  await h.cleanup();
});

async function sidecarRows(tableId: string): Promise<Record<string, unknown>[]> {
  const rows = await h.prisma.$queryRawUnsafe<unknown[]>(
    'SELECT * FROM record_field_index WHERE "tableId" = ?',
    tableId,
  );
  return rows as Record<string, unknown>[];
}

describe("A. 默认 off：门面零查零写", () => {
  it("GX_OFFLINE_REPLICA 未设 -> ran=false，库内无 base/replica_state/local_outbox", async () => {
    const r = await importReplicaBootstrap(makePage(), { ownerUserId: OWNER, nodeId: NODE });
    expect(r.ran).toBe(false);
    expect(r.alreadyBootstrapped).toBe(false);
    expect(r.counts).toEqual({ tables: 0, fields: 0, views: 0, records: 0, links: 0 });
    expect(await h.prisma.base.findUnique({ where: { id: BASE } })).toBeNull();
    expect(await h.prisma.replicaState.count()).toBe(0);
    expect(await h.prisma.localOutbox.count()).toBe(0);
  });
});

describe("B. on + happy：保 id 落库 + 成员/视野 + 派生物 + 记账", () => {
  it("结构/记录/links 字节一致，member+admin scope+owner 投影+nav+sidecar+replica_state 齐全", () =>
    withEnv("GX_OFFLINE_REPLICA", "on", async () => {
      const page = makePage();
      const r = await importReplicaBootstrap(page, { ownerUserId: OWNER, nodeId: NODE });
      expect(r.ran).toBe(true);
      expect(r.alreadyBootstrapped).toBe(false);
      expect(r.localBaseId).toBe(BASE);
      expect(r.anchorSeq).toBe("42");
      expect(r.counts).toEqual({ tables: 2, fields: 7, views: 2, records: 3, links: 2 });

      // base（保 id；createdBy 重映射本地属主；活库）。
      const b = await h.prisma.base.findUniqueOrThrow({ where: { id: BASE } });
      expect(b.name).toBe("yn11 库");
      expect(b.iconColor).toBe("#123456");
      expect(b.shareEnabled).toBe(1);
      expect(b.createdBy).toBe(OWNER);
      expect(b.deletedAt).toBeNull();

      // tables（primaryFieldId 直接保页值）。
      const tables = await h.prisma.table.findMany({ where: { baseId: BASE } });
      expect(tables.map((t) => t.id).sort()).toEqual([T_CHILD, T_MAIN]);
      expect(tables.find((t) => t.id === T_MAIN)!.primaryFieldId).toBe(F_MAIN_PF);
      expect(tables.every((t) => t.createdBy === OWNER && t.deletedAt === null)).toBe(true);

      // fields：正反向不对称互指 + lookup/rollup/formula 原样列不丢。
      const fwd = await h.prisma.field.findUniqueOrThrow({ where: { id: F_LINK } });
      expect(fwd.linkFieldId).toBe(F_REV);
      expect(fwd.reverseFieldId).toBeNull();
      expect(fwd.relatedTableId).toBe(T_CHILD);
      expect(fwd.relationKind).toBe("hm");
      expect(fwd.isReverse).toBe(false);
      const rev = await h.prisma.field.findUniqueOrThrow({ where: { id: F_REV } });
      expect(rev.linkFieldId).toBe(F_LINK);
      expect(rev.reverseFieldId).toBe(F_LINK);
      expect(rev.isReverse).toBe(true);
      const lookup = await h.prisma.field.findUniqueOrThrow({ where: { id: F_LOOKUP } });
      expect(lookup.lookupFieldId).toBe(F_CHILD_PF);
      expect(lookup.recordFilter).toBe('{"op":"and"}');
      const rollup = await h.prisma.field.findUniqueOrThrow({ where: { id: F_ROLLUP } });
      expect(rollup.rollupFunction).toBe("sum");
      const formula = await h.prisma.field.findUniqueOrThrow({ where: { id: F_FORMULA } });
      expect(formula.formula).toBe("1+2");
      expect(await h.prisma.field.count({ where: { tableId: T_MAIN, deletedAt: null } })).toBe(5);

      // views（config/adminConfig 原样字符串）。
      const vm = await h.prisma.view.findUniqueOrThrow({ where: { id: V_MAIN } });
      expect(vm.tableId).toBe(T_MAIN);
      expect(JSON.parse(vm.config)).toEqual({ x: 1 });
      expect(vm.adminConfig).toBe('{"locked":true}');
      const vc = await h.prisma.view.findUniqueOrThrow({ where: { id: V_CHILD } });
      expect(vc.adminConfig).toBeNull();

      // records（保 id；fields JSON 往返一致；属主重映射）。
      const recs = await h.prisma.record.findMany({ where: { tableId: { in: [T_MAIN, T_CHILD] } } });
      expect(recs.map((x) => x.id).sort()).toEqual([C1, C2, R1]);
      const r1 = recs.find((x) => x.id === R1)!;
      expect(JSON.parse(r1.fields)).toEqual({ [F_MAIN_PF]: "甲" });
      expect(r1.createdBy).toBe(OWNER);
      expect(r1.updatedBy).toBe(OWNER);
      expect(r1.deletedAt).toBeNull();

      // link_rows：保 id/ord，正向字段，两端即导入记录。
      const links = await h.prisma.linkRow.findMany({ orderBy: { ord: "asc" } });
      expect(links.map((l) => ({ id: l.id, f: l.linkFieldId, p: l.parentRowId, c: l.childRowId, ord: l.ord })))
        .toEqual([
          { id: L1, f: F_LINK, p: R1, c: C1, ord: 0 },
          { id: L2, f: F_LINK, p: R1, c: C2, ord: 1 },
        ]);

      // member（owner）+ 库节点 owner legacy 投影 + 库级管理员视野。
      const m = await h.prisma.member.findUniqueOrThrow({
        where: { baseId_userId: { baseId: BASE, userId: OWNER } },
      });
      expect(m.role).toBe("owner");
      const pol = await h.prisma.authPolicy.findFirst({
        where: { nodeId: navNodeId("base", BASE), subjectType: "user", subjectId: OWNER },
      });
      expect(pol).not.toBeNull();
      expect(pol!.reason).toBe("legacy:member");
      expect(pol!.actions).toContain("r");
      const adminScope = await h.prisma.roleLibraryScope.findFirst({
        where: { roleId: "role_admin", libraryKind: "base", libraryId: BASE },
      });
      expect(adminScope).not.toBeNull();
      expect(adminScope!.canManage).toBe(1);
      expect(adminScope!.visible).toBe(1);

      // replica_state 记账游标。
      const st = await h.prisma.replicaState.findUniqueOrThrow({
        where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } },
      });
      expect(st.localBaseId).toBe(BASE);
      expect(st.pullCursorSeq).toBe(BigInt(42));
      expect(st.snapshotDone).toBe(true);
      expect(st.subscribed).toBe(false);
      expect(st.authzVersion).toBe("7");
      expect(st.lastPulledAt).toBeInstanceOf(Date);

      // nav：base→table→view 节点齐全且父子正确（活节点）。
      const nBase = await h.prisma.navNode.findUniqueOrThrow({ where: { id: navNodeId("base", BASE) } });
      expect(nBase.deletedAt).toBeNull();
      const nTable = await h.prisma.navNode.findUniqueOrThrow({ where: { id: navNodeId("table", T_MAIN) } });
      expect(nTable.parentId).toBe(navNodeId("base", BASE));
      const nView = await h.prisma.navNode.findUniqueOrThrow({ where: { id: navNodeId("view", V_MAIN) } });
      expect(nView.parentId).toBe(navNodeId("table", T_MAIN));

      // fieldIndex sidecar：主表主字段是 singleLineText，甲 落一条文本索引行。
      const idx = await sidecarRows(T_MAIN);
      const hit = idx.find((x) => x.recordId === R1 && x.fieldId === F_MAIN_PF);
      expect(hit).toBeTruthy();
      expect(hit!.valueText).toBe("甲");
    }));
});

describe("C. 幂等/守卫", () => {
  it("已 snapshotDone 再导 -> alreadyBootstrapped=true、零计数、行数不增", () =>
    withEnv("GX_OFFLINE_REPLICA", "on", async () => {
      const before = {
        table: await h.prisma.table.count(),
        field: await h.prisma.field.count(),
        record: await h.prisma.record.count(),
        link: await h.prisma.linkRow.count(),
        state: await h.prisma.replicaState.count(),
      };
      const r = await importReplicaBootstrap(makePage(), { ownerUserId: OWNER, nodeId: NODE });
      expect(r.ran).toBe(true);
      expect(r.alreadyBootstrapped).toBe(true);
      expect(r.counts).toEqual({ tables: 0, fields: 0, views: 0, records: 0, links: 0 });
      expect(await h.prisma.table.count()).toBe(before.table);
      expect(await h.prisma.field.count()).toBe(before.field);
      expect(await h.prisma.record.count()).toBe(before.record);
      expect(await h.prisma.linkRow.count()).toBe(before.link);
      expect(await h.prisma.replicaState.count()).toBe(before.state);
    }));

  it("page.kind 非法 -> 抛错", () =>
    withEnv("GX_OFFLINE_REPLICA", "on", async () => {
      const bad = makePage("not-bootstrap" as unknown as ReplicaBootstrapPage["kind"]);
      await expect(importReplicaBootstrap(bad, { ownerUserId: OWNER, nodeId: NODE }))
        .rejects.toThrow(/replica-bootstrap/);
    }));
});

describe("D. 下行快照不污染正向同步轨", () => {
  it("导入后 local_outbox / sync_op_log / sync_entity_versions 计数均为 0", () =>
    withEnv("GX_OFFLINE_REPLICA", "on", async () => {
      expect(await h.prisma.localOutbox.count()).toBe(0);
      expect(await h.prisma.syncOpLog.count()).toBe(0);
      expect(await h.prisma.syncEntityVersion.count()).toBe(0);
    }));
});

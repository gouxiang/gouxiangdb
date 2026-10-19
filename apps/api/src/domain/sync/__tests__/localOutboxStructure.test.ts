// beta.2 S2c commit1：结构轨（table/field/view）离线发件箱切面契约测试
// （真临时库 + 真迁移 + 真 wrapper/withWriteTx，不 mock；复用 orgHarness）。
// 设计权威：DESIGN-OFFLINE-SYNC §5.1/§19.1/§19.2。
//
// 覆盖：
//  off 默认关：在线 createTable（wrapper）→ local_outbox 0 行、表建成（零行为锚点）。
//  on：在线 createTable + add_field + create_view 各 1 条 outbox；entityType/op/baseId 正确；
//      该表 table_schema 钟随结构 op 递增；sync_op_log 有 clientId=c1 且 clientOpId 与 outbox 相同。
//  回放安全：push 结构回放走 structureRegistry → *Tx 原语层（createTableTx），物理上不经 wrapper，
//      故即便副本 on，local_outbox 也零新增（但结构 oplog/钟照常推进）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "s2cs_owner";

let baseId = "";

const ENV_KEYS = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID", "GX_OFFLINE_CLIENT_ID"] as const;
type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;
function snapshotEnv(): EnvSnapshot {
  const s = {} as EnvSnapshot;
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
async function withReplicaOn<T>(fn: () => Promise<T>): Promise<T> {
  const prev = snapshotEnv();
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = "n1";
  process.env.GX_OFFLINE_CLIENT_ID = "c1";
  try {
    return await fn();
  } finally {
    restoreEnv(prev);
  }
}

beforeAll(async () => {
  // 刻意不设 GX_SYNC_SERVER（off）：证明副本切面独立——仅 GX_OFFLINE_REPLICA=on 也能推进
  // 本地 table_schema 钟/落本地 oplog；服务端切面 recordStructureOpTx 此时仍 return null。
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../libraryService.js");
  const base = await createBase({ name: "s2cs", withStarter: false }, OWNER);
  baseId = base.id;
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.cleanup();
});

async function schemaVersion(tableId: string): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: `table_schema:${tableId}` },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

describe("默认关：结构写零行为锚点", () => {
  it("GX_OFFLINE_REPLICA 未设时在线 createTable 建成表，但 local_outbox 0 行", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const { createTable } = await import("../../tableService.js");
      const before = await h.prisma.localOutbox.count();
      const t = await createTable({ baseId, name: "s2cs_off" }, OWNER);
      const tbl = await h.prisma.table.findUniqueOrThrow({ where: { id: t.tableId } });
      expect(tbl.name).toBe("s2cs_off");
      expect(await h.prisma.localOutbox.count()).toBe(before);
      expect(await h.prisma.localOutbox.count()).toBe(0);
    } finally {
      restoreEnv(prev);
    }
  });
});

describe("on：结构直写同事务落 outbox + 推进 table_schema 钟", () => {
  it("create_table / add_field / create_view 各 1 条 outbox，钟递增，oplog c1 同 clientOpId", () =>
    withReplicaOn(async () => {
      const { createTable } = await import("../../tableService.js");
      const { createField } = await import("../../fieldService.js");
      const { createView } = await import("../../viewService.js");

      // 1) create_table
      const t = await createTable({ baseId, name: "s2cs_on" }, OWNER);
      const tableRows = await h.prisma.localOutbox.findMany({ where: { entityId: t.tableId, op: "create_table" } });
      expect(tableRows).toHaveLength(1);
      const tableRow = tableRows[0]!;
      expect(tableRow.status).toBe("pending");
      expect(tableRow.entityType).toBe("table");
      expect(tableRow.nodeId).toBe("n1");
      expect(tableRow.baseId).toBe(baseId);
      expect(tableRow.baseVersion).toBe(0n);
      expect(await schemaVersion(t.tableId)).toBe(1n);
      const tableOp = await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", clientOpId: tableRow.clientOpId },
      });
      expect(tableOp.newVersion).toBe(1n);

      // 2) add_field（结构钟 1→2）
      const f = await createField({ tableId: t.tableId, name: "新字段", type: "text" }, OWNER);
      const fieldRows = await h.prisma.localOutbox.findMany({ where: { entityId: f.field.id, op: "add_field" } });
      expect(fieldRows).toHaveLength(1);
      const fieldRow = fieldRows[0]!;
      expect(fieldRow.entityType).toBe("field");
      expect(fieldRow.baseId).toBe(baseId);
      expect(fieldRow.baseVersion).toBe(1n);
      expect(await schemaVersion(t.tableId)).toBe(2n);
      await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", clientOpId: fieldRow.clientOpId },
      });

      // 3) create_view（结构钟 2→3）
      const v = await createView({ tableId: t.tableId, name: "视图A", type: "grid" }, OWNER);
      const viewRows = await h.prisma.localOutbox.findMany({ where: { entityId: v.id, op: "create_view" } });
      expect(viewRows).toHaveLength(1);
      const viewRow = viewRows[0]!;
      expect(viewRow.entityType).toBe("view");
      expect(viewRow.baseId).toBe(baseId);
      expect(viewRow.baseVersion).toBe(2n);
      expect(await schemaVersion(t.tableId)).toBe(3n);
      await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", clientOpId: viewRow.clientOpId },
      });

      // payload 形状：{op,entityType,tableId,...payload} 可 parse 回对象。
      const tablePayload = JSON.parse(tableRow.payload) as {
        op: string; entityType: string; tableId: string; name?: string;
      };
      expect(tablePayload.op).toBe("create_table");
      expect(tablePayload.entityType).toBe("table");
      expect(tablePayload.tableId).toBe(t.tableId);
      expect(tablePayload.name).toBe("s2cs_on");
    }));
});

describe("回放安全：*Tx 原语层不经 wrapper，不进 local_outbox", () => {
  it("即便副本 on，直接调 createTableTx（structureRegistry 回放路径）local_outbox 零新增", () =>
    withReplicaOn(async () => {
      const { withWriteTx } = await import("../../../db.js");
      const { createTableTx } = await import("../../tableServiceTx.js");
      const replayTableId = `tbl_s2cs_replay_${Date.now().toString(36)}`;

      const before = await h.prisma.localOutbox.count();

      // push 结构回放物理上走这里（Tx 原语层），不经 tableService.createTable wrapper。
      await withWriteTx("s2cs.replay.createTable", (tx) =>
        createTableTx(tx, { baseId, name: "s2cs_replay", withDefaults: false, userId: OWNER, tableId: replayTableId }));

      expect(await h.prisma.localOutbox.count()).toBe(before);

      // 但结构 op 若由回放引擎经 writeStructureOpTx 记账（这里直接验证 wrapper 未被触达即可）：
      // 表确实建成。
      const tbl = await h.prisma.table.findUniqueOrThrow({ where: { id: replayTableId } });
      expect(tbl.name).toBe("s2cs_replay");
    }));
});

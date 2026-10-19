// beta.2 S2b：record 轨离线发件箱写切面契约测试（真临时库 + 真迁移 + 真写事务，不 mock）。
// 设计权威：DESIGN-OFFLINE-SYNC §5.1/§5.2/§5.3。
//
// 覆盖：
//  off 默认关：直写不写 local_outbox（零行为回归锚点），业务记录正常建成。
//  on + 直写：create 落 1 行 pending outbox + 本地版本钟推进 + 本地 oplog（clientId=c1），
//             outbox.clientOpId 与 oplog.clientOpId 完全相同（贯穿幂等）。
//  连续两次 update：两条 outbox，baseVersion 依次 1、2（本地钟随直写递增）。
//  delete / restore：各一条 outbox，op 正确、changes 为空数组。
//  防回放循环：以 push 回放身份（传 sync.identity 走 if(sync) 分支）create/update，
//             即便 GX_OFFLINE_REPLICA=on，local_outbox 也【零新增】。
//  payload：JSON.parse 可回对象且 op/entityType/tableId/changes 齐全。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "s2b_owner";

let baseId = "";
let tableId = "";
let pf = "";

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
/** 开启副本切面（真实设置进程 env，切面在事务内【调用时】读取）。 */
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
  // 刻意不设 GX_SYNC_SERVER（off）：证明副本切面独立于服务端总门——仅 GX_OFFLINE_REPLICA=on
  // 也能推进本地版本钟/落本地 oplog，而服务端切面 recordSyncOpTx 此时仍 return null。
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../libraryService.js");
  const { createTable } = await import("../../tableService.js");
  const base = await createBase({ name: "s2b", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "dep" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.cleanup();
});

async function loadFields() {
  const { loadTableFields } = await import("../../recordService.js");
  return loadTableFields(tableId);
}

async function onlineCreate(recordId: string, value: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { createRecordTx } = await import("../../recordWrite.js");
  const fields = await loadFields();
  return await withWriteTx("s2b.create", (tx) =>
    createRecordTx(tx, {
      tableId, recordId, payloadFields: { [pf]: value }, fields, userId: OWNER, isDraft: false,
    }));
}

async function onlineUpdate(recordId: string, value: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { updateRecordTx } = await import("../../recordWrite.js");
  const fields = await loadFields();
  return await withWriteTx("s2b.update", (tx) =>
    updateRecordTx(tx, {
      tableId, recordId, patch: { [pf]: value }, fields, userId: OWNER,
    }));
}

async function onlineDelete(recordId: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { softDeleteRecordTx } = await import("../../recordWrite.js");
  return await withWriteTx("s2b.delete", (tx) => softDeleteRecordTx(tx, recordId, OWNER));
}

async function onlineRestore(recordId: string) {
  const { withWriteTx } = await import("../../../db.js");
  const { restoreRecordTx } = await import("../../recordWrite.js");
  return await withWriteTx("s2b.restore", (tx) => restoreRecordTx(tx, recordId, tableId, OWNER));
}

describe("默认关：零行为回归锚点", () => {
  it("GX_OFFLINE_REPLICA 未设时直写建成记录，但 local_outbox 0 行", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const before = await h.prisma.localOutbox.count();
      const rec = await onlineCreate("rec_s2b_off", "off 值");
      const stored = await h.prisma.record.findUniqueOrThrow({ where: { id: rec.id } });
      expect(stored.id).toBe("rec_s2b_off");
      expect(await h.prisma.localOutbox.count()).toBe(before);
      expect(await h.prisma.localOutbox.count()).toBe(0);
    } finally {
      restoreEnv(prev);
    }
  });
});

describe("on：直写同事务落 outbox + 推进本地钟", () => {
  it("create：1 行 pending outbox（nodeId/payload/baseVersion=0），版本=1，oplog c1 同 clientOpId", () =>
    withReplicaOn(async () => {
      const recId = "rec_s2b_on_create";
      const r = await onlineCreate(recId, "on 值");
      expect(r.id).toBe(recId);

      const rows = await h.prisma.localOutbox.findMany({ where: { entityId: recId } });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.entityType).toBe("record");
      expect(row.op).toBe("create");
      expect(row.nodeId).toBe("n1");
      expect(row.baseId).toBe(baseId);
      expect(row.baseVersion).toBe(0n);

      // payload 可 parse 且字段齐全。
      const payload = JSON.parse(row.payload) as {
        op: string; entityType: string; tableId: string; changes: unknown[];
      };
      expect(payload.op).toBe("create");
      expect(payload.entityType).toBe("record");
      expect(payload.tableId).toBe(tableId);
      expect(Array.isArray(payload.changes)).toBe(true);

      // 本地 per-entity 版本钟推进到 1。
      const ver = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: recId } });
      expect(ver.version).toBe(1n);

      // 本地 oplog 以 clientId=c1 留痕，且 clientOpId 与 outbox 完全相同。
      const op = await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", entityId: recId },
      });
      expect(op.clientOpId).toBe(row.clientOpId);
      expect(op.newVersion).toBe(1n);
      expect(row.clientOpId.startsWith("local-")).toBe(true);
    }));

  it("连续两次 update：两条 outbox，baseVersion 依次 1、2，第二条 op=update", () =>
    withReplicaOn(async () => {
      const recId = "rec_s2b_on_updates";
      await onlineCreate(recId, "v0");
      await onlineUpdate(recId, "v1");
      await onlineUpdate(recId, "v2");

      const updates = await h.prisma.localOutbox.findMany({
        where: { entityId: recId, op: "update" },
        orderBy: { createdAt: "asc" },
      });
      expect(updates).toHaveLength(2);
      expect(updates[0]!.baseVersion).toBe(1n);
      expect(updates[1]!.baseVersion).toBe(2n);

      const ver = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: recId } });
      expect(ver.version).toBe(3n);
    }));

  it("delete 与 restore 各一条 outbox，op 正确、changes 为空数组", () =>
    withReplicaOn(async () => {
      const recId = "rec_s2b_on_lifecycle";
      await onlineCreate(recId, "life");
      await onlineDelete(recId);
      await onlineRestore(recId);

      const rows = await h.prisma.localOutbox.findMany({
        where: { entityId: recId, op: { in: ["delete", "restore"] } },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => r.op)).toEqual(["delete", "restore"]);
      for (const r of rows) {
        const payload = JSON.parse(r.payload) as { changes: unknown[] };
        expect(payload.changes).toEqual([]);
      }
    }));
});

describe("防回放循环：push 回放身份绝不进 outbox", () => {
  it("即便副本 on，带 sync.identity 的 create/update（if(sync) 分支）local_outbox 零新增", () =>
    withReplicaOn(async () => {
      const { withWriteTx } = await import("../../../db.js");
      const { createRecordTx, updateRecordTx } = await import("../../recordWrite.js");
      const fields = await loadFields();
      const recId = "rec_s2b_replay";

      const before = await h.prisma.localOutbox.count();

      // create 回放：期望写前版本 0。
      await withWriteTx("s2b.replay.create", (tx) =>
        createRecordTx(tx, {
          tableId, recordId: recId, payloadFields: { [pf]: "replay" }, fields, userId: OWNER,
          isDraft: false,
          sync: { identity: { clientId: "devA", clientOpId: "x1", clientBaseVersion: 0n, expectedBaseVersion: 0n }, op: "create" },
        }));

      // create 回放后版本=1；update 回放期望写前版本 1（op=patch）。
      await withWriteTx("s2b.replay.update", (tx) =>
        updateRecordTx(tx, {
          tableId, recordId: recId, patch: { [pf]: "replay2" }, fields, userId: OWNER,
          sync: { identity: { clientId: "devA", clientOpId: "x2", clientBaseVersion: 1n, expectedBaseVersion: 1n }, op: "patch" },
        }));

      expect(await h.prisma.localOutbox.count()).toBe(before);

      // 回放确实走了 writeSyncOpTx（devA oplog 留痕、版本推进），只是没进本地发件箱。
      const devOps = await h.prisma.syncOpLog.findMany({ where: { clientId: "devA" } });
      expect(devOps.map((o) => o.clientOpId).sort()).toEqual(["x1", "x2"]);
      const ver = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: recId } });
      expect(ver.version).toBe(2n);
    }));
});

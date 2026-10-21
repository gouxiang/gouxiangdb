// beta.2 S2-API 补盲：CSV 逐行导入 / 批量更新两条写路径在 GX_OFFLINE_REPLICA=on 时，
// 必须在既有 withWriteTx 内与在线 recordSyncOpTx 并排落 local_outbox（默认 off 零行、业务零变化）。
//
// 真 app HTTP + 真迁移临时库（_realApp 默认挂 records+fields），身份固定 owner。
// 环境开关在事务回调内【调用时】读取，故用 withReplicaOn 包住整个 await request 即可。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

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

let h: Harness;
let baseId = "";
let tableId = "";
let primaryFieldId = "";

beforeAll(async () => {
  h = await setupHarness("gx-b2-outbox-csv-");
  baseId = await h.makeBase();
  const t = await h.makeTable(baseId, "t");
  tableId = t.id;
  primaryFieldId = t.primaryFieldId;
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.teardown();
});

async function outboxRows(op?: string) {
  return h.prisma.localOutbox.findMany({
    where: { baseId, ...(op ? { op } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

describe("CSV 逐行导入 local_outbox 切面", () => {
  it("on：导入 3 行 -> 3 条 pending create（nodeId/entityId/tableId/baseId 正确）", () =>
    withReplicaOn(async () => {
      const csv = ["名称", "甲", "乙", "丙"].join("\n");
      const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
        csv, hasHeader: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.result.createdRecords).toBe(3);

      const recs = await h.prisma.record.findMany({
        where: { tableId, deletedAt: null },
        select: { id: true },
      });
      const recIds = new Set(recs.map((r) => r.id));

      const rows = await outboxRows("create");
      // 仅统计本用例新行：entityId 必须都是本表新建记录。
      const mine = rows.filter((r) => r.entityType === "record" && recIds.has(r.entityId));
      expect(mine).toHaveLength(3);
      for (const r of mine) {
        expect(r.status).toBe("pending");
        expect(r.nodeId).toBe("n1");
        expect(r.baseId).toBe(baseId);
        const p = JSON.parse(r.payload) as { tableId: string; op: string; changes: unknown[] };
        expect(p.op).toBe("create");
        expect(p.tableId).toBe(tableId);
        expect(Array.isArray(p.changes)).toBe(true);
      }
      const entityIds = new Set(mine.map((r) => r.entityId));
      expect(entityIds.size).toBe(3);
    }));

  it("off（默认）：导入 2 行业务照常建成，但 local_outbox 零新增", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const before = await h.prisma.localOutbox.count();
      const csv = ["名称", "丁", "戊"].join("\n");
      const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
        csv, hasHeader: true,
      });
      expect(res.status).toBe(201);
      expect((await res.json()).result.createdRecords).toBe(2);
      expect(await h.prisma.localOutbox.count()).toBe(before);
    } finally {
      restoreEnv(prev);
    }
  });
});

describe("批量更新 local_outbox 切面", () => {
  it("on：bulk-update 2 行 -> 2 条 pending update（与在线切面同一份 changes）", () =>
    withReplicaOn(async () => {
      // 先用 CSV 建两行（on 态会各落一条 create），取出它们的 id。
      const mk = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
        csv: ["名称", "u-a", "u-b"].join("\n"), hasHeader: true,
      });
      expect(mk.status).toBe(201);
      const named = await h.prisma.record.findMany({
        where: { tableId, deletedAt: null },
      });
      const picked = named
        .filter((r) => ["u-a", "u-b"].includes((JSON.parse(r.fields) as Record<string, unknown>)[primaryFieldId] as string))
        .map((r) => r.id);
      expect(picked).toHaveLength(2);

      const res = await h.request("POST", "/records/bulk-update", {
        ids: picked,
        fields: { [primaryFieldId]: "改后" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).count).toBe(2);

      const updates = await h.prisma.localOutbox.findMany({
        where: { entityType: "record", op: "update", entityId: { in: picked } },
      });
      expect(updates).toHaveLength(2);
      for (const r of updates) {
        expect(r.status).toBe("pending");
        expect(r.baseId).toBe(baseId);
        const p = JSON.parse(r.payload) as { changes: { fieldId: string; after: unknown }[] };
        const ch = p.changes.find((c) => c.fieldId === primaryFieldId);
        expect(ch?.after).toBe("改后");
      }
    }));

  it("off（默认）：bulk-update 业务生效但 local_outbox 零新增", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const before = await h.prisma.localOutbox.count();
      // off 态 CSV 建 1 行。
      const mk = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
        csv: ["名称", "off-u"].join("\n"), hasHeader: true,
      });
      expect(mk.status).toBe(201);
      const r = await h.prisma.record.findFirstOrThrow({
        where: { tableId },
        orderBy: { createdAt: "desc" },
      });
      const res = await h.request("POST", "/records/bulk-update", {
        ids: [r.id],
        fields: { [primaryFieldId]: "off-改" },
      });
      expect(res.status).toBe(200);
      const stored = await h.prisma.record.findUniqueOrThrow({ where: { id: r.id } });
      expect((JSON.parse(stored.fields) as Record<string, unknown>)[primaryFieldId]).toBe("off-改");
      expect(await h.prisma.localOutbox.count()).toBe(before);
    } finally {
      restoreEnv(prev);
    }
  });
});

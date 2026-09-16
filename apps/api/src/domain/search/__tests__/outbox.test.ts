// M5/S1 outbox 原语与迁移真库测试（不 mock，临时库真迁移）。
//
// 覆盖：
//   - 迁移 #21：change_events/app_settings 表可写（经 migrate deploy 已建）。
//   - 迁移 #22：活 records/kb_docs 幂等播种、软删不播、doc/canvas entityType 映射、
//     重跑不重复（直接执行迁移 SQL 文件，非另写一套规则）。
//   - enqueueChangeEventTx：首次插入；pending/failed 连续编辑合并为一行且版本/op 最新；
//     processing/done 不吸收（done 后再编辑出新行）；delete 被恢复 upsert 翻转。
//   - 共生死：change_events 写失败触发器致主写事务整体回滚，实体表与事件表均无半截。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeNavHarness, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { enqueueChangeEventTx } from "../outbox.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_SQL = path.resolve(
  here,
  "../../../../prisma/migrations/20260916140100_m5_search_outbox_seed/migration.sql",
);

let h: CharHarness;
const B = "m5out_base";
const T = "m5out_table";
const FP = "m5out_f";
const KB = "m5out_kb";

const at = (ms: number) => new Date(Date.parse("2026-05-01T00:00:00.000Z") + ms);

async function eventsFor(entityType: string, entityId: string) {
  return h.prisma.changeEvent.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
}

/** 经 prisma db execute 执行迁移 #22 真实 SQL（支持多语句），返回播种后事件数。 */
function runSeedSql(): void {
  execSync(
    `pnpm exec prisma db execute --url "${process.env.DATABASE_URL}" --file "${SEED_SQL}"`,
    { cwd: process.cwd(), stdio: "pipe", env: process.env },
  );
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m5-s1-outbox-");
  await h.prisma.$transaction([
    h.prisma.base.create({ data: { id: B, name: "outbox 库", createdBy: "owner" } }),
    h.prisma.table.create({ data: { id: T, baseId: B, name: "t", primaryFieldId: FP, createdBy: "owner" } }),
    h.prisma.field.create({ data: { id: FP, tableId: T, name: "名", type: "singleLineText", order: 0 } }),
    h.prisma.knowledgeBase.create({ data: { id: KB, name: "outbox kb", createdBy: "owner" } }),
  ]);
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("迁移 #21 DDL", () => {
  it("app_settings KV 表可按主键写入/更新/读取（S1 生产码不读写，仅验表结构）", async () => {
    await h.prisma.appSetting.create({ data: { k: "m5out_probe", v: "1" } });
    await h.prisma.appSetting.update({ where: { k: "m5out_probe" }, data: { v: "2" } });
    const row = await h.prisma.appSetting.findUnique({ where: { k: "m5out_probe" } });
    expect(row?.v).toBe("2");
    expect(row?.updatedAt).toBeTruthy();
  });
});

describe("迁移 #22 活实体幂等播种", () => {
  it("活 record/doc/canvas 各播一条 pending upsert；软删行不播；重跑不重复", async () => {
    await h.prisma.record.createMany({
      data: [
        { id: "m5out_r_live", tableId: T, createdBy: "o", updatedBy: "o", createdAt: at(0),
          fields: JSON.stringify({ [FP]: "活记录" }) },
        { id: "m5out_r_dead", tableId: T, createdBy: "o", updatedBy: "o", createdAt: at(1),
          deletedAt: at(1), fields: JSON.stringify({ [FP]: "删记录" }) },
      ],
    });
    await h.prisma.kbDoc.createMany({
      data: [
        { id: "m5out_doc_live", kbId: KB, kind: "doc", title: "活文档", content: "", searchText: "",
          contentVersion: 3, createdBy: "o", updatedBy: "o" },
        { id: "m5out_cv_live", kbId: KB, kind: "canvas", title: "活画布", content: "[]", searchText: "",
          contentVersion: 1, createdBy: "o", updatedBy: "o" },
        { id: "m5out_doc_dead", kbId: KB, kind: "doc", title: "删文档", content: "", searchText: "",
          contentVersion: 0, createdBy: "o", updatedBy: "o", deletedAt: at(2) },
      ],
    });

    runSeedSql();
    const recLive = await eventsFor("record", "m5out_r_live");
    const recDead = await eventsFor("record", "m5out_r_dead");
    const docLive = await eventsFor("doc", "m5out_doc_live");
    const cvLive = await eventsFor("canvas", "m5out_cv_live");
    const docDead = await eventsFor("doc", "m5out_doc_dead");
    expect(recLive).toHaveLength(1);
    expect(recLive[0]!.status).toBe("pending");
    expect(recLive[0]!.op).toBe("upsert");
    expect(recLive[0]!.version).toBe(0n); // record 播种基线 0
    expect(docLive[0]!.version).toBe(3n); // doc 用真实 contentVersion
    expect(cvLive).toHaveLength(1); // canvas entityType 映射
    expect(recDead).toHaveLength(0);
    expect(docDead).toHaveLength(0);

    // 幂等：再跑一次真实迁移 SQL，活实体事件数不变。
    const before = await h.prisma.changeEvent.count();
    runSeedSql();
    const after = await h.prisma.changeEvent.count();
    expect(after).toBe(before);
  }, 120000);
});

describe("enqueueChangeEventTx 合并去重", () => {
  it("首次插入 pending 行（字段齐全），同实体连续编辑在 pending 态合并为一行", async () => {
    const r1 = await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e1", version: 100n, op: "upsert" }));
    expect(r1.outcome).toBe("inserted");
    const r2 = await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e1", version: 101n, op: "upsert" }));
    expect(r2.outcome).toBe("merged");
    expect(r2.eventId).toBe(r1.eventId);
    const rows = await eventsFor("record", "m5out_e1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(101n);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.op).toBe("upsert");
  });

  it("failed 行被新编辑吸收（清 lastError、复位 pending、版本更新）", async () => {
    await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e2", version: 1n, op: "upsert" }));
    await h.prisma.changeEvent.updateMany({
      where: { entityType: "record", entityId: "m5out_e2" },
      data: { status: "failed", attempts: 3, lastError: "boom" },
    });
    const r = await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e2", version: 2n, op: "upsert" }));
    expect(r.outcome).toBe("merged");
    const row = (await eventsFor("record", "m5out_e2"))[0]!;
    expect(row.status).toBe("pending");
    expect(row.version).toBe(2n);
    expect(row.lastError).toBeNull();
    expect(row.attempts).toBe(3); // attempts 是 worker 重试计数，enqueue 不清零（仅清错误态）
  });

  it("processing/done 不吸收：done 后再编辑产生新行，旧 done 保留", async () => {
    await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "doc", entityId: "m5out_d1", version: 1n, op: "upsert" }));
    const first = (await eventsFor("doc", "m5out_d1"))[0]!;
    await h.prisma.changeEvent.update({
      where: { id: first.id },
      data: { status: "done", processedAt: at(9) },
    });
    const r = await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "doc", entityId: "m5out_d1", version: 2n, op: "upsert" }));
    expect(r.outcome).toBe("inserted");
    const rows = await eventsFor("doc", "m5out_d1");
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.status).sort()).toEqual(["done", "pending"]);
  });

  it("软删发 delete、恢复发 upsert：pending delete 行被恢复编辑翻转为 upsert", async () => {
    await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e3", version: 9n, op: "upsert" }));
    const del = await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e3", version: 10n, op: "delete" }));
    expect(del.outcome).toBe("merged");
    expect((await eventsFor("record", "m5out_e3"))[0]!.op).toBe("delete");
    await h.prisma.$transaction((tx) =>
      enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_e3", version: 11n, op: "upsert" }));
    const row = (await eventsFor("record", "m5out_e3"))[0]!;
    expect(row.op).toBe("upsert");
    expect(row.version).toBe(11n);
  });
});

describe("共生死：enqueue 失败随主事务回滚", () => {
  it("change_events 写 ABORT 时，同事务实体写与事件双双不存在", async () => {
    const trg = "trgfail_m5out_ce_insert";
    await h.prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trg} BEFORE INSERT ON change_events
       BEGIN SELECT RAISE(ABORT, 'injected change_events failure'); END;`,
    );
    // 触发器 RAISE(ABORT) 在 better-sqlite3/Prisma 归类为 P2003（SQLITE_CONSTRAINT）；
    // 关键不是错误码，而是事务整体回滚——下方双向断言两表均无半截残留。
    await expect(
      h.prisma.$transaction(async (tx) => {
        await tx.record.create({
          data: { id: "m5out_r_tx", tableId: T, createdBy: "o", updatedBy: "o",
            fields: JSON.stringify({ [FP]: "事务记录" }) },
        });
        await enqueueChangeEventTx(tx, { entityType: "record", entityId: "m5out_r_tx", version: 1n, op: "upsert" });
      }),
    ).rejects.toMatchObject({ name: "PrismaClientKnownRequestError" });
    await h.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg}`);

    expect(await h.prisma.record.findUnique({ where: { id: "m5out_r_tx" } })).toBeNull();
    expect(await eventsFor("record", "m5out_r_tx")).toHaveLength(0);
  });
});

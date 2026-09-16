// M5/S5 派生写入测试：record upsert/截断/三处 rowid 对齐、再编辑去重、delete/恢复、
// off 不触网、cloud mock vec BLOB/欠账、doc markdown 去标记。真临时主库 + 真 search.db。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeIndexerHarness, seedTable, seedRecord, enqueue, tripwireProvider, mockCloudProvider,
  type IndexerHarness,
} from "./indexerHarness.js";
import { SearchIndexer } from "../indexer.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert, deleteDerived } from "../indexerDerive.js";
import { META_KEYS, getMeta } from "../schema.js";
import type { SearchStore } from "../searchStore.js";

let h: IndexerHarness;
/** 远未来固定时钟：保证真实 now() 播种的 nextRunAt(~2026) 满足 nextRunAt<=now 可被认领。 */
const NOW = 2_000_000_000_000;

beforeAll(async () => {
  h = await makeIndexerHarness("gx-m5-s5-derive-");
}, 120000);

afterAll(async () => { await h.cleanup(); });

function chunkCounts(store: SearchStore, entityId: string) {
  const db = store.db;
  // body 只在 fts_chunks；chunks 本体无 body 列（§4.2）。
  const chunks = db.prepare(
    `SELECT c.rowid AS rowid, c.chunkId AS chunkId, c.chunkKind AS chunkKind,
            c.fieldId AS fieldId, c.nodeId AS nodeId, f.body AS body
     FROM chunks c JOIN fts_chunks f ON f.rowid=c.rowid WHERE c.entityId=?`,
  ).all(entityId) as
    Array<{ rowid: number; chunkId: string; chunkKind: string; fieldId: string | null; nodeId: string; body: string }>;
  const fts = db.prepare("SELECT f.rowid FROM fts_chunks f JOIN chunks c ON c.rowid=f.rowid WHERE c.entityId=?").all(entityId) as
    Array<{ rowid: number }>;
  const grants = db.prepare("SELECT chunkRowid, tableNodeId, fieldId FROM field_grant").all() as
    Array<{ chunkRowid: number; tableNodeId: string; fieldId: string }>;
  return { chunks, fts, grants };
}

function vecRows(store: SearchStore) {
  if (!store.vecAvailable) return [];
  // vec_chunks 仅在首次成功 embed 后才建（§4.2）；未建时不查询。
  const exists = store.db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'",
  ).get() as { x: number } | undefined;
  if (!exists) return [];
  // entityType 是 INTEGER 码（1=record）；返回全部，断言处比较码值。
  return store.db.prepare("SELECT rowid, length(embedding) AS blen, entityType FROM vec_chunks").all() as
    Array<{ rowid: number; blen: number; entityType: bigint | number }>;
}

async function runRecord(store: SearchStore, recordId: string, mode: "off" | "cloud" = "off", provider: unknown = null, cap = 50) {
  const ev = await h.prisma.changeEvent.findFirst({ where: { entityId: recordId } });
  const entity = await extractEntity(h.prisma, ev!, cap);
  const summary = await applyUpsert(store, entity, {
    workspaceId: "ws_default", mode, provider: provider as never,
  });
  return { entity, summary };
}

describe("record upsert：identity + field chunk、field_grant、三处 rowid 对齐", () => {
  it("1 identity + N field；field chunk 每 row 登 field_grant；rowid 三处一致", async () => {
    const { tableId } = await seedTable(h, "up", [
      { id: "up_f0", name: "标题", type: "singleLineText", order: 0 },
      { id: "up_f1", name: "正文", type: "longText", order: 1 },
      { id: "up_f2", name: "附件", type: "attachment", order: 2 }, // 非可搜索类型，不建 field
      { id: "up_f3", name: "空值", type: "singleLineText", order: 3 }, // 无值不建
    ]);
    await seedRecord(h, tableId, "up_r1", {
      up_f0: "记录标题", up_f1: "一段正文内容", up_f2: "x", up_f3: "",
    });
    await enqueue(h, { entityType: "record", entityId: "up_r1", op: "upsert" });
    const store = h.openStore("rec", false);

    const { summary } = await runRecord(store, "up_r1");
    const { chunks, fts, grants } = chunkCounts(store, "up_r1");
    // identity(f0? no—identity 无业务值) + f0 + f1 = 3（attachment/空值排除）
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.chunkKind).toBe("identity");
    expect(chunks[0]!.fieldId).toBeNull();
    expect(chunks[0]!.body).not.toContain("记录标题"); // identity 不放业务值（§4.7）
    const fieldChunks = chunks.filter((c) => c.chunkKind === "field");
    expect(fieldChunks.map((c) => c.fieldId).sort()).toEqual(["up_f0", "up_f1"]);
    expect(summary.chunksWritten).toBe(3);

    // fts rowid 与 chunks 三处对齐
    expect(fts.map((r) => r.rowid).sort()).toEqual(chunks.map((c) => c.rowid).sort());
    // field_grant：每个 field chunk 一行，tableNodeId=nav_table_<tableId>，identity 不登
    expect(grants).toHaveLength(2);
    const grantRowids = new Set(grants.map((g) => g.chunkRowid));
    for (const fc of fieldChunks) expect(grantRowids.has(fc.rowid)).toBe(true);
    expect(grants.every((g) => g.tableNodeId === `nav_table_${tableId}`)).toBe(true);
    store.close();
  });

  it("field 文本对齐旧 search：LinkRef 数组取对象 title", async () => {
    const { tableId } = await seedTable(h, "link", [
      { id: "lk_f1", name: "关联", type: "singleLineText", order: 0 },
    ]);
    await seedRecord(h, tableId, "lk_r1", {
      lk_f1: [{ id: "x", title: "甲方公司" }, { id: "y", title: "乙方公司" }],
    });
    await enqueue(h, { entityType: "record", entityId: "lk_r1", op: "upsert" });
    const store = h.openStore("link", false);
    await runRecord(store, "lk_r1");
    const body = (store.db.prepare(
      "SELECT f.body FROM fts_chunks f JOIN chunks c ON c.rowid=f.rowid WHERE c.entityId=? AND c.chunkKind='field'",
    ).get("lk_r1") as { body: string }).body;
    expect(body).toBe("甲方公司, 乙方公司");
    store.close();
  });

  it("超 cap=50 截断：只建 50 field，capped=true 且 capped_records 累加", async () => {
    const fields = Array.from({ length: 55 }, (_, i) => ({
      id: `cap_f${i}`, name: `字段${i}`, type: "singleLineText", order: i,
    }));
    const { tableId } = await seedTable(h, "cap", fields);
    const values: Record<string, string> = {};
    for (const f of fields) values[f.id] = `值${f.id}`;
    await seedRecord(h, tableId, "cap_r1", values);
    await enqueue(h, { entityType: "record", entityId: "cap_r1", op: "upsert" });
    const store = h.openStore("cap", false);

    const { entity, summary } = await runRecord(store, "cap_r1", "off", null, 50);
    expect(entity.fieldCapped).toBe(true);
    expect(summary.fieldCapped).toBe(true);
    const { chunks, grants } = chunkCounts(store, "cap_r1");
    expect(chunks).toHaveLength(51); // identity + 50
    expect(chunks.filter((c) => c.chunkKind === "field")).toHaveLength(50);
    expect(grants).toHaveLength(50);
    expect(getMeta(store.db, META_KEYS.cappedRecords)).toBe("1");
    store.close();
  });
});

describe("再编辑：先删后建不产生重复", () => {
  it("同实体二次 upsert 后 chunk 数不翻倍、chunkId 唯一、rowid 取新号", async () => {
    const { tableId } = await seedTable(h, "re", [
      { id: "re_f1", name: "正文", type: "longText", order: 0 },
    ]);
    await seedRecord(h, tableId, "re_r1", { re_f1: "第一版" });
    await enqueue(h, { entityType: "record", entityId: "re_r1", op: "upsert" });
    const store = h.openStore("re", false);
    await runRecord(store, "re_r1");
    const before = chunkCounts(store, "re_r1").chunks.map((c) => c.rowid);

    // 改值后再次 upsert（同一事件形态，新 runOnce 会先删后建）
    await h.prisma.record.update({ where: { id: "re_r1" }, data: { fields: JSON.stringify({ re_f1: "第二版内容" }) } });
    await runRecord(store, "re_r1");
    const after = chunkCounts(store, "re_r1");
    expect(after.chunks).toHaveLength(2);
    expect(new Set(after.chunks.map((c) => c.chunkId)).size).toBe(2);
    // 旧 rowid 被回收重建：新号大于旧号（next_rowid 单调）
    expect(Math.min(...after.chunks.map((c) => c.rowid))).toBeGreaterThan(Math.max(...before));
    const totalChunks = (store.db.prepare("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
    expect(totalChunks).toBe(2); // 全库无残留旧版本
    store.close();
  });
});

describe("delete / purge / 恢复：清四表与重建", () => {
  it("delete op 清 chunks/fts/field_grant；恢复 upsert 重建", async () => {
    // 独立主库，避免本文件其它直接 applyUpsert（不经事件）造的 pending 被 runOnce 连带处理。
    const dh = await makeIndexerHarness("gx-m5-s5-del-");
    const { tableId } = await seedTable(dh, "del", [
      { id: "dl_f1", name: "正文", type: "longText", order: 0 },
    ]);
    await seedRecord(dh, tableId, "dl_r1", { dl_f1: "可搜索内容" });
    await enqueue(dh, { entityType: "record", entityId: "dl_r1", op: "upsert" });
    const store = dh.openStore("del", false);
    const idx = new SearchIndexer({
      prisma: dh.prisma, store, mode: "off", provider: null, workerId: "w", nowMs: () => NOW, startDelayMs: 0,
    });
    expect(await idx.runOnce()).toBe(1);
    expect(chunkCounts(store, "dl_r1").chunks.length).toBeGreaterThan(0);

    // 软删 + delete 事件
    await dh.prisma.record.update({ where: { id: "dl_r1" }, data: { deletedAt: new Date() } });
    await enqueue(dh, { entityType: "record", entityId: "dl_r1", op: "delete", version: 2n });
    expect(await idx.runOnce()).toBe(1);
    expect(chunkCounts(store, "dl_r1").chunks).toHaveLength(0);
    expect((store.db.prepare("SELECT COUNT(*) n FROM field_grant").get() as { n: number }).n).toBe(0);

    // 恢复 + upsert -> 重建
    await dh.prisma.record.update({ where: { id: "dl_r1" }, data: { deletedAt: null } });
    await enqueue(dh, { entityType: "record", entityId: "dl_r1", op: "upsert", version: 3n });
    expect(await idx.runOnce()).toBe(1);
    expect(chunkCounts(store, "dl_r1").chunks.length).toBeGreaterThan(0);
    store.close();
    await dh.cleanup();
  });

  it("purge（实体物理不存在）的 upsert/delete 都只清理不重建", () => {
    const store = h.openStore("purge", false);
    // 直接调删除原语对不存在实体：无行不报错（先删后建的清理分支）。
    expect(deleteDerived(store, "record", "ghost")).toBe(0);
    expect(chunkCounts(store, "ghost").chunks).toHaveLength(0);
    store.close();
  });
});

describe("off 模式：不调 provider、无 vec、fts 正常", () => {
  it("注入被调用即失败的 provider，off 下 embed 绝不触达", async () => {
    const { tableId } = await seedTable(h, "off", [
      { id: "off_f1", name: "正文", type: "longText", order: 0 },
    ]);
    await seedRecord(h, tableId, "off_r1", { off_f1: "纯 FTS 内容" });
    await enqueue(h, { entityType: "record", entityId: "off_r1", op: "upsert" });
    const store = h.openStore("off", false);
    const { summary } = await runRecord(store, "off_r1", "off", tripwireProvider());
    expect(summary.vecWritten).toBe(0);
    expect(chunkCounts(store, "off_r1").fts.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("cloud mock：vec BLOB/entityType；embed 失败 fts 仍在 + 欠账", () => {
  it("vec0 可用：embed 按文本切片，vec_chunks 落 Float32 BLOB（dim*4 字节）+ entityType=1", async () => {
    const { tableId } = await seedTable(h, "vec", [
      { id: "vc_f1", name: "正文", type: "longText", order: 0 },
    ]);
    await seedRecord(h, tableId, "vc_r1", { vc_f1: "向量化内容" });
    await enqueue(h, { entityType: "record", entityId: "vc_r1", op: "upsert" });
    const store = h.openStore("vec", true);
    expect(store.vecAvailable).toBe(true); // 本机 sqlite-vec v0.1.9（S2 已证）
    const provider = mockCloudProvider({ dim: 3, batchSize: 64 });
    const { summary } = await runRecord(store, "vc_r1", "cloud", provider);
    expect(summary.vecWritten).toBe(2);
    expect(provider.calls).toHaveLength(1); // 单批
    const rows = vecRows(store);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Number(r.entityType) === 1)).toBe(true);
    expect(rows.every((r) => r.blen === 12)).toBe(true); // 3 float32 * 4 字节
    store.close();
  });

  it("cloud embed 连续失败：事件 done、fts 保留、向量欠账；恢复后补齐", async () => {
    const { tableId } = await seedTable(h, "vdebt", [
      { id: "vd_f1", name: "正文", type: "longText", order: 0 },
    ]);
    await seedRecord(h, tableId, "vd_r1", { vd_f1: "欠账内容" });
    await enqueue(h, { entityType: "record", entityId: "vd_r1", op: "upsert" });
    const store = h.openStore("vdebt", true);
    const failing = mockCloudProvider({ dim: 3, failTimes: Number.MAX_SAFE_INTEGER });
    const idx = new SearchIndexer({
      prisma: h.prisma, store, mode: "cloud", provider: failing as never, workerId: "w", nowMs: () => NOW, startDelayMs: 0,
    });
    const n = await idx.runOnce();
    expect(n).toBeGreaterThanOrEqual(1);
    const ev = await h.prisma.changeEvent.findFirst({ where: { entityId: "vd_r1" } });
    expect(ev!.status).toBe("done"); // §4.9：FTS 优先，向量失败不拖垮事件
    expect(chunkCounts(store, "vd_r1").fts.length).toBeGreaterThan(0);
    expect(vecRows(store)).toHaveLength(0); // 欠账

    // 恢复健康后重跑同实体 -> 补齐 vec
    const healthy = mockCloudProvider({ dim: 3 });
    await runRecord(store, "vd_r1", "cloud", healthy);
    expect(vecRows(store).length).toBeGreaterThan(0);
    store.close();
  });
});

describe("doc：markdown 去标记后切块", () => {
  it("markdown 标记被去除、标题路径进 title、纯正文进 body", async () => {
    await h.prisma.knowledgeBase.create({ data: { id: "doc_kb", name: "文档库", createdBy: "owner" } });
    await h.prisma.kbDoc.create({
      data: {
        id: "doc_d1", kbId: "doc_kb", kind: "doc", title: "说明文档",
        content: "# 第一章\n**加粗**与`代码`和[链接](http://x)\n\n正文内容甲乙丙。",
        searchText: "", contentVersion: 1, createdBy: "o", updatedBy: "o",
      },
    });
    await enqueue(h, { entityType: "doc", entityId: "doc_d1", op: "upsert", version: 1n });
    const ev = await h.prisma.changeEvent.findFirst({ where: { entityId: "doc_d1" } });
    const entity = await extractEntity(h.prisma, ev!, 50);
    expect(entity.present).toBe(true);
    const identity = entity.chunks[0]!;
    expect(identity.nodeId).toBe("nav_doc_doc_d1");
    expect(identity.title).toContain("第一章");
    expect(identity.body).not.toContain("**");
    expect(identity.body).not.toContain("`");
    expect(identity.body).toContain("链接"); // 链接保留文字
    expect(identity.body).not.toContain("http://x");
  });
});

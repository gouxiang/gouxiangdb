// M5/S12 AC-M5-1④ 真实 search.db 损坏自愈 —— off/fts-only 形态（真迁移/真 app/真 JWT）。
//
// 真实损坏：① 主文件写非 SQLite 魔数（SQLITE_NOTADB）；② 主文件截断到 4096（SQLITE_CORRUPT）。
// 经真机实测的边界事实：better-sqlite3 在打开非库/损坏主库时自身会做热恢复——失败打开会
// unlink 不配套的残留 -wal/-shm，正常关闭损坏连接会 checkpoint 删除 sidecar。因此 HTTP 现场
// 触发恢复时，实际被搬走的文件数为 1..3；「主库 + 存在的 sidecar 一起 rename、绝不删除」由
// domain 级 searchCorruption/searchRecovery 测试在受控现场下钉死三件行为。
//
// 本片断言（HTTP 真实链路）：当次检索不 500（200 + mode=like + search_store_recovering）、
// 主库 LIKE 命中、主库被隔离（.corrupt-<ts> 留存可读）、同路径重建空库并后台重播 FTS、
// 恢复后检索重回 fts/like、主应用 record POST/PATCH 与 kb PUT content 全程可写。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

let w: S12World;

beforeAll(async () => { w = await setupS12({ mode: "off", label: "corrupt-off" }); }, 180000);
afterAll(async () => { await w.cleanup(); });

async function awaitRepopulate(): Promise<void> {
  const { recovery } = await w.modules();
  await recovery.currentRepopulation();
  await new Promise((r) => setTimeout(r, 10));
}

function assertOneNewQuarantineGroup(baseline: string[]): string[] {
  const before = new Set(baseline);
  const fresh = w.quarantineFiles().filter((f) => !before.has(f));
  expect(fresh.length).toBeGreaterThanOrEqual(1);
  const main = fresh.filter((f) => /\.corrupt-\d+$/.test(f));
  expect(main).toHaveLength(1); // 恰新增一组主库隔离物
  // 同组 sidecar（若在）后缀 ts 与主库一致。
  const ts = main[0]!.split(".corrupt-")[1];
  for (const f of fresh) expect(f).toContain(`.corrupt-${ts}`);
  return fresh;
}

describe("AC-M5-1④ off：魔数损坏 -> 当次 LIKE 200 + 隔离 + 重建重播", () => {
  it("写非 SQLite 魔数：当次 like 200 命中主库标题/正文；坏库隔离留存；新空库重播后 FTS 恢复", async () => {
    const rec = await w.seedRecord({ primary: "损坏自愈唯一词CORRUPTOFF1" });
    const doc = await w.seedDoc("损坏文档独有词CORRUPTDOC1");
    expect(w.counts().chunks).toBeGreaterThan(0);
    expect(w.quarantineFiles()).toEqual([]);

    w.corruptSearchDbMagic();
    const baseMoved = w.quarantineFiles();
    const r1 = await searchOnce(w, "CORRUPTOFF1");
    expect(r1.status).toBe(200);
    expect(r1.body.mode).toBe("like");
    expect(r1.body.degraded).toContain("search_store_recovering");
    expect(r1.body.items.map((i: { entityId: string }) => i.entityId)).toContain(rec.recordId);
    const r2 = await searchOnce(w, "CORRUPTDOC1");
    expect(r2.status).toBe(200);
    expect(r2.body.items.map((i: { entityId: string }) => i.entityId)).toContain(doc.docId);

    // 主库被隔离且内容可读（证据未删），原路径已是重建库。
    const moved = assertOneNewQuarantineGroup(baseMoved);
    const quarMain = moved.find((f) => /\.corrupt-\d+$/.test(f))!;
    expect(fs.readFileSync(quarMain, "utf8").startsWith("This is definitely not")).toBe(true);
    expect(fs.existsSync(w.searchPath)).toBe(true);

    // 后台重播完成，FTS 补齐；再搜重回正常路径且隔离物不被清理。
    await awaitRepopulate();
    const c = w.counts();
    expect(c.chunks).toBeGreaterThan(0);
    expect(c.fts).toBeGreaterThan(0);
    expect(c.vec).toBeNull();
    const r3 = await searchOnce(w, "CORRUPTOFF1");
    expect(r3.status).toBe(200);
    expect(["fts", "like"]).toContain(r3.body.mode);
    expect(r3.body.items.map((i: { entityId: string }) => i.entityId)).toContain(rec.recordId);
    expect(w.quarantineFiles().length).toBe(moved.length); // 删除由运维留存策略做，系统不删
  });

  it("损坏与恢复全程主应用写不受影响：record POST/PATCH 与 kb PUT content 成功，新标题应急 LIKE 可见", async () => {
    const t = await w.seedRecord({ primary: "主写不受影响词MAINWRITE1" });
    w.corruptSearchDbMagic();
    // record POST：主库事务 + outbox，不碰 search.db；201。
    const post = await w.http(`/api/records?tableId=${t.tableId}`, {
      method: "POST", headers: await w.auth(),
      body: JSON.stringify({ fields: { [t.primaryField]: "损坏期间新记录主词MAINNEW1" } }),
    });
    expect(post.status).toBe(201);
    const newRec = await w.prisma.record.findFirst({
      where: { tableId: t.tableId }, orderBy: { createdAt: "desc" },
    });
    expect(newRec).toBeTruthy();

    // 当次应急 LIKE 直读主库，新记录标题立刻可见（不等重播）。
    const r = await searchOnce(w, "MAINNEW1");
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { entityId: string }) => i.entityId)).toContain(newRec!.id);

    // PATCH 既有记录成功。
    const patch = await w.http(`/api/records/${t.recordId}`, {
      method: "PATCH", headers: await w.auth(),
      body: JSON.stringify({ fields: { [t.primaryField]: "主写改后词MAINPATCH1" } }),
    });
    expect(patch.status).toBe(200);

    await awaitRepopulate();
    // kb PUT content 成功（正文主库写 + outbox + nav 同步）。
    const doc = await w.seedDoc("恢复前文档词KBWRITE1");
    const put = await w.http(`/api/kb/docs/${doc.docId}/content`, {
      method: "PUT", headers: await w.auth(),
      body: JSON.stringify({ content: "# 新正文\n\n更新后独有词KBPATCH1", title: "恢复后标题" }),
    });
    expect(put.status).toBe(200);
    const inDb = await w.prisma.kbDoc.findUnique({ where: { id: doc.docId } });
    expect(inDb?.searchText).toContain("KBPATCH1");
  });

  it("截断损坏（SQLITE_CORRUPT）同样自愈：当次 200 like + 隔离物 + 重播恢复", async () => {
    const t = await w.seedRecord({ primary: "截断损坏唯一词TRUNCATE1" });
    const baseTrunc = w.quarantineFiles();
    w.truncateSearchDb();
    const r = await searchOnce(w, "TRUNCATE1");
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("like");
    expect(r.body.degraded).toContain("search_store_recovering");
    expect(r.body.items.map((i: { entityId: string }) => i.entityId)).toContain(t.recordId);
    assertOneNewQuarantineGroup(baseTrunc);
    await awaitRepopulate();
    expect(w.counts().chunks).toBeGreaterThan(0);
  });

  it("连续两次损坏各自独立隔离+重开（进程恢复锁不卡死于陈旧恢复）", async () => {
    await w.seedRecord({ primary: "连续损坏词REPEAT1" });
    w.corruptSearchDbMagic();
    const a = await searchOnce(w, "REPEAT1");
    expect(a.status).toBe(200);
    await awaitRepopulate();
    const groupsAfter1 = w.quarantineFiles().filter((f) => /\.corrupt-\d+$/.test(f)).length;

    await w.seedRecord({ primary: "连续损坏词REPEAT2" });
    w.corruptSearchDbMagic();
    const b = await searchOnce(w, "REPEAT2");
    expect(b.status).toBe(200);
    expect(b.body.items.map((i: { entityId: string }) => i.entityId).length).toBeGreaterThan(0);
    await awaitRepopulate();
    const groupsAfter2 = w.quarantineFiles().filter((f) => /\.corrupt-\d+$/.test(f)).length;
    expect(groupsAfter2).toBe(groupsAfter1 + 1);
    expect(w.counts().chunks).toBeGreaterThan(0); // 第二次重建同样重播成功
  });
});

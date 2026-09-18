// M7 门③ R6 缺陷修复的守卫测试：内嵌索引 worker 的【门控】与【reindex 互斥】。
//
// 背景（真缺陷，非测试缺陷）：此前全仓生产代码零处 `new SearchIndexer`——indexer.ts 状态机
// 齐全但从未接线，change_events 只进不出。本文件锁住接线后的两条性质：
//   1. 出厂默认（GX_M5_SEARCH 未设/off）与排障面（GX_SEARCH_WORKER=off）都必须零副作用：
//      不启动 worker、不建 search.db（三件物理文件都不存在 = 没有任何连接被打开）。
//   2. 门放行后工人真能消化 outbox：runOnce() 把 pending 追平到 0、done>0、search.db 出 chunks。
//   3. reindex 期间工人被挂起；结束后恢复不抛，且工人持有的库与 getSearchStore() 同一实例
//      （全量重建 rename 换过文件后，工人必须指向新现役库，绝不能续写被 unlink 的旧句柄）。
//
// 真临时主库（makeIndexerHarness 迁移）+ 真物理 search.db；不 mock prisma/store，
// cloud provider 不曾构造（mode 走 off），故全程零外网。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  makeIndexerHarness, seedTable, seedRecord, enqueue, type IndexerHarness,
} from "./indexerHarness.js";
import {
  startSearchWorker, stopSearchWorker, isSearchWorkerRunning,
  suspendSearchWorker, resumeSearchWorker,
  currentSearchWorker, currentWorkerStore, searchWorkerAllowed,
  type SearchWorkerDeps,
} from "../workerRuntime.js";
import { getSearchStore, closeSearchStore } from "../searchStore.js";
import { META_KEYS, getMeta } from "../schema.js";
import { startReindex } from "../reindex.js";

const JWT = "m7-worker-runtime-secret-at-least-16";

let h: IndexerHarness;
let searchPath: string;

/** 门控用例靠 env 直接驱动（生产侧由 index.ts 传启动期冻结的 config.m5Search/searchWorker）。 */
function deps(extra: Record<string, string> = {}): SearchWorkerDeps {
  return {
    prisma: h.prisma,
    env: { ...process.env, ...extra },
    dataDir: h.tmpDir,
    appDir: process.cwd(),
    jwtSecret: JWT,
    searchPath,
  };
}

/** search.db 三件物理文件（含 WAL 侧车）：任一存在即证明有人打开过连接。 */
function sidecars(): string[] {
  return [searchPath, `${searchPath}-wal`, `${searchPath}-shm`];
}

function assertNoSearchDb(): void {
  for (const f of sidecars()) expect(fs.existsSync(f), `不应创建 ${f}`).toBe(false);
  // 默认解析路径（dataDir/search.db）同样不得被创建。
  expect(fs.existsSync(path.join(h.tmpDir, "search.db"))).toBe(false);
}

beforeAll(async () => {
  h = await makeIndexerHarness("gx-m7-worker-runtime-");
  searchPath = h.searchPathFor("wr");
  await seedTable(h, "wr", [
    { id: "wr_f0", name: "标题", type: "singleLineText", order: 0 },
  ]);
}, 120_000);

afterAll(async () => {
  stopSearchWorker();
  closeSearchStore();
  await h.cleanup();
});

describe("M7 R6：worker 门控（出厂默认零副作用）", () => {
  it("GX_M5_SEARCH 未设/off：不启动、不建 search.db、不开任何连接", async () => {
    expect(searchWorkerAllowed(deps())).toBe(false);
    const ok = await startSearchWorker(deps({ GX_M5_SEARCH: "off" }));
    expect(ok).toBe(false);
    expect(isSearchWorkerRunning()).toBe(false);
    expect(currentSearchWorker()).toBeNull();
    expect(currentWorkerStore()).toBeNull();
    assertNoSearchDb();
  }, 60_000);

  it("GX_M5_SEARCH=on 但 GX_SEARCH_WORKER=off（R6 回滚面）：同样不启动、零副作用", async () => {
    expect(searchWorkerAllowed(deps({ GX_M5_SEARCH: "on", GX_SEARCH_WORKER: "off" }))).toBe(false);
    const ok = await startSearchWorker(deps({ GX_M5_SEARCH: "on", GX_SEARCH_WORKER: "off" }));
    expect(ok).toBe(false);
    expect(currentSearchWorker()).toBeNull();
    assertNoSearchDb();
  }, 60_000);

  it("GX_M5_SEARCH=on：启动后 runOnce 把 pending 追平到 0、done>0、search.db 出 chunks", async () => {
    for (const id of ["wr_r1", "wr_r2", "wr_r3"]) {
      await seedRecord(h, "wr_t", id, { wr_f0: `内容-${id}` });
      await enqueue(h, { entityType: "record", entityId: id, op: "upsert" });
    }
    expect(await h.prisma.changeEvent.count({ where: { status: "pending" } })).toBe(3);

    expect(searchWorkerAllowed(deps({ GX_M5_SEARCH: "on" }))).toBe(true);
    const ok = await startSearchWorker(deps({ GX_M5_SEARCH: "on" }));
    expect(ok).toBe(true);
    expect(isSearchWorkerRunning()).toBe(true);
    expect(fs.existsSync(searchPath)).toBe(true);

    const worker = currentSearchWorker();
    expect(worker).not.toBeNull();
    const processed = await worker!.runOnce();
    expect(processed).toBe(3);

    // 真缺陷的对立面：以前 pending 纹丝不动（attempts=0/workerId=null），现在必须被消化。
    expect(await h.prisma.changeEvent.count({ where: { status: "pending" } })).toBe(0);
    expect(await h.prisma.changeEvent.count({ where: { status: "done" } })).toBeGreaterThan(0);
    const claimed = await h.prisma.changeEvent.findMany({ where: { status: "done" } });
    expect(claimed.every((e) => typeof e.workerId === "string" && e.workerId.startsWith("api-"))).toBe(true);

    const store = currentWorkerStore();
    expect(store).not.toBeNull();
    const row = store!.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
    expect(row.c).toBeGreaterThan(0);
  }, 60_000);
});

describe("M7 R6：reindex 与 worker 互斥", () => {
  it("全量重建期间工人被挂起；结束后 resume 不抛且工人指向重建后的现役库", async () => {
    // 前置：上一条已启动工人（未启动则本条先起，保证测的是真实互斥而非空转）。
    if (!isSearchWorkerRunning()) {
      expect(await startSearchWorker(deps({ GX_M5_SEARCH: "on" }))).toBe(true);
    }
    const before = currentWorkerStore();
    expect(before).not.toBeNull();

    let suspendedSeen: boolean | null = null;
    const r = await startReindex({
      ...deps({ GX_M5_SEARCH: "on" }),
      async onProgress(done) {
        // 灌库中途：工人必须停着（否则会写到即将被 rename 顶掉的旧文件）。
        if (done === 1 && suspendedSeen === null) suspendedSeen = !isSearchWorkerRunning();
      },
    });
    expect(suspendedSeen).toBe(true);
    expect(r.mode).toBe("full");
    expect(r.swapped).toBe(true);
    expect(r.chunksWritten).toBeGreaterThan(0);

    // finally 已 resume：不抛，且工人重新取过单例 -> 与现役库同一实例（不是被 unlink 的旧库）。
    expect(isSearchWorkerRunning()).toBe(true);
    const after = currentWorkerStore();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before); // 换过文件，必须是新连接
    expect(after).toBe(getSearchStore({ filePath: searchPath, appDir: process.cwd() }));

    // 幂等：重复 suspend/resume 不抛；未挂起时 resume 是 no-op（返回 false）。
    expect(suspendSearchWorker()).toBe(true);
    expect(isSearchWorkerRunning()).toBe(false);
    expect(resumeSearchWorker()).toBe(true);
    expect(resumeSearchWorker()).toBe(false);
  }, 60_000);

  it("工人从未启动时 suspend/resume 是纯 no-op（不抛、不建库）", () => {
    stopSearchWorker();
    closeSearchStore();
    for (const f of sidecars()) fs.rmSync(f, { force: true });
    expect(suspendSearchWorker()).toBe(false);
    expect(resumeSearchWorker()).toBe(false);
    expect(isSearchWorkerRunning()).toBe(false);
    assertNoSearchDb();
  }, 60_000);
});

describe("M7 R6：停机交还单写者锁（重启可立即接管）", () => {
  it("启动后锁属本实例；stopSearchWorker 后锁无主（否则重启要等 15min stalled）", async () => {
    stopSearchWorker();
    closeSearchStore();
    for (const f of sidecars()) fs.rmSync(f, { force: true });

    expect(await startSearchWorker(deps({ GX_M5_SEARCH: "on" }))).toBe(true);
    const store = currentWorkerStore();
    expect(store).not.toBeNull();
    expect(getMeta(store!.db, META_KEYS.workerLock)).toMatch(/^api-\d+:/);

    stopSearchWorker();
    // 交还后必须是"无主"取值：空串或键不存在 —— 换 pid 的新实例据此可立即抢占。
    const lock = getMeta(store!.db, META_KEYS.workerLock);
    expect(lock === "" || lock === undefined).toBe(true);
    expect(isSearchWorkerRunning()).toBe(false);
  }, 60_000);
});

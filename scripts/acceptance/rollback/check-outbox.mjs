// scripts/acceptance/rollback/check-outbox.mjs
// 门③ R6（严格按代码真实机制执行，不按计划字面伪装）：
//
// ⚠⚠ 两处计划/实现偏差（读码+真机双重核实，必须如实上报）：
//   偏差1：计划 §4 R6 写的开关 GX_SEARCH_WORKER=on/off 在全 src 零接线——无此 env。
//   偏差2（更关键）：outbox 消化器 SearchIndexer（claim pending->processing->done）
//          【在整个 src 中只被定义、从未被任何生产/CLI/HTTP 代码 new/start】（indexer.ts:114 唯一定义，
//          src/index.ts 启动无 worker）。owner 的 POST /api/v1/admin/reindex（202，startReindex）走的是
//          reindex.ts runFull：全量重建派生 search.db chunks，但【不更新 change_events 状态】
//          （reindex.ts 对 change_events 零写）。真机实测：reindex 后 chunks=7/coverage 全 0，
//          但 change_events 4 行仍全为 pending（attempts=0/workerId=null）。
//
// 因此 R6 能机械验证的【真实】行为是：
//   (a) 写操作同事务 enqueue 的 change_events 默认 pending；在【无任何常驻消化器】的真实部署姿态下，
//       静置一段时间 pending 行数保持不变（不会被悄悄消化）——这正是"worker off"的真实表现；
//   (b) owner POST /api/v1/admin/reindex 是真实存在且可用的索引构建入口：202 后 chunks 从无到有、
//       coverage a-f 清零、rebuilding=false（检索能力被全量重建补齐）；
//   (c) 但 outbox pending 不会因此归零——真实登记为偏差，绝不伪造"追平归零"的自动绿。
//
// 是否需要补 SearchIndexer 的生产启动/CLI 及其 env 开关，由 team-lead 裁决（见 REPORT 第三节）。

import path from "node:path";
import { loadBetterSqlite3 } from "../lib/db.mjs";
import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

function openMain(dbPath) {
  const Database = loadBetterSqlite3();
  // r/w：服务正以 WAL 持有该库，只读连接可能因无法建 shm 报 SQLITE_READONLY；
  // 这是每旗独立 scratch 副本，只做 count，不写数据。
  return new Database(dbPath, { fileMustExist: true });
}

const counts = (db) => ({
  pending: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status IN ('pending','processing')").get().c,
  done: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status='done'").get().c,
  failed: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status IN ('failed','dead')").get().c,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "outbox:reindex");
  const base = ctx.baseUrl;
  const db = openMain(path.resolve(args.db));

  try {
    // (a) 真实部署无常驻消化器：种子写入的 pending 行静置后保持不变
    const c0 = counts(db);
    expectTrue(
      c0.pending >= ctx.recordIds.length,
      `R6 写产生 change_events pending（pending=${c0.pending} >= 记录数 ${ctx.recordIds.length}）`,
      hits,
    );
    await sleep(2500); // 给"假想常驻 worker"留出窗口：真实姿态下不应有任何变化
    const c1 = counts(db);
    expectTrue(
      c1.pending === c0.pending && c1.done === c0.done,
      `R6 无消化器姿态静置 2.5s：pending 保持 ${c0.pending}->${c1.pending}、done ${c0.done}->${c1.done}（不被悄悄消化=worker off 真实表现）`,
      hits,
    );

    // (b) 真实存在的索引构建入口：full reindex -> 202，随后 chunks>0、coverage 全 0、rebuilding=false
    const kick = await http(base, "POST", "/api/v1/admin/reindex", { token: ctx.tokens.owner, body: {} });
    expectStatus(kick, 202, "R6 POST /api/v1/admin/reindex 202（真实索引构建入口）", hits);

    let settled = null;
    for (let i = 0; i < 80; i++) {
      const s = await http(base, "GET", "/api/v1/admin/search/status", { token: ctx.tokens.owner });
      const idx = s.json?.index;
      if (s.status === 200 && idx && idx.rebuilding === false && (idx.chunks?.total ?? 0) > 0) {
        settled = idx;
        break;
      }
      await sleep(500);
    }
    expectTrue(settled !== null, "R6 reindex 后 status：index 非空、rebuilding=false、chunks>0", hits);
    const cov = settled.coverage ?? {};
    const coverageZero = ["a", "b", "c", "d", "e", "f"].every((k) => (cov[k] ?? 0) === 0);
    expectTrue(coverageZero, `R6 reindex 后 coverage a-f 全 0（实得 ${JSON.stringify(cov)}）`, hits);

    // (c) 真实登记：reindex 不消化 outbox。pending 应【仍为原值】，这是与计划假设的偏差证据。
    const c2 = counts(db);
    expectTrue(
      c2.pending === c1.pending,
      `R6 真实偏差坐实：full reindex 不更新 change_events（reindex 后 pending 仍=${c2.pending}，done=${c2.done}；SearchIndexer 无生产启动点）`,
      hits,
      `期望 pending 维持 ${c1.pending} 以暴露偏差，实得 ${c2.pending}`,
    );
    expectTrue(
      c2.done === 0,
      `R6 全程无 worker -> change_events done 行=0（实得 ${c2.done}），佐证常驻消化器缺失`,
      hits,
    );
  } finally {
    db.close();
  }
  return hits.n;
}

runCheck("check-outbox", main);

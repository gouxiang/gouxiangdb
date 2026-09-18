// scripts/acceptance/rollback/check-outbox.mjs
// 门③ R6（worker=off 回滚面：严格按代码真实机制执行，不按计划字面伪装）：
//
// 【2026-09-18 更新：偏差已修 + 本用例转为看守回滚面】
//   此前这里登记的两处计划/实现偏差（`GX_SEARCH_WORKER` 全 src 零接线、`SearchIndexer` 从未被
//   new/start → change_events 只进不出），已由 P1 修复 `249df44` 关闭：内嵌工人接进
//   `apps/api/src/index.ts`，门控为 `GX_M5_SEARCH=on 且 GX_SEARCH_WORKER!=off` 才启动。
//   修复的【正立面】（pending 被工人自行追平、workerId=api-<pid>@ms、status chunks>0）由新增的
//   R6b / `check-outbox-drain.mjs` 验证；本用例则转为验证【回滚面】：显式 `GX_SEARCH_WORKER=off`
//   后不得有任何后台消化器偷偷跑起来。
//
// 因此 R6（worker=off 面）能机械验证的【真实】行为是：
//   (a) 写操作同事务 enqueue 的 change_events 默认 pending；在【无任何常驻消化器】的真实部署姿态下，
//       静置一段时间 pending 行数保持不变（不会被悄悄消化）——这正是"worker off"的真实表现；
//   (b) owner POST /api/v1/admin/reindex 是真实存在且可用的索引构建入口：202 后 chunks 从无到有、
//       coverage a-f 清零、rebuilding=false（检索能力被全量重建补齐）；
//   (c) 但 outbox pending 不会因此归零——真实登记为偏差，绝不伪造"追平归零"的自动绿。
//
// 是否需要补 SearchIndexer 的生产启动及其 env 开关，曾由本用例上报 team-lead 裁决；
// 裁决结果＝修复（见上方 249df44），本用例保留为 worker=off 回滚面的看守。

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

    // (c) worker=off 面的看守：手动 reindex 只重建派生库，不碰 outbox，pending 应【仍为原值】。
    //     这是本面的真实语义（不是偏差）：增量消化已由 R6b 单独验收，此处严禁让手动入口伪装成追平。
    const c2 = counts(db);
    expectTrue(
      c2.pending === c1.pending,
      `R6 手动 reindex 不消化 outbox：reindex 后 pending 仍=${c2.pending}、done=${c2.done}（增量消化归 R6b 验收，本面不追平）`,
      hits,
      `期望 pending 维持 ${c1.pending} 以暴露偏差，实得 ${c2.pending}`,
    );
    expectTrue(
      c2.done === 0,
      `R6 worker=off 面：本进程无内嵌工人 -> change_events done 行=0（实得 ${c2.done}），佐证旗标关闭确实不启后台消化器`,
      hits,
    );
  } finally {
    db.close();
  }
  return hits.n;
}

runCheck("check-outbox", main);

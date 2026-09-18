// scripts/acceptance/rollback/check-outbox-drain.mjs
// 门③ R6b（2026-09-18 新增，随 P1 修复 `249df44` 一并落地）：
//
// 背景：此前 R6 坐实「SearchIndexer 只交付未接线」——src/scripts 下无任何 new/start 调用点，
//       故 change_events 只进不出，全量 reindex 也不消化 outbox。249df44 把工人接进
//       apps/api/src/index.ts（门控：GX_M5_SEARCH=on 且 GX_SEARCH_WORKER!=off 才起）。
//
// R6b 在真 dist 服务上验证这条修复的【正立面】：
//   (a) 起服后不调任何 reindex 端点（本题全程不发 POST /api/v1/admin/reindex），outbox 的
//       pending 会被内嵌工人自行追平到 0、done>0；
//   (b) 认领痕迹可溯源：done 行的 workerId 形如 `api-<pid>@<claimMs>`（SearchIndexer 写入，
//       与手动 reindex 路径零交集），证明是工人在消化而非别的东西；
//   (c) 派生库真的被工人建出来并能被 status 端点读到：GET /api/v1/admin/search/status 的
//       index.chunks.total > 0、rebuilding=false。

import path from "node:path";
import { loadBetterSqlite3 } from "../lib/db.mjs";
import { parseArgs, loadContext, http, HitCounter, expectTrue, runCheck } from "./probe.mjs";

function openMain(dbPath) {
  const Database = loadBetterSqlite3();
  return new Database(dbPath, { fileMustExist: true });
}

const counts = (db) => ({
  pending: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status IN ('pending','processing')").get().c,
  done: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status='done'").get().c,
  failed: db.prepare("SELECT COUNT(*) c FROM change_events WHERE status IN ('failed','dead')").get().c,
});

/** done 行里由 api 内嵌工人认领（workerId like 'api-%@%'）的条数。 */
const apiClaimed = (db) =>
  db.prepare("SELECT COUNT(*) c FROM change_events WHERE status='done' AND workerId LIKE 'api-%@%'").get().c;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "outbox:worker-drain");
  const base = ctx.baseUrl;
  const db = openMain(path.resolve(args.db));

  try {
    const c0 = counts(db);
    expectTrue(
      c0.pending > 0,
      `R6b 起服时存在待消化 outbox（pending=${c0.pending}）`,
      hits,
      `实得 pending=${c0.pending}，若为 0 则本用例失去意义`,
    );

    // (a) 工人自行追平：不发任何 reindex 请求，只轮询 change_events
    let settled = null;
    for (let i = 0; i < 120; i += 1) {
      const c = counts(db);
      if (c.pending === 0 && c.done > 0) { settled = c; break; }
      await sleep(500);
    }
    const cEnd = counts(db);
    expectTrue(
      settled !== null,
      `R6b 内嵌工人自行追平 outbox：pending ${c0.pending}->${cEnd.pending}、done ${c0.done}->${cEnd.done}（未调用任何 reindex 端点）`,
      hits,
      `60s 内未追平：pending=${cEnd.pending} done=${cEnd.done} failed=${cEnd.failed}`,
    );

    // (b) 认领痕迹溯源：done 行带着 `api-<pid>@<ms>` 工牌
    const claimed = apiClaimed(db);
    expectTrue(
      claimed > 0,
      `R6b done 行带内嵌工人工牌 workerId=api-<pid>@<ms>（${claimed}/${cEnd.done} 行），证明为本进程工人消化`,
      hits,
      `实得 api-%@% 行数=${claimed}`,
    );

    // (c) 派生库被工人建成且可读：status 端点 chunks>0
    let idx = null;
    for (let i = 0; i < 40; i += 1) {
      const s = await http(base, "GET", "/api/v1/admin/search/status", { token: ctx.tokens.owner });
      if (s.status === 200 && s.json?.index && (s.json.index.chunks?.total ?? 0) > 0) { idx = s.json.index; break; }
      await sleep(500);
    }
    expectTrue(
      idx !== null && idx.rebuilding === false,
      `R6b 工人建成派生索引且可读：index.chunks.total=${idx?.chunks?.total ?? 0}、rebuilding=${idx?.rebuilding ?? "n/a"}`,
      hits,
    );
  } finally {
    db.close();
  }
  return hits.n;
}

runCheck("check-outbox-drain", main);

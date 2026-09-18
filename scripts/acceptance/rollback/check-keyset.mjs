// scripts/acceptance/rollback/check-keyset.mjs
// 门③ R4：M1 读路径/keyset 翻回 off 后，列表响应键集合回到 S0 形状（无游标三键）。
//
// 读码契约（domain/queryPlan/flags.ts）：
//   keysetPagingActive = (GX_M1_SIDECAR_READ==="on") && sidecarReadUsable() && (GX_M1_KEYSET==="on")
//   sidecarReadUsable = READ!=="off" && GX_M1_SIDECAR!=="off"（写侧默认在维护）
// routes/records.ts:117-123：仅 keysetOn 时响应体 additive 挂 nextCursor/hasMore/degraded；
//   off 态键集合与 S0 快照一致。
//
// 子命令：on（基线：READ=on KEYSET=on，须出现游标三键） | off（回滚：三键消失，数据集合不变）。

import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

const CURSOR_KEYS = ["nextCursor", "hasMore", "degraded"];

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode; // on | off
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], `keyset:${mode}`);
  const base = ctx.baseUrl;
  const url = `/api/records?tableId=${encodeURIComponent(ctx.tableId)}&limit=50`;

  const r = await http(base, "GET", url, { token: ctx.tokens.owner });
  expectStatus(r, 200, `R4(${mode}) GET records 200`, hits);
  const body = r.json;
  expectTrue(body && typeof body === "object", `R4(${mode}) 响应是 JSON 对象`, hits);
  expectTrue(Array.isArray(body.records), `R4(${mode}) 含 records 数组`, hits);
  // 种子 3 行（只断言至少含我们写入的标记行；同表可能有 starter 表外的其它数据，但本表自建）
  expectTrue(body.records.length >= 3, `R4(${mode}) records 行数>=3（实得 ${body.records.length}）`, hits);

  const keySet = new Set(Object.keys(body));
  const ids = new Set(body.records.map((x) => x.id));

  if (mode === "on") {
    for (const k of CURSOR_KEYS) {
      expectTrue(keySet.has(k), `R4(on) additive 含游标键 ${k}`, hits);
    }
    expectTrue(typeof body.hasMore === "boolean", "R4(on) hasMore 为布尔", hits);
  } else if (mode === "off") {
    for (const k of CURSOR_KEYS) {
      expectTrue(!keySet.has(k), `R4(off) 响应不含游标键 ${k}（回到 S0 形状）`, hits);
    }
    // off 态 S0 固定键
    for (const k of ["records", "total", "filteredTotal", "fields", "allFields", "groups", "aggregations"]) {
      expectTrue(keySet.has(k), `R4(off) 保留 S0 键 ${k}`, hits);
    }
    // 数据集合不丢：种子写入的记录 id 都在
    let present = 0;
    for (const id of ctx.recordIds) if (ids.has(id)) present += 1;
    expectTrue(present === ctx.recordIds.length, `R4(off) 种子记录全在（${present}/${ctx.recordIds.length}）`, hits);
  } else {
    throw new Error(`未知 mode：${mode}`);
  }
  return hits.n;
}

runCheck("check-keyset", main);

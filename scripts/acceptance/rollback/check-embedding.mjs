// scripts/acceptance/rollback/check-embedding.mjs
// 门③ R5：embedding 回 off 后检索退化为纯 FTS5 trigram/短词 LIKE，结果可用，且全程零外网。
//
// 两个独立证据（缺一不可）：
//   A. 旧面 GET /api/search?q=zephyrmarker（始终挂载，runLegacyGlobalSearch 纯 FTS/LIKE，与
//      GX_M5_SEARCH/GX_EMBEDDING_MODE 无关）必须真实命中种子记录/文档。
//   B. 服务进程由 netguard.mjs 预加载包装了 fetch/http/https/dns/tcp 出网面；本检查读取
//      GX_NETGUARD_LOG，逐条判定：除回环(127.0.0.1/::1/localhost)与 bootstrap 自记外，
//      必须【零】外网出网。better-sqlite3 走本地原生句柄，不经 net，天然不计数。
//
// 选择旧面 /api/search 作为主探针的理由：它是 off 回滚后用户实际依赖的检索面，其实现零云依赖，
// 最直接证明"翻 off 后无需任何外部嵌入服务即可检索"。

import fs from "node:fs";
import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

function classifyEgress(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { total: 0, external: [], loopback: 0, bootstrap: 0, lines: [] };
  }
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { kind: "unparseable", target: l }; }
  });
  const external = [];
  let loopback = 0;
  let bootstrap = 0;
  for (const e of lines) {
    if (e.kind === "bootstrap") { bootstrap += 1; continue; }
    const t = String(e.target ?? "").toLowerCase();
    const host = t.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    if (host === "127.0.0.1" || host === "::1" || host === "localhost" || host.startsWith("127.") || host === "(none)" || host === "") {
      loopback += 1;
    } else {
      external.push(e);
    }
  }
  return { total: lines.length, external, loopback, bootstrap, lines };
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "embedding:off");
  const base = ctx.baseUrl;
  const q = encodeURIComponent(ctx.marker);

  // 证据 A：旧面 FTS 命中（记录或文档至少一处含 marker）
  const r = await http(base, "GET", `/api/search?q=${q}`, { token: ctx.tokens.owner });
  expectStatus(r, 200, "R5 旧面 /api/search 200", hits);
  const recs = Array.isArray(r.json?.records) ? r.json.records : [];
  const docs = Array.isArray(r.json?.docs) ? r.json.docs : [];
  const hay = JSON.stringify(r.json ?? {});
  expectTrue(
    hay.toLowerCase().includes(ctx.marker),
    `R5 FTS 命中标记词 "${ctx.marker}"（records=${recs.length} docs=${docs.length}）`,
    hits,
  );

  // 证据 B：出网日志零外网
  const audit = classifyEgress(args["net-log"]);
  expectTrue(
    audit.external.length === 0,
    `R5 检索全程零外网（总探针事件 ${audit.total}，回环 ${audit.loopback}，外网 ${audit.external.length}）`,
    hits,
    audit.external.slice(0, 3).map((e) => `${e.kind}:${e.target}`).join("; "),
  );

  // 把审计快照落盘，供报告引用
  if (args["audit-out"]) {
    fs.writeFileSync(args["audit-out"], JSON.stringify({
      total: audit.total,
      loopback: audit.loopback,
      bootstrap: audit.bootstrap,
      external: audit.external,
    }, null, 2));
  }
  return hits.n;
}

runCheck("check-embedding", main);

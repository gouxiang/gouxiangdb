#!/usr/bin/env node
// scripts/acceptance/check-search.mjs
// 门② G2 补强④：search.db 分阶段核验——G2 只做 FTS-only（GX_EMBEDDING_MODE=off），
// vec0 hybrid 为 P1（report 标注，不阻塞门）。
//
// 本脚本自管候选 dist 服务（独占端口，便于"删库-重启"自愈演练）。步骤：
//   1) 起服务（GX_M5_SEARCH=on，GX_SEARCH_DB_PATH 固定）。缺库语义：首启不自动建 search.db，
//      status.index=null（indexer worker 不在 API 进程自启，须显式 reindex 推进；如实留证）。
//   2) owner POST /api/v1/admin/reindex -> 202；轮询【HTTP】GET /api/v1/admin/search/status
//      直到 index 非空、rebuilding=false、coverage a/b/e/f=0、chunks.total>0（不再 spawn CLI）。
//   3) 零泄漏（embedding off，三请求态实走关键词、零外网）：
//      - 独特长 marker（>=3 码点）doc：owner auto/fts/vector 三请求均命中（vector 在 off 态
//        降级 fts 并在 degraded 标注），无权主体 g1（s01，仅 base1 viewer）三请求结果集均不含
//        该 doc、响应原文不含 marker（snippet/title 零泄漏）。
//      - 独特 2 码点短词 doc：auto 请求按码元分流走参数化 LIKE（非显式 mode，like 由 len<3
//        触发），owner 命中、g1 结果集不含该 doc。
//   4) 删库自愈：停服 -> 删 search.db(-wal/-shm) -> 重启 -> status.index=null（缺库非损坏）
//      -> 查询 200 不崩（惰性自建空库）-> 再全量 reindex（HTTP 轮询）-> coverage 恢复、标记可搜。
//
// 退出码：0 全绿；1 失败；64 参数错。

import path from "node:path";
import fs from "node:fs";
import { createClient } from "./lib/http.mjs";
import { startServer } from "./lib/server.mjs";

const OWNER_EMAIL = "drill-owner@example.test";
const OWNER_PASSWORD = "drill-owner-pw-2026";
const SUBJECT_PASSWORD = "drill-pass-2026";
// 长 marker：ASCII 9 码点（>=3 走 trigram FTS）；短 marker：2 码点（<3 走参数化 LIKE）。
const MARKER = `zqmarkalpha${7731}kilo`;
const SHORT = `z${(7731 % 36).toString(36)}`; // 恰好 2 个 ASCII 码点（7731%36=27 -> "zr"），触发 LIKE 分流

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[check-search] ${msg}`);
  process.exit(code);
}

const basePort = Number(arg("--port") ?? "33911");
const dbFile = arg("--db");
const dataDir = arg("--data-dir");
const distEntry = arg("--dist");
const manifestFile = arg("--manifest");
const outDir = arg("--out");
const apiDir = arg("--api-dir");
if (!dbFile || !dataDir || !distEntry || !manifestFile || !outDir || !apiDir) {
  fail(64, "用法: check-search.mjs --db <abs.db> --data-dir <dir> --dist <dist/index.js> "
    + "--manifest <legacy.json> --out <dir> --api-dir <apps/api> [--port N]");
}

const searchDb = path.join(dataDir, "search.db");
const report = { mode: "FTS-only", embeddingMode: "off", vec0Hybrid: "P1-not-gated", steps: {} };
let failure = "";

async function ownerClient(baseUrl) {
  const c = createClient(baseUrl);
  const r = await c.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (r.status !== 200) fail(1, `owner 登录失败 ${r.status}: ${r.text}`);
  c.setToken(r.json.token);
  return c;
}
async function subjectClient(baseUrl, email) {
  const c = createClient(baseUrl);
  const r = await c.raw("POST", "/auth/login", { email, password: SUBJECT_PASSWORD });
  if (r.status !== 200) fail(1, `主体登录失败 ${email}: ${r.status}`);
  c.setToken(r.json.token);
  return c;
}

function search(client, q, mode) {
  return client.raw("GET", `/api/v1/search?q=${encodeURIComponent(q)}&type=doc&mode=${mode}&limit=20`);
}

/** HTTP 轮询 status 直到全量重建完成（不 spawn check-coverage CLI）。 */
async function waitIndexed(owner, label, timeoutMs = 90000) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const r = await owner.raw("GET", "/api/v1/admin/search/status");
    last = r.status === 200 ? r.json : last;
    const idx = last?.index;
    const cov = idx?.coverage;
    const clean = idx && idx.rebuilding === false && (idx.chunks?.total ?? 0) > 0
      && cov && cov.a === 0 && cov.b === 0 && cov.e === 0 && cov.f === 0;
    if (clean) return { ok: true, status: last };
    if (Date.now() - start > timeoutMs) return { ok: false, status: last };
    await new Promise((x) => setTimeout(x, 700));
  }
}

/** 实体 reindex：进行中会 409 REINDEX_IN_PROGRESS，退避重试直到 202。 */
async function kickEntityReindex(owner, type, entityId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await owner.raw("POST", "/api/v1/admin/reindex", { type, entityId });
    if (r.status === 202) return r.status;
    if (r.status !== 409) return r.status;
    await new Promise((x) => setTimeout(x, 500));
  }
  return 409;
}

/** 轮询直到 owner 在指定 mode 下搜到 docId（实体 reindex 可见性）。 */
async function waitOwnerHit(owner, q, mode, docId, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await search(owner, q, mode);
    if (r.status === 200 && r.json.items?.some((it) => it.docId === docId)) return true;
    await new Promise((x) => setTimeout(x, 500));
  }
  return false;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const kbId = manifest.subjects.kbId;
  const g1Email = manifest.subjects.users.find((u) => u.tag === "s01")?.email;
  if (!g1Email) fail(1, "manifest 缺 s01 主体");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const logFile = path.join(outDir, "search-server.log");
  const commonEnv = {
    GX_M5_SEARCH: "on",
    // 显式关闭随 API 自启的内嵌索引 worker：本脚本要精确演练"首启 index=null 缺库语义"，
    // 再由 HTTP POST /reindex 显式推进（202+status 轮询）。生产默认 worker 随 GX_M5_SEARCH=on
    // 自启（parseSearchWorkerFlag 默认 on），不关会在首启前抢建 search.db，使缺库断言失真。
    GX_SEARCH_WORKER: "off",
    GX_SEARCH_DB_PATH: searchDb,
    GX_EMBEDDING_MODE: "off",
    GX_DATA_DIR: dataDir,
  };
  let srv = await startServer({
    name: "search-new", cwd: apiDir, entry: distEntry, port: basePort,
    databaseUrl: `file:${dbFile}`, dataDir, logFile, extraEnv: commonEnv,
  });
  const baseUrl = srv.baseUrl;

  try {
    const owner = await ownerClient(baseUrl);

    // 缺库语义：首启不自动建 search.db，status.index=null；off 态 vec 不载、embedding=off。
    const preStatus = await owner.get("/api/v1/admin/search/status");
    report.steps.preStatus = {
      indexNull: preStatus.index === null,
      embeddingMode: preStatus.embedding?.mode,
      embeddingHealthy: preStatus.embedding?.healthy,
      vecLoaded: preStatus.vec?.loaded,
    };
    console.log(`[search] 首启 index.null=${preStatus.index === null} embedding=${preStatus.embedding?.mode} vec=${preStatus.vec?.loaded}`);
    if (preStatus.index !== null) failure = "首启不应已有 search.db 索引（缺库语义被破坏）";

    // 1) 全量 reindex（202）+ 2) HTTP 轮询完成。
    if (!failure) {
      const kick = await owner.raw("POST", "/api/v1/admin/reindex", {});
      console.log(`[search] owner 全量 reindex -> ${kick.status}`);
      if (kick.status !== 202) failure = `reindex 期望 202，实得 ${kick.status}`;
      if (!failure) {
        const done = await waitIndexed(owner, "full");
        report.steps.coverage = {
          completed: done.ok,
          coverage: done.status?.index?.coverage ?? null,
          chunksTotal: done.status?.index?.chunks?.total ?? null,
          backlog: done.status?.index?.backlog ?? null,
          rebuilding: done.status?.index?.rebuilding ?? null,
        };
        console.log(`[search] HTTP 轮询完成=${done.ok} chunks=${done.status?.index?.chunks?.total} coverage=${JSON.stringify(done.status?.index?.coverage ?? null)}`);
        if (!done.ok) failure = "全量 reindex 后 HTTP status coverage 未清零/仍在 rebuilding";
      }
    }

    // 3) 零泄漏：长 marker 三请求态 + 短 marker LIKE 态。
    let markerDocId = null;
    let shortDocId = null;
    if (!failure) {
      const created = await owner.post(`/kb/${kbId}/docs`, { kind: "doc", title: `标记文档 ${MARKER}` });
      markerDocId = created.doc.id;
      await owner.put(`/kb/docs/${markerDocId}/content`, { content: `# 标记\n\n独特词 ${MARKER} 只在此文档。\n` });
      const shortDoc = await owner.post(`/kb/${kbId}/docs`, { kind: "doc", title: `短词标记 ${SHORT}` });
      shortDocId = shortDoc.doc.id;
      await owner.put(`/kb/docs/${shortDocId}/content`, { content: `# 短\n\n短词 ${SHORT} 独有。\n` });
      const e1 = await kickEntityReindex(owner, "doc", markerDocId);
      const e2 = await kickEntityReindex(owner, "doc", shortDocId);
      if (e1 !== 202 || e2 !== 202) failure = `实体 reindex 期望两个 202，得 ${e1}/${e2}`;

      const ownerLong = await waitOwnerHit(owner, MARKER, "fts", markerDocId);
      const ownerShort = await waitOwnerHit(owner, SHORT, "auto", shortDocId);

      const g1 = await subjectClient(baseUrl, g1Email);
      const modeResults = {};
      let leak = false;
      for (const mode of ["auto", "fts", "vector"]) {
        const r = await search(g1, MARKER, mode);
        const ids = (r.status === 200 ? r.json.items : []).map((it) => it.docId);
        // 长 marker 全文独特，可做响应原文零泄漏断言。
        const rawLeak = r.status === 200 && r.text.includes(MARKER);
        modeResults[mode] = { status: r.status, effectiveMode: r.json?.mode ?? null, degraded: r.json?.degraded ?? [], ids, rawLeak };
        if (r.status !== 200 || ids.includes(markerDocId) || rawLeak) leak = true;
      }
      // 短词 LIKE 态：auto + len=2 触发 like；只断言结果集不含该 doc（短词可能自然出现在别处，不做全文断言）。
      const shortRes = await search(g1, SHORT, "auto");
      const shortIds = (shortRes.status === 200 ? shortRes.json.items : []).map((it) => it.docId);
      const shortLeak = shortRes.status !== 200 || shortIds.includes(shortDocId);
      const shortEff = shortRes.json?.mode ?? null;
      modeResults.likeShort = { status: shortRes.status, effectiveMode: shortEff, ids: shortIds, rawLeak: null };
      if (shortEff !== "like") failure = `2 码点短词应走参数化 LIKE，实得 effectiveMode=${shortEff}`;
      else if (shortLeak) leak = true;

      report.steps.zeroLeak = {
        markerDocId, shortDocId, ownerLongHit: ownerLong, ownerShortHit: ownerShort,
        g1Email, modes: modeResults,
        pass: ownerLong && ownerShort && !leak,
      };
      console.log(`[search] owner 长命中=${ownerLong} 短(LIKE)命中=${ownerShort}；g1 泄漏=${leak}`);
      if (!ownerLong || !ownerShort) failure = "owner 检不到标记 doc（索引未生效或分流不符）";
      if (leak) failure = "无权主体检索泄漏标记 doc/原文";
    }

    // 4) 删库自愈：停服 -> 删 -> 重启。
    if (!failure) {
      await srv.stop();
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = searchDb + suffix;
        if (fs.existsSync(f)) fs.rmSync(f);
      }
      report.steps.deleted = { existsAfterDelete: fs.existsSync(searchDb) };
      srv = await startServer({
        name: "search-heal", cwd: apiDir, entry: distEntry, port: basePort + 1,
        databaseUrl: `file:${dbFile}`, dataDir, logFile, extraEnv: commonEnv,
      });
      const owner2 = await ownerClient(srv.baseUrl);
      const nullStatus = await owner2.get("/api/v1/admin/search/status");
      const probe = await search(owner2, MARKER, "fts"); // 缺库应急：200 不崩
      const kick2 = await owner2.raw("POST", "/api/v1/admin/reindex", {});
      const done2 = kick2.status === 202 ? await waitIndexed(owner2, "heal") : { ok: false, status: null };
      const ownerFound = await waitOwnerHit(owner2, MARKER, "fts", markerDocId);
      const g1b = await subjectClient(srv.baseUrl, g1Email);
      const leakAfter = (await search(g1b, MARKER, "fts")).text.includes(MARKER);
      report.steps.selfHeal = {
        statusIndexNullAfterDelete: nullStatus.index === null,
        embeddingMode: nullStatus.embedding?.mode ?? null,
        probeStatus: probe.status,
        reindexStatus: kick2.status,
        coverage: done2.status?.index?.coverage ?? null,
        chunksTotal: done2.status?.index?.chunks?.total ?? null,
        ownerMarkerFound: ownerFound,
        g1LeakAfter: leakAfter,
        pass: nullStatus.index === null && probe.status === 200 && kick2.status === 202
          && done2.ok && ownerFound && !leakAfter,
      };
      console.log(`[search] 自愈：indexNull=${nullStatus.index === null} probe=${probe.status} `
        + `恢复=${done2.ok} owner=${ownerFound} g1泄漏=${leakAfter}`);
      if (!report.steps.selfHeal.pass) failure = "删库后重建/恢复 coverage 失败";
    }
  } finally {
    await srv.stop();
  }

  report.pass = !failure;
  report.failure = failure || null;
  const outFile = path.join(outDir, "search-result.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[search] ${report.pass ? "PASS (FTS-only, vec0 hybrid=P1)" : "FAIL: " + failure} -> ${outFile}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[check-search] 失败：", e);
  process.exit(1);
});

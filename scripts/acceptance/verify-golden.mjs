#!/usr/bin/env node
// scripts/acceptance/verify-golden.mjs
// 门② G2 补强②：M4 升级后权限引擎黄金值核验（硬编码期望判定表，禁止循环论证）。
//
//   D. 回填对账幂等（reconcile-policies 只读 A/B/C=0 + --apply no changes）—— golden/reconcile.mjs
//   A. 自举证据（owner 恰一行 role_owner、21 drill 用户 ACTIVE、ws_default、五系统角色）—— golden/bootstrapEvidence.mjs
//   B1. g1..g6 旧库侧黄金主体（硬编码期望，本文件）
//   C. 12 LCG 随机主体：独立 legacyExpect.mjs 裸 SQL 推导 vs 引擎 effective 对拍（本文件）
//   B2~B5. 多源并集/部门子树/继承中断/停用闭环（升级后新结构）—— golden/scenarios.mjs
//
// 前置（驱动保证）：候选 dist 服务已起（GX_ENTERPRISE_ORG/NAV on）、nav-reconcile --apply 已重建 path。
// 退出码：0 全绿；1 有黄金/对拍/幂等失败；64 参数错。

import path from "node:path";
import fs from "node:fs";
import { createClient } from "./lib/http.mjs";
import { openDb } from "./lib/db.mjs";
import { loadLegacyGrants, expectedActionsFor } from "./lib/legacyExpect.mjs";
import { runReconcileIdempotency } from "./golden/reconcile.mjs";
import { collectBootstrapEvidence } from "./golden/bootstrapEvidence.mjs";
import { scenarioUnion, scenarioDeptSubtree, scenarioCutoff, scenarioDisabled } from "./golden/scenarios.mjs";

const OWNER_EMAIL = "drill-owner@example.test";
const OWNER_PASSWORD = "drill-owner-pw-2026";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[verify-golden] ${msg}`);
  process.exit(code);
}

const baseUrl = arg("--base-url");
const dbFile = arg("--db");
const manifestFile = arg("--manifest");
const outDir = arg("--out");
const apiDir = arg("--api-dir");
if (!baseUrl || !dbFile || !manifestFile || !outDir || !apiDir) {
  fail(64, "用法: verify-golden.mjs --base-url <url> --db <abs.db> --manifest <legacy.json> --out <dir> --api-dir <apps/api>");
}

const nodeId = (kind, rid) => `nav_${kind}_${rid}`;
const norm = (actions) => [...actions].sort();
const eqSet = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const db = openDb(dbFile, { readonly: true });
  const grants = loadLegacyGrants(db);

  const api = createClient(baseUrl);
  const login = await api.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (login.status !== 200) fail(1, `owner 登录失败 ${login.status}: ${login.text}`);
  api.setToken(login.json.token);

  const results = { bootstrap: {}, reconcile: {}, golden: [], deptSubtree: {}, cutoff: {}, disabled: {}, lcg: [] };
  let failed = 0;
  const record = (item) => { results.golden.push(item); if (!item.pass) failed += 1; };

  const userIdByEmail = new Map();
  async function userByEmail(email) {
    if (userIdByEmail.has(email)) return userIdByEmail.get(email);
    const r = await api.get(`/api/v1/org/members?limit=100&q=${encodeURIComponent(email)}`);
    const u = r.items.find((x) => x.email === email);
    if (!u) throw new Error(`成员目录找不到 ${email}`);
    userIdByEmail.set(email, u.id);
    return u.id;
  }

  /** owner 代查某用户在某节点的有效动作集（GET /v1/nodes/:id/effective?userId=）。 */
  async function effective(userId, kind, resourceId) {
    const nid = nodeId(kind, resourceId);
    const r = await api.raw("GET", `/api/v1/nodes/${nid}/effective?userId=${encodeURIComponent(userId)}`);
    if (r.status !== 200) return { status: r.status, actions: null, body: r.text.slice(0, 200) };
    return { status: 200, actions: norm(r.json.actions), perAction: r.json.perAction };
  }

  const S = manifest.subjects;
  const byTag = Object.fromEntries(S.users.map((u) => [u.tag, u.email]));
  const gLegacy = Object.fromEntries(S.goldenLegacy.map((g) => [g.scenario.split("-")[0], g]));
  const base1 = S.base1; const base2 = S.base2; const kbId = S.kbId;
  const ctx = {
    userByEmail, effective, byTag, gLegacy, base1, base2, kbId, db, baseUrl,
    createClient, nodeId, record,
  };

  // ---------- D. 回填对账幂等（必须在任何新策略构造之前） ----------
  results.reconcile = await runReconcileIdempotency(apiDir, dbFile);
  if (!results.reconcile.readOnly.pass) failed += 1;
  if (!results.reconcile.apply.pass) failed += 1;

  // ---------- A. 自举证据 ----------
  results.bootstrap = collectBootstrapEvidence(db);
  if (!results.bootstrap.pass) failed += 1;

  // ---------- B1. g1..g6：旧库侧黄金主体（不新增授予，直接对硬编码期望） ----------
  const goldenChecks = [
    { tag: gLegacy.g1.tag, name: "g1 base viewer 在 base1", kind: "base", rid: base1, want: ["r"] },
    { tag: gLegacy.g2.tag, name: "g2 base editor 在 base1", kind: "base", rid: base1, want: ["r", "c", "u", "d", "comment"] },
    { tag: gLegacy.g3.tag, name: "g3 base creator 在 base1", kind: "base", rid: base1, want: ["r", "c", "u", "d", "comment", "manage_schema"] },
    { tag: gLegacy.g1.tag, name: "g1 base viewer 在 table 节点(沿base继承)", kind: "table", rid: manifest.bases[0].plain, want: ["r"] },
    { tag: gLegacy.g4.tag, name: "g4 kb viewer 在 kb 节点", kind: "kb", rid: kbId, want: ["r"] },
    { tag: gLegacy.g4.tag, name: "g4 kb viewer 继承到 aclDoc", kind: "doc", rid: S.aclDocId, want: ["r"] },
    { tag: gLegacy.g5.tag, name: "g5 kb viewer+acl editor 取较高(aclDoc)", kind: "doc", rid: S.aclDocId, want: ["r", "c", "u", "d", "comment"] },
    { tag: gLegacy.g5.tag, name: "g5 kb viewer 在 kb 节点仍仅 r", kind: "kb", rid: kbId, want: ["r"] },
    { tag: gLegacy.g6.tag, name: "g6 kb editor 在 kb 节点", kind: "kb", rid: kbId, want: ["r", "c", "u", "d", "comment"] },
    { tag: gLegacy.g6.tag, name: "g6 creator 兜底全动作(自建doc)", kind: "doc", rid: S.creatorDocId,
      want: ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"] },
  ];
  for (const c of goldenChecks) {
    const uid = await userByEmail(byTag[c.tag]);
    const got = await effective(uid, c.kind, c.rid);
    record({
      case: c.name, tag: c.tag, node: `${c.kind}:${c.rid}`,
      want: norm(c.want), got: got.actions, httpStatus: got.status,
      pass: got.status === 200 && eqSet(got.actions, c.want),
    });
  }

  // ---------- C. 12 LCG 随机主体（纯净态，独立旧语义期望 vs 引擎自动对拍） ----------
  for (const gr of S.randomGrants) {
    const email = byTag[gr.tag];
    if (!email) continue;
    const uid = await userByEmail(email);
    let kind; let rid;
    if (gr.kind === "base") { kind = "base"; rid = gr.base; }
    else if (gr.kind === "kb") { kind = "kb"; rid = gr.kb; }
    else {
      rid = gr.doc;
      // acl 轮询的池含 doc 与 canvas，按 kb_docs.kind 决定 nav 节点 kind。
      kind = grants.docMeta.get(rid)?.kind === "canvas" ? "canvas" : "doc";
    }
    const want = norm(expectedActionsFor(grants, uid, { kind, resourceId: rid }));
    const got = await effective(uid, kind, rid);
    results.lcg.push({
      tag: gr.tag, grant: gr.kind, role: gr.role, node: `${kind}:${rid}`,
      expected: want, actual: got.actions, httpStatus: got.status,
      pass: got.status === 200 && eqSet(got.actions, want),
    });
  }
  if (results.lcg.some((x) => !x.pass)) failed += 1;

  // ---------- B2~B5：升级后新结构（写操作，置于纯净态判定之后） ----------
  await scenarioUnion(api, ctx);
  results.deptSubtree = await scenarioDeptSubtree(api, ctx);
  if (!results.deptSubtree.pass) failed += 1;
  results.cutoff = await scenarioCutoff(api, ctx);
  if (!results.cutoff.pass) failed += 1;
  results.disabled = await scenarioDisabled(api, ctx);
  if (!results.disabled.pass) failed += 1;

  results.summary = {
    goldenTotal: results.golden.length,
    goldenPass: results.golden.filter((x) => x.pass).length,
    lcgTotal: results.lcg.length,
    lcgPass: results.lcg.filter((x) => x.pass).length,
    bootstrapPass: results.bootstrap.pass,
    reconcilePass: results.reconcile.readOnly?.pass && results.reconcile.apply?.pass,
    deptSubtreePass: results.deptSubtree.pass,
    cutoffPass: results.cutoff.pass,
    disabledPass: results.disabled.pass,
    failed,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "golden-result.json");
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`[golden] 黄金 ${results.summary.goldenPass}/${results.summary.goldenTotal}，`
    + `LCG ${results.summary.lcgPass}/${results.summary.lcgTotal}，`
    + `自举=${results.bootstrap.pass} 对账=${results.summary.reconcilePass} `
    + `子树=${results.deptSubtree.pass} 中断=${results.cutoff.pass} 停用=${results.disabled.pass}`);
  console.log(`[golden] -> ${outFile}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[verify-golden] 失败：", e);
  process.exit(1);
});

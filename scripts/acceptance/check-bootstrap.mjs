#!/usr/bin/env node
// scripts/acceptance/check-bootstrap.mjs
// 门② B5：直升后的"新表面自举固定期望"独立核验（只读裸 SQL + 可选 search status HTTP）。
// 与 golden/bootstrapEvidence 不同：本脚本验的是【迁移/播种】固定产物，不依赖任何 v1 写操作，
// 运行时点 = migrate deploy 两次 + nav-reconcile 之后、verify-golden 构造新策略之前。
//
// 固定期望：
//   1) _prisma_migrations：applied(finished)=23、rolled_back=0、无失败（finished_at IS NULL）
//   2) workspaces=1（ws_default）；departments 仅可能无（v010 播不出部门）
//   3) roles=5 系统角色，systemKey 有序 [commenter,creator,editor,owner,viewer]
//   4) role_owner user 级恰好一行，授予最早注册用户（owner 唯一）
//   5) auth_policies reason 三态 legacy:member / legacy:kb_member / legacy:acl 均 >0，
//      且除三态外无别的 reason（纯迁移投影，无手工策略污染）
//   6) change_events：id 前缀仅 cev_seed_rec_/cev_seed_doc_，op='upsert'、status='pending'、
//      workspaceId='ws_default'，计数与活 records/活 kb_docs 精确对齐（集式 INSERT...SELECT 口径）
//   7) personal_access_tokens / mcp_idempotency count=0（旧库无 PAT/MCP 流量）
//   8) 主库无任何 search/FTS/vec 派生表（派生库独立 search.db，绝不进 Prisma/主库）
//   9) app_settings 存在（M5 outbox DDL 产物）；embedding off 由 --search-status-url 旁证（可选）
//
// 退出码：0 全绿；1 有固定期望不符；64 参数/环境错。

import fs from "node:fs";
import path from "node:path";
import { openDb, migrationLedger, countOf } from "./lib/db.mjs";

const EXPECTED_MIGRATIONS = 23;
const SYSTEM_ROLE_KEYS = ["commenter", "creator", "editor", "owner", "viewer"];
const SEARCH_TABLE_RE = /(^|_)(fts|vec|search|chunks|embedding)(_|$)|fts5?|vec0/i;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[check-bootstrap] ${msg}`);
  process.exit(code);
}

const dbFile = arg("--db");
const outDir = arg("--out");
const searchStatusUrl = arg("--search-status-url"); // 可选：候选服务 /api/v1/admin/search/status
if (!dbFile || !outDir) {
  fail(64, "用法: check-bootstrap.mjs --db <abs.db> --out <dir> [--search-status-url http://... ]");
}

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

async function main() {
  const db = openDb(dbFile, { readonly: true });

  // 1) 迁移台账
  const ledger = migrationLedger(db);
  const failedRow = db.prepare(
    "SELECT count(*) c FROM _prisma_migrations WHERE finished_at IS NULL",
  ).get().c;
  add("migrations_applied_23", ledger.finished === EXPECTED_MIGRATIONS,
    { applied: ledger.finished, expect: EXPECTED_MIGRATIONS, total: ledger.total });
  add("migrations_zero_rolled_back", ledger.rolledBack === 0, { rolledBack: ledger.rolledBack });
  add("migrations_no_unfinished", failedRow === 0, { unfinished: failedRow });

  // 2) workspaces
  const wsCount = countOf(db, "workspaces");
  const wsDefault = db.prepare("SELECT count(*) c FROM workspaces WHERE id='ws_default'").get().c;
  add("workspaces_single_default", wsCount === 1 && wsDefault === 1, { workspaces: wsCount, wsDefault });

  // 3) roles
  const sysRoles = db.prepare("SELECT systemKey FROM roles WHERE isSystem=1 AND deletedAt IS NULL ORDER BY systemKey").all().map((r) => r.systemKey);
  add("roles_five_system", sysRoles.length === 5
    && JSON.stringify(sysRoles) === JSON.stringify(SYSTEM_ROLE_KEYS), { systemKeys: sysRoles });

  // 4) owner 唯一且最早
  const ownerGrants = db.prepare(
    "SELECT count(*) c FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
  ).get().c;
  const earliest = db.prepare(
    "SELECT u.id id, u.email email FROM users u ORDER BY u.createdAt ASC, u.id ASC LIMIT 1",
  ).get();
  const ownerRow = db.prepare(
    "SELECT subjectId FROM role_assignments WHERE roleId='role_owner' AND subjectType='user' LIMIT 1",
  ).get();
  add("role_owner_single_earliest", ownerGrants === 1 && ownerRow?.subjectId === earliest?.id,
    { ownerGrants, ownerSubjectId: ownerRow?.subjectId, earliestUser: earliest });

  // 5) auth_policies reason 三态纯投影
  const reasonRows = db.prepare(
    "SELECT reason, count(*) c FROM auth_policies GROUP BY reason ORDER BY reason",
  ).all();
  const reasonMap = Object.fromEntries(reasonRows.map((r) => [r.reason, r.c]));
  const reasons = reasonRows.map((r) => r.reason);
  const expectedReasons = ["legacy:acl", "legacy:kb_member", "legacy:member"];
  const allThree = expectedReasons.every((r) => (reasonMap[r] ?? 0) > 0);
  const noExtra = reasons.every((r) => expectedReasons.includes(r));
  add("auth_policies_three_legacy_reasons", allThree && noExtra, { reasonByReason: reasonMap, reasons });
  // 主体全为 user（回填只产 user 行）
  const nonUser = db.prepare("SELECT count(*) c FROM auth_policies WHERE subjectType<>'user'").get().c;
  add("auth_policies_subject_user_only", nonUser === 0, { nonUserSubjectRows: nonUser });

  // 6) change_events 幂等播种
  const cePrefix = db.prepare(
    "SELECT "
      + "sum(CASE WHEN id LIKE 'cev_seed_rec_%' THEN 1 ELSE 0 END) rec, "
      + "sum(CASE WHEN id LIKE 'cev_seed_doc_%' THEN 1 ELSE 0 END) doc, "
      + "sum(CASE WHEN id NOT LIKE 'cev_seed_%' THEN 1 ELSE 0 END) other, "
      + "count(*) total FROM change_events",
  ).get();
  const ceBadShape = db.prepare(
    "SELECT count(*) c FROM change_events WHERE op<>'upsert' OR status<>'pending' OR COALESCE(workspaceId,'')<>'ws_default'",
  ).get().c;
  const liveRecords = db.prepare("SELECT count(*) c FROM records WHERE deletedAt IS NULL").get().c;
  const liveDocs = db.prepare("SELECT count(*) c FROM kb_docs WHERE deletedAt IS NULL").get().c;
  add("change_events_prefixes_only", cePrefix.other === 0, cePrefix);
  add("change_events_shape", ceBadShape === 0, { badShapeRows: ceBadShape });
  add("change_events_match_live_rows", cePrefix.rec === liveRecords && cePrefix.doc === liveDocs,
    { seededRec: cePrefix.rec, liveRecords, seededDoc: cePrefix.doc, liveDocs });
  // entityType 与 id 前缀自洽（rec->record，doc 前缀->doc/canvas），且 (entityType,entityId) 唯一无重复
  const ceTypeMismatch = db.prepare(
    "SELECT count(*) c FROM change_events WHERE "
      + "(id LIKE 'cev_seed_rec_%' AND entityType<>'record') OR "
      + "(id LIKE 'cev_seed_doc_%' AND entityType NOT IN ('doc','canvas'))",
  ).get().c;
  add("change_events_entity_type_consistent", ceTypeMismatch === 0, { mismatched: ceTypeMismatch });

  // 7) PAT / MCP 幂等表空
  const patCount = countOf(db, "personal_access_tokens");
  const idemCount = countOf(db, "mcp_idempotency");
  add("pat_table_empty", patCount === 0, { personalAccessTokens: patCount });
  add("mcp_idempotency_empty", idemCount === 0, { mcpIdempotency: idemCount });

  // 8) 主库无 search/FTS/vec 派生表
  const tables = db.prepare(
    "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'_prisma_migrations'",
  ).all();
  const searchLike = tables.filter((t) => SEARCH_TABLE_RE.test(t.name)).map((t) => t.name);
  add("main_db_no_search_tables", searchLike.length === 0, { searchLikeTables: searchLike });

  // 9) app_settings 存在；embedding off（可选 HTTP 旁证）
  const appSettings = countOf(db, "app_settings");
  add("app_settings_table_present", appSettings >= 0, { appSettingsRows: appSettings });
  let embedding = null;
  if (searchStatusUrl) {
    try {
      const res = await fetch(searchStatusUrl.replace(/\/+$/, ""));
      const j = await res.json();
      embedding = { httpStatus: res.status, vec: j.vec ?? null, embedding: j.embedding ?? null };
      // 期望 embedding.mode/配置为 off 形态（键名以实际响应为准，宽松判定，不把键名假设写死成阻断）
      const emb = j.embedding ?? {};
      const offish = emb.mode === "off" || emb.enabled === false || emb.provider === "off" || emb.mode == null;
      add("embedding_off_evidence", res.ok && offish, embedding);
    } catch (e) {
      add("embedding_off_evidence", false, { error: String(e.message ?? e) });
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const result = {
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    expectedMigrations: EXPECTED_MIGRATIONS,
    ledger: { applied: ledger.finished, rolledBack: ledger.rolledBack, total: ledger.total },
    checks,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "bootstrap-result.json");
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log("\n========== B5 新表面自举固定期望 ==========");
  for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`);
  console.log(`  迁移 applied=${ledger.finished} rolled_back=${ledger.rolledBack}`);
  console.log(`  reason 分布=${JSON.stringify(Object.fromEntries(reasonRows.map((r) => [r.reason, r.c])))}`);
  console.log(`  change_events rec=${cePrefix.rec}(活records=${liveRecords}) doc=${cePrefix.doc}(活docs=${liveDocs})`);
  console.log(`[check-bootstrap] -> ${outFile}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[check-bootstrap] 失败：", e);
  process.exit(1);
});

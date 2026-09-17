// scripts/acceptance/diff/checks.mjs
// 七类零损坏判定（M7 计划 §3.3）+ 补强③时间戳原文零改动。纯计算，无退出码。
//   1) 每表 count 相等（旧 15 表）        2) id 集集合相等
//   3) 宽表/全记录 fields JSON 归一化深比  4) KbDoc content 逐字节 + contentVersion 不递增
//   5) 画布 content 元素数/数组序/键几何 0 diff  6) uploads 路径+size+sha256 0 diff、引用不悬空
//   7) blocks round-trip before/after normalized 逐字相等
// 补强③：createdAt/updatedAt/deletedAt/joinedAt 原始 ISO 串逐行严格相等（独立计数，非归一化遮盖）。

import fs from "node:fs";
import path from "node:path";
import { deepEq, rowsById, sharedColumns, diffColumns } from "../lib/snapnorm.mjs";

const TS_COLS = ["createdAt", "updatedAt", "deletedAt", "joinedAt"];

export function runChecks(before, after, beforeDir, afterDir) {
  const damages = [];
  const warns = [];
  const stats = {};
  const addDamage = (category, locator, expected, actual) =>
    damages.push({ category, locator, expected: fmt(expected), actual: fmt(actual) });

  const tables = Object.keys(before.legacy).filter((t) => before.legacy[t]?.present);

  checkCountIdSet(before, after, tables, stats, addDamage);
  checkRowsAndTimestamps(before, after, tables, stats, warns, addDamage);
  checkRecordFields(before, after, stats, addDamage);
  checkKbDocs(before, after, addDamage);
  checkCanvas(before, after, stats, addDamage);
  checkUploads(before, after, stats, warns, addDamage);
  checkBlocksRoundtrip(beforeDir, afterDir, stats, warns, addDamage);

  return { damages, warns, stats };
}

function fmt(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// ---------- 检查 1/2：count + id 集 ----------
function checkCountIdSet(before, after, tables, stats, addDamage) {
  for (const t of tables) {
    const b = before.legacy[t];
    const a = after.legacy[t];
    if (!a?.present) { addDamage("table-missing", t, "present", "absent"); continue; }
    if (b.count !== a.count) addDamage("count", t, b.count, a.count);
    const bi = b.idSet.slice().sort();
    const ai = a.idSet.slice().sort();
    if (bi.join("|") !== ai.join("|")) {
      const missing = bi.filter((x) => !ai.includes(x));
      const added = ai.filter((x) => !bi.includes(x));
      addDamage("id-set", t, `missing=${missing.slice(0, 5)} added=${added.slice(0, 5)}`, `b=${bi.length} a=${ai.length}`);
    }
    stats[t] = { count: a.count, tsChanges: 0, fieldDiffs: 0 };
  }
}

// ---------- 补强③：时间戳原文零改动 + 全列深比 ----------
function checkRowsAndTimestamps(before, after, tables, stats, warns, addDamage) {
  for (const t of tables) {
    const bm = rowsById(before, t);
    const am = rowsById(after, t);
    const shared = sharedColumns(before.legacy[t]?.columns, after.legacy[t]?.columns);
    const addedCols = (after.legacy[t]?.columns ?? []).filter((c) => !(before.legacy[t]?.columns ?? []).includes(c));
    const droppedCols = (before.legacy[t]?.columns ?? []).filter((c) => !(after.legacy[t]?.columns ?? []).includes(c));
    if (addedCols.length) warns.push(`${t} 升级新增列（advisory，非损坏）：${addedCols.join(",")}`);
    if (droppedCols.length) addDamage("column-dropped", t, droppedCols.join(","), "列缺失");
    const project = (r) => {
      const o = {};
      for (const c of shared) o[c] = r[c];
      return o;
    };
    for (const [id, brFull] of bm) {
      const arFull = am.get(id);
      if (!arFull) continue; // id-set 已报
      const br = project(brFull);
      const ar = project(arFull);
      for (const col of TS_COLS) {
        if (col in br || col in ar) {
          const bv = br[col] ? (br[col].__date__ ?? br[col]) : br[col] ?? null;
          const av = ar[col] ? (ar[col].__date__ ?? ar[col]) : ar[col] ?? null;
          if (JSON.stringify(bv) !== JSON.stringify(av)) {
            stats[t].tsChanges++;
            addDamage("timestamp-changed", `${t}.${id}.${col}`, bv, av);
          }
        }
      }
      if (!deepEq(br, ar)) {
        const changedCols = diffColumns(br, ar);
        stats[t].fieldDiffs++;
        addDamage("row-content", `${t}.${id}`, changedCols.expectedSnippet, changedCols.actualSnippet);
      }
    }
  }
}

// ---------- 检查 3：records.fields JSON 逐键值 ----------
function checkRecordFields(before, after, stats, addDamage) {
  const bm = rowsById(before, "records");
  const am = rowsById(after, "records");
  let wideRowsChecked = 0;
  for (const [id, br] of bm) {
    const ar = am.get(id);
    if (!ar) continue;
    let bf = {};
    let af = {};
    try { bf = JSON.parse(br.fields ?? "{}"); } catch { /* 旧值原样 */ }
    try { af = JSON.parse(ar.fields ?? "{}"); } catch { /* 新值原样 */ }
    for (const fk of new Set([...Object.keys(bf), ...Object.keys(af)])) {
      if (!deepEq(bf[fk], af[fk])) addDamage("record-field", `records.${id}.fields[${fk}]`, bf[fk], af[fk]);
    }
    wideRowsChecked++;
  }
  stats.records = stats.records || {};
  stats.records.wideRowsChecked = wideRowsChecked;
}

// ---------- 检查 4：KbDoc 三列 + 元数据 ----------
function checkKbDocs(before, after, addDamage) {
  const bm = rowsById(before, "kb_docs");
  const am = rowsById(after, "kb_docs");
  for (const [id, br] of bm) {
    const ar = am.get(id);
    if (!ar) continue;
    if (br.content !== ar.content) addDamage("kb-content", `kb_docs.${id}(${br.kind})`, `${String(br.content).length}字节`, `${String(ar.content).length}字节`);
    if (Number(br.contentVersion) !== Number(ar.contentVersion)) addDamage("kb-content-version", `kb_docs.${id}`, br.contentVersion, ar.contentVersion);
    if (String(br.searchText ?? "") !== String(ar.searchText ?? "")) {
      addDamage("kb-search-text", `kb_docs.${id}`, `${String(br.searchText).length}字`, `${String(ar.searchText).length}字`);
    }
    for (const col of ["kind", "title", "parentId", "shareToken", "shareRole", "shareIncludeChildren", "shareEnabled"]) {
      if (JSON.stringify(br[col] ?? null) !== JSON.stringify(ar[col] ?? null)) addDamage("kb-meta", `kb_docs.${id}.${col}`, br[col], ar[col]);
    }
  }
}

// ---------- 检查 5：画布元素保真 ----------
function checkCanvas(before, after, stats, addDamage) {
  const bm = rowsById(before, "kb_docs");
  const am = rowsById(after, "kb_docs");
  let checked = 0;
  for (const [id, br] of bm) {
    if (br.kind !== "canvas") continue;
    const ar = am.get(id);
    if (!ar) continue;
    checked++;
    let be = [];
    let ae = [];
    try { be = JSON.parse(br.content ?? "[]"); } catch { addDamage("canvas-parse", id, "ok", "before bad json"); }
    try { ae = JSON.parse(ar.content ?? "[]"); } catch { addDamage("canvas-parse", id, "ok", "after bad json"); }
    if (be.length !== ae.length) addDamage("canvas-element-count", id, be.length, ae.length);
    const n = Math.min(be.length, ae.length);
    for (let i = 0; i < n; i++) {
      if (!deepEq(be[i], ae[i])) {
        addDamage("canvas-element", `kb_docs.${id}[${i}] id=${be[i]?.id}`, `keys=${Object.keys(be[i] ?? {}).sort().join(",")}`, `keys=${Object.keys(ae[i] ?? {}).sort().join(",")}`);
      }
    }
  }
  stats.canvasBoardsChecked = checked;
}

// ---------- 检查 6：uploads 清单 + attachment 引用不悬空 ----------
function checkUploads(before, after, stats, warns, addDamage) {
  const bu = before.uploads ?? [];
  const au = after.uploads ?? [];
  if (before.uploads && after.uploads) {
    if (bu.length !== au.length) addDamage("uploads-count", "uploads", bu.length, au.length);
    const amap = new Map(au.map((f) => [f.relPath, f]));
    for (const f of bu) {
      const g = amap.get(f.relPath);
      if (!g) { addDamage("uploads-missing", f.relPath, "present", "absent"); continue; }
      if (f.size !== g.size) addDamage("uploads-size", f.relPath, f.size, g.size);
      if (f.sha256 !== g.sha256) addDamage("uploads-sha", f.relPath, f.sha256.slice(0, 16), g.sha256.slice(0, 16));
    }
  } else {
    warns.push("uploads 快照缺失（before 或 after 未提供 --uploads），跳过附件字节比对");
  }
  const am = rowsById(after, "records");
  const uploadRelPaths = new Set((after.uploads ?? []).map((f) => f.relPath));
  let refsChecked = 0;
  for (const [, ar] of am) {
    let fields = {};
    try { fields = JSON.parse(ar.fields ?? "{}"); } catch { continue; }
    for (const v of Object.values(fields)) {
      for (const item of Array.isArray(v) ? v : []) {
        if (item && typeof item === "object" && item.url && typeof item.id === "string" && item.mime) {
          refsChecked++;
          const rel = String(item.url).replace(/^\/uploads\//, "");
          if (!uploadRelPaths.has(rel)) addDamage("attachment-dangling", `records.${ar.id} att.${item.id}`, rel, "not in uploads manifest");
        }
      }
    }
  }
  stats.attachmentRefsChecked = refsChecked;
}

// ---------- 检查 7：blocks round-trip ----------
function checkBlocksRoundtrip(beforeDir, afterDir, stats, warns, addDamage) {
  const rtBefore = path.join(beforeDir, "roundtrip.json");
  const rtAfter = path.join(afterDir, "roundtrip.json");
  if (!fs.existsSync(rtBefore) || !fs.existsSync(rtAfter)) {
    warns.push("未提供 roundtrip.json（blocks-roundtrip.mts 预生成），跳过 blocks round-trip");
    return;
  }
  const rb = JSON.parse(fs.readFileSync(rtBefore, "utf8"));
  const ra = JSON.parse(fs.readFileSync(rtAfter, "utf8"));
  const afterById = new Map((ra.items ?? []).map((x) => [x.docId, x]));
  for (const item of rb.items ?? []) {
    if (!item.ok) addDamage("blocks-roundtrip", `before ${item.docId}`, "roundtrip ok", item.error);
    const m = afterById.get(item.docId);
    if (!m) { addDamage("blocks-roundtrip", `doc ${item.docId}`, "after 有对应项", "缺失"); continue; }
    if (!m.ok) addDamage("blocks-roundtrip", `after ${item.docId}`, "roundtrip ok", m.error);
    if (item.normalized !== m.normalized) addDamage("blocks-roundtrip", `doc ${item.docId}`, "before/after normalized 一致", "漂移");
  }
  stats.blocksRoundtrip = (rb.items ?? []).length;
}

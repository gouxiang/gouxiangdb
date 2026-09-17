// scripts/acceptance/lib/snapnorm.mjs
// snapshot 比对专用纯函数：时间戳归一化、JSON 深比、行列投影。
// 归一化【仅】用于 JSON 结构比对；时间戳零改动检查必须用原始 ISO 串严格相等（见 checks.mjs）。

// 时间戳归一化（仅用于 JSON 深比）
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
export function normTs(v) {
  if (typeof v !== "string" || !TS_RE.test(v)) return v;
  // 统一为 epoch 毫秒整数（容忍秒/毫秒、空格/T、带不带时区；裸串按本地解析由 Date 处理）
  const t = Date.parse(v.replace(" ", "T"));
  return Number.isNaN(t) ? v : `ts:${t}`;
}

export function deepNorm(v) {
  if (v === null || typeof v !== "object") return normTs(v);
  if (v.__date__) return `ts:${Date.parse(v.__date__)}`;
  if (v.__bigint__) return `bigint:${v.__bigint__}`;
  if (v.__buf_hex__) return `buf:${v.__buf_hex__}`;
  if (Array.isArray(v)) return v.map(deepNorm);
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = deepNorm(v[k]);
  return o;
}

export function deepEq(a, b) {
  return JSON.stringify(deepNorm(a)) === JSON.stringify(deepNorm(b));
}

export function rowsById(snap, table) {
  const list = snap.legacy[table]?.rows ?? [];
  const m = new Map();
  for (const r of list) m.set(String(r.id), r);
  return m;
}

/**
 * 升级会给旧表【加列】（如迁移 13 给 users 加六列常量默认值）。零损坏口径是
 * "迁移不改旧行的旧列原文"，故逐行深比只在 before/after 列交集上进行；
 * 新增列单独记 advisory，不算损坏。
 */
export function sharedColumns(beforeCols, afterCols) {
  const b = new Set(beforeCols ?? []);
  return (afterCols ?? []).filter((c) => b.has(c));
}

export function diffColumns(br, ar) {
  const keys = new Set([...Object.keys(br), ...Object.keys(ar)]);
  const diffs = [];
  for (const k of keys) {
    if (!deepEq(br[k], ar[k])) diffs.push(k);
  }
  return { expectedSnippet: `cols[${diffs.join(",")}] before`, actualSnippet: `cols[${diffs.join(",")}] after` };
}

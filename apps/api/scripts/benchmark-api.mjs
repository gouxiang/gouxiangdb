#!/usr/bin/env node
// scripts/benchmark-api.mjs
// v2 API 性能基准：测量关键接口在 10/100/1000/5000 records 下的延迟。
//
// 用法：
//   node scripts/benchmark-api.mjs [--api URL] [--token TOKEN] [--base-id ID] [--rounds N]
//
// 输出：每行 (endpoint, records, avg_ms, p50_ms, p95_ms, throughput_qps)

import process from "node:process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const API = (arg("api", process.env.V2_API) || "http://127.0.0.1:3001").replace(/\/+$/, "");
const TOKEN = arg("token", process.env.V2_TOKEN);
const BASE_ID = arg("base-id", process.env.V2_BASE_ID);
const TABLE_ID = arg("table-id", process.env.V2_TABLE_ID);  // 可选：指定具体表
const ROUNDS = Number(arg("rounds", "3"));

if (!TOKEN) { console.error("缺少 token"); process.exit(1); }
if (!BASE_ID) { console.error("缺少 base-id"); process.exit(1); }

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}`);
  return res.json();
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const avg = sorted.reduce((s, v) => s + v, 0) / n;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  return { avg, p50, p95 };
}

function fmt({ avg, p50, p95 }) {
  return `avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`;
}

async function bench(name, fn, rounds = ROUNDS) {
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return { name, ...stats(samples), rounds };
}

async function main() {
  console.log(`🔧 基准环境：API=${API} base=${BASE_ID} rounds=${ROUNDS}\n`);

  const base = await req("GET", `/api/bases/${BASE_ID}`);
  console.log(`Base: ${base.base.name}  tables=${base.base.tableCount}\n`);

  const tables = (await req("GET", `/api/tables?baseId=${BASE_ID}`)).tables;
  console.log(`Tables: ${tables.length}`);

  // 选表：优先 --table-id，否则用第一张含 Stress_ 前缀的表（压力表），最后才用第一张
  let table = null;
  if (TABLE_ID) {
    table = tables.find((t) => t.id === TABLE_ID);
  }
  if (!table) {
    table = tables.find((t) => t.name.startsWith("Stress_"));
  }
  if (!table) table = tables[0];
  console.log(`基准表：${table.id} (${table.name})\n`);

  const fields = (await req("GET", `/api/fields?tableId=${table.id}`)).fields;
  console.log(`字段数：${fields.length}`);

  const records = (await req("GET", `/api/records?tableId=${table.id}&limit=1`)).records;
  const totalRec = records.length > 0
    ? (await req("GET", `/api/records?tableId=${table.id}&limit=1&offset=0`)).total
    : 0;
  console.log(`记录数：${totalRec}\n`);

  const results = [];

  // 1. 单条记录查询
  if (records.length > 0) {
    const recId = records[0].id;
    results.push(await bench("GET /records/:id", () => req("GET", `/api/records/${recId}`)));
  }

  // 2. 记录列表（小数据）
  results.push(await bench("GET /records?limit=50", () =>
    req("GET", `/api/records?tableId=${table.id}&limit=50`)));

  // 3. 记录列表（大数据，limit=500）
  results.push(await bench("GET /records?limit=500", () =>
    req("GET", `/api/records?tableId=${table.id}&limit=500`)));

  // 4. 字段列表
  results.push(await bench("GET /fields?tableId=", () =>
    req("GET", `/api/fields?tableId=${table.id}`)));

  // 5. 视图列表
  results.push(await bench("GET /views?tableId=", () =>
    req("GET", `/api/views?tableId=${table.id}`)));

  // 6. 表列表
  results.push(await bench("GET /tables?baseId=", () =>
    req("GET", `/api/tables?baseId=${BASE_ID}`)));

  // 7. ERD 关系图（聚合查询）
  results.push(await bench("GET /bases/:id/erd", () =>
    req("GET", `/api/bases/${BASE_ID}/erd`)));

  // 8. 搜索（跨表扫描 + 字段值扫描）
  results.push(await bench("GET /search?q=item", () =>
    req("GET", `/api/search?baseId=${BASE_ID}&q=item`)));

  // 9. 健康检查
  results.push(await bench("GET /health", () => req("GET", "/api/health")));

  console.log("📊 性能基线\n");
  console.log("endpoint".padEnd(28), "rounds".padEnd(8), "latency".padEnd(36), "qps");
  console.log("─".repeat(90));
  for (const r of results) {
    const qps = (1000 / r.avg).toFixed(1);
    console.log(r.name.padEnd(28), String(r.rounds).padEnd(8), fmt(r).padEnd(36), qps);
  }
  console.log("");
  console.log("# === JSON (可被脚本解析) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
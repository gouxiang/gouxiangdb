#!/usr/bin/env node
// scripts/stress-records.mjs
// 在 v2 API 上灌一批测试数据，用于性能基准测试。
//
// 用法：
//   node scripts/stress-records.mjs --token XXX --base-id XXX --target 1000
//
// 行为：
//   - 在 base 下创建一个新表 "StressN_<timestamp>"（含 4 字段：name/singleLineText, count/number, score/number, note/longText）
//   - 灌 --target 条记录（POST /api/records）
//   - 完成后输出：表 id + 用时 + 速率

import process from "node:process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const API = (arg("api", process.env.V2_API) || "http://127.0.0.1:3001").replace(/\/+$/, "");
const TOKEN = arg("token", process.env.V2_TOKEN);
const BASE_ID = arg("base-id", process.env.V2_BASE_ID);
const TARGET = Number(arg("target", "1000"));
const BATCH = Number(arg("batch", "20"));

if (!TOKEN) { console.error("缺少 token"); process.exit(1); }
if (!BASE_ID) { console.error("缺少 base-id"); process.exit(1); }

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${method} ${path}\n${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const ts = Date.now().toString(36);
  const tableName = `Stress_${TARGET}_${ts}`;

  console.log(`🚀 创建压力表 ${tableName}（target=${TARGET} batch=${BATCH}）`);
  const tbl = (await req("POST", `/api/tables?baseId=${BASE_ID}`, { name: tableName, withDefaults: false })).table;
  console.log(`  tableId: ${tbl.id}`);

  // 字段
  const f1 = await req("POST", `/api/fields?tableId=${tbl.id}`, { name: "name", type: "singleLineText" });
  const f2 = await req("POST", `/api/fields?tableId=${tbl.id}`, { name: "count", type: "number", precision: 0 });
  const f3 = await req("POST", `/api/fields?tableId=${tbl.id}`, { name: "score", type: "number", precision: 2 });
  const f4 = await req("POST", `/api/fields?tableId=${tbl.id}`, { name: "note", type: "longText" });

  const fieldIds = [f1.field.id, f2.field.id, f3.field.id, f4.field.id];
  console.log(`  fields: ${fieldIds.length}`);

  // 灌数据
  const t0 = performance.now();
  let success = 0;
  let failed = 0;
  for (let i = 0; i < TARGET; i += BATCH) {
    const batch = [];
    for (let j = 0; j < BATCH && i + j < TARGET; j++) {
      const idx = i + j;
      batch.push(req("POST", `/api/records?tableId=${tbl.id}`, {
        fields: {
          [f1.field.id]: `item_${idx}`,
          [f2.field.id]: idx % 100,
          [f3.field.id]: (idx * 1.7) % 1000,
          [f4.field.id]: `这是记录 #${idx} 的长文本备注，包含一些随机字符 ${"x".repeat(50)}`,
        },
      }).then(() => success++).catch((e) => { failed++; if (failed < 3) console.error(`  ⚠ ${e.message.slice(0, 100)}`); }));
    }
    await Promise.all(batch);
    if ((i + BATCH) % 200 === 0 || i + BATCH >= TARGET) {
      const elapsed = (performance.now() - t0) / 1000;
      const qps = success / elapsed;
      process.stdout.write(`\r  进度：${Math.min(i + BATCH, TARGET)}/${TARGET}  qps=${qps.toFixed(1)}  ok=${success} fail=${failed}`);
    }
  }
  const elapsed = (performance.now() - t0) / 1000;
  console.log(`\n\n✅ 完成：${success}/${TARGET} 条记录，${elapsed.toFixed(1)}s，${(success / elapsed).toFixed(1)} qps`);
  console.log(`   table id: ${tbl.id}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
#!/usr/bin/env node
// scripts/acceptance/check-body-limits.mjs
// 门② G2 R6：请求体三档边界在候选构建上真打（bodyLimit 层与路由 zod 层职责分离）。
//
// 自管两个候选 dist 实例（独占端口，GX_RATE_LIMIT=off）：
//   实例 A 默认档（GX_BODY_LIMIT_JSON 缺省=1MB，/mcp 缺省=11MB）：
//     A1. 2MB JSON-RPC ping_echo -> POST /mcp 200（bodyLimit 11MB 放行；
//         ping_echo text 自身 zod 上限 200 字符，工具层错误仍是 HTTP 200 的 JSON-RPC，
//         本断言只验证 413/200 的 bodyLimit 分流，与 m6-s8-limits.e2e 同口径）
//     A2. 1,100,000 字符 JSON -> POST /api/... 413 PAYLOAD_TOO_LARGE（整包 >1MiB 默认档，
//         未达 /mcp 放宽；B6 裁决点名的默认实例 1.1MB 边界）
//     A3. 11MB+1 JSON-RPC -> POST /mcp 413 MCP_PAYLOAD_TOO_LARGE（精确 /mcp 档）
//   实例 B 放宽档（GX_BODY_LIMIT_JSON=12，让公开 2MB / 内部 10MB 两档 zod 上界都可达，
//                       不被 bodyLimit 提前 413；R6 硬要求两档都真打）：
//     B1. 匿名公开 PUT 恰 2,000,000 字符 -> 200（整包 ~2MB < 12MiB body 档；public.ts zod 2MB 上界）
//     B2. 匿名公开 PUT 2,000,001 字符 -> 400（整包仍 < 12MiB，过 bodyLimit 后 zod 拒，非 413）
//     B3. owner 内部 kb doc PUT 恰 10,000,000 字符 -> 200（docs.ts zod 10MB 上界，整包 <12MiB）
//     B4. owner 内部 kb doc PUT 10,000,001 字符 -> 400（过 bodyLimit 后 zod 10MB 上界拒，非 413）
//
// 匿名写用 seed 阶段独立建的 doc-editor-scratch（非任何 golden/对拍对象）；驱动必须在零损坏
// after 快照/diff 之后再跑本门。
//
// 退出码：0 全绿；1 失败；64 参数错。

import path from "node:path";
import fs from "node:fs";
import { createClient } from "./lib/http.mjs";
import { startServer } from "./lib/server.mjs";

const OWNER_EMAIL = "drill-owner@example.test";
const OWNER_PASSWORD = "drill-owner-pw-2026";
const MB = 1024 * 1024;
const TWO_MB = 2 * MB;
const MCP_LIMIT = 11 * MB;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[check-body-limits] ${msg}`);
  process.exit(code);
}

const dbFile = arg("--db");
const dataDir = arg("--data-dir");
const distEntry = arg("--dist");
const manifestFile = arg("--manifest");
const outDir = arg("--out");
const apiDir = arg("--api-dir");
const portA = Number(arg("--port-a") ?? "33921");
const portB = Number(arg("--port-b") ?? "33922");
if (!dbFile || !dataDir || !distEntry || !manifestFile || !outDir || !apiDir) {
  fail(64, "用法: check-body-limits.mjs --db <abs.db> --data-dir <dir> --dist <dist/index.js> "
    + "--manifest <legacy.json> --out <dir> --api-dir <apps/api> [--port-a N] [--port-b N]");
}

const results = { cases: [] };
let failed = 0;
function rec(name, pass, detail) {
  results.cases.push({ name, pass, ...detail });
  console.log(`[body] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
  if (!pass) failed += 1;
}

/** 裸 POST（不带客户端自动成功假设），回 {status, code}。 */
async function postRaw(baseUrl, urlPath, body, { token, mcp } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(mcp ? { accept: "application/json, text/event-stream" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let code = null;
  try { code = JSON.parse(text)?.code ?? null; } catch { /* not json */ }
  return { status: res.status, code, text: text.slice(0, 200) };
}
async function putRaw(baseUrl, urlPath, body, { token } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let code = null;
  try { code = JSON.parse(text)?.code ?? null; } catch { /* not json */ }
  return { status: res.status, code, text: text.slice(0, 200) };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const editorToken = manifest.shareTokens.find((t) => t.name === "doc-editor-scratch");
  if (!editorToken) fail(1, "manifest 缺 doc-editor-scratch 分享");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // ---------------- 实例 A：默认档 ----------------
  const logA = path.join(outDir, "body-server-a.log");
  const srvA = await startServer({
    name: "body-default", cwd: apiDir, entry: distEntry, port: portA,
    databaseUrl: `file:${dbFile}`, dataDir, logFile: logA,
    extraEnv: { GX_DATA_DIR: dataDir },
  });
  let patFull = null;
  try {
    const aUrl = srvA.baseUrl;
    const owner = createClient(aUrl);
    const lg = await owner.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    if (lg.status !== 200) fail(1, `owner 登录失败 ${lg.status}: ${lg.text}`);
    owner.setToken(lg.json.token);
    // ping_echo 无 scope 要求，但 PAT 必须有效；授一个最小只读 scope 建令牌。
    const pat = await owner.post("/api/v1/pats", { name: "drill-body-limit", scopes: ["record:read"] });
    patFull = pat.token;

    const rpc2mb = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping_echo", arguments: { text: "x".repeat(TWO_MB) } } };
    const a1 = await postRaw(aUrl, "/mcp", rpc2mb, { token: patFull, mcp: true });
    rec("A1 /mcp 收 2MB -> 200", a1.status === 200, { status: a1.status });

    const a2 = await postRaw(aUrl, "/api/records?tableId=none", { pad: "x".repeat(1_100_000) });
    rec("A2 /api 1,100,000 字符(整包>1MiB) -> 413 PAYLOAD_TOO_LARGE",
      a2.status === 413 && a2.code === "PAYLOAD_TOO_LARGE", { status: a2.status, code: a2.code });

    // 11MB+1：body 本身 11MB+1 字节（text 长度按整包估算到 MCP 档之上）。
    const overMcp = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping_echo", arguments: { text: "x".repeat(MCP_LIMIT + 1024) } } };
    const a3 = await postRaw(aUrl, "/mcp", overMcp, { token: patFull, mcp: true });
    rec("A3 /mcp 收 11MB+ -> 413 MCP_PAYLOAD_TOO_LARGE",
      a3.status === 413 && a3.code === "MCP_PAYLOAD_TOO_LARGE", { status: a3.status, code: a3.code });
  } finally {
    await srvA.stop();
  }

  // ---------------- 实例 B：GX_BODY_LIMIT_JSON=12（公开 2MB + 内部 10MB 两档 zod 边界） ----------------
  const logB = path.join(outDir, "body-server-b.log");
  const srvB = await startServer({
    name: "body-raised", cwd: apiDir, entry: distEntry, port: portB,
    databaseUrl: `file:${dbFile}`, dataDir, logFile: logB,
    extraEnv: { GX_DATA_DIR: dataDir, GX_BODY_LIMIT_JSON: "12" },
  });
  try {
    const bUrl = srvB.baseUrl;
    // 独立 scratch（seed 阶段专为匿名写边界建，非 golden/对拍对象）。
    const pubPath = `/api/public/s/${editorToken.token}/doc/${editorToken.rootId}/content`;

    // 整包 ~2,000,016B 与 ~2,000,017B 均 < 12MiB，过 bodyLimit，路由 zod 2,000,000 上界裁决。
    const b1 = await putRaw(bUrl, pubPath, { content: "x".repeat(2_000_000) });
    rec("B1 匿名公开 PUT 恰 2,000,000 字符 -> 200", b1.status === 200, { status: b1.status, code: b1.code });
    const b2 = await putRaw(bUrl, pubPath, { content: "x".repeat(2_000_001) });
    rec("B2 匿名公开 PUT 2,000,001 字符 -> 400(zod,非413)", b2.status === 400, { status: b2.status, code: b2.code });

    // 内部 kb doc 10MB 上界（R6 硬要求）：owner 在 kb 建独立 scratch，不碰 golden/share 正文。
    // 整包 ~10MB < 12MiB body 档，过 bodyLimit，由 docs.ts zod 10,000,000 上界裁决。
    const ownerB = createClient(bUrl);
    const lgB = await ownerB.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    if (lgB.status !== 200) fail(1, `实例B owner 登录失败 ${lgB.status}: ${lgB.text}`);
    ownerB.setToken(lgB.json.token);
    const kbId = manifest.subjects?.kbId;
    if (!kbId) fail(1, "manifest.subjects.kbId 缺失，无法构造内部 10MB scratch doc");
    const scratch = await ownerB.raw("POST", `/api/kb/${kbId}/docs`, { kind: "doc", title: "body-limit-10mb-scratch" });
    if (scratch.status !== 201 && scratch.status !== 200) {
      fail(1, `内部 scratch doc 创建失败 ${scratch.status}: ${scratch.text}`);
    }
    const scratchId = scratch.json.doc.id;
    const internalPath = `/api/kb/docs/${scratchId}/content`;
    const b3 = await putRaw(bUrl, internalPath, { content: "y".repeat(10_000_000) }, { token: lgB.json.token });
    rec("B3 owner 内部 kb doc PUT 恰 10,000,000 字符 -> 200", b3.status === 200, { status: b3.status, code: b3.code });
    const b4 = await putRaw(bUrl, internalPath, { content: "y".repeat(10_000_001) }, { token: lgB.json.token });
    rec("B4 owner 内部 kb doc PUT 10,000,001 字符 -> 400(zod,非413)", b4.status === 400, { status: b4.status, code: b4.code });
  } finally {
    await srvB.stop();
  }

  results.pass = failed === 0;
  results.failed = failed;
  const outFile = path.join(outDir, "body-limits-result.json");
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`[body] ${results.pass ? "PASS" : `FAIL ${failed} 项`} -> ${outFile}`);
  process.exit(results.pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[check-body-limits] 失败：", e);
  process.exit(1);
});

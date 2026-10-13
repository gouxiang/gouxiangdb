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
//     A4. 1,100,000 字符 -> PUT 有效【公开 editor 分享】匿名写 413 PAYLOAD_TOO_LARGE
//         （公开匿名写路径同样落 /api 默认 1MiB body 档：bodyLimit 全局 mount.use("*")、
//           早于分享档位/乐观锁，故即便分享可写也先 413；承接 check-share-links 移出的字节边界）
//   实例 B 放宽档（GX_BODY_LIMIT_JSON=12，让两条写路径的 10MB zod 上界都可达，
//                       不被 bodyLimit 提前 413；R6 硬要求公开/内部两路径都真打）：
//     B1. 匿名【公开 editor 分享】PUT 恰 10,000,000 字符 -> 200（整包 < 12MiB body 档；
//         publicDoc.ts saveContentSchema zod 10MB 上界；端点强制 baseUpdatedAt 乐观锁）
//     B2. 匿名公开 PUT 10,000,001 字符 -> 400 BAD_REQUEST（过 bodyLimit 后 zod 拒，非 413）
//     B3. owner 内部 kb doc PUT 恰 10,000,000 字符 -> 200（docs.ts zod 10MB 上界，整包 <12MiB）
//     B4. owner 内部 kb doc PUT 10,000,001 字符 -> 400（过 bodyLimit 后 zod 10MB 上界拒，非 413）
//
// 口径说明（2026-10 复核）：公开匿名编辑端点自 commit 7195f23 引入起 content zod 上界即 10MB、
//   且强制 baseUpdatedAt（产品从无"公开 2MB"档，全仓非测试 content 上界仅 publicDoc/docs 两处，
//   均 10MB）。故 B1/B2 与 B3/B4 同打 10MB 上界，区别在写路径（匿名分享 vs 认证内部）与档位语义。
//   分享由 owner 在候选服务上【运行时新建】（写 shareCreatedBy），不能复用 seed 的
//   doc-editor-scratch——那是 v0.1.0 旧服务所建、shareCreatedBy=NULL，收紧后 editor 落 VIEW_ONLY 会 403。
//   驱动必须在零损坏 after 快照/diff 之后再跑本门（本门大尺寸改写独立 scratch 库）。
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
// 正文 zod 上界是【字符数】10,000,000（publicDoc/docs 两处 saveContentSchema 字面量），
// 不是 10MiB(10,485,760)；边界用例必须按精确字符数，否则恰界用例会被自身长度顶成 400。
const CONTENT_LIMIT = 10_000_000;

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

/**
 * 仅对【网络层】错误（非 HTTP 响应）重试一次：服务端对超限 body 返回 413 后会关闭该 keep-alive
 * 连接，undici 偶发把下一个请求复用到正在关闭的 socket（fetch failed / other side closed）。
 * 这是传输层竞态而非业务结果，重建连接重发一次即可；任何真实 HTTP 状态码（含 413/400/403）都
 * 正常返回、不触发重试，故不放宽任何状态码断言。
 */
async function rawFetchOnce(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 150)); // 等连接池回收被服务端关闭的 socket
    return await fetch(url, init);
  }
}

/** 裸 POST（不带客户端自动成功假设），回 {status, code}。 */
async function postRaw(baseUrl, urlPath, body, { token, mcp } = {}) {
  const res = await rawFetchOnce(`${baseUrl}${urlPath}`, {
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
  const res = await rawFetchOnce(`${baseUrl}${urlPath}`, {
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

/** owner 登录，容忍刚就绪时偶发 fetch status=0 竞态（有限重试，非静默放行非 200）。 */
async function loginOwner(baseUrl, label, tries = 8) {
  const c = createClient(baseUrl);
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await c.raw("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
      if (r.status === 200) { c.setToken(r.json.token); return { client: c, token: r.json.token }; }
      last = r; // 非网络错误（如 401）不重试
      break;
    } catch (e) {
      last = { status: 0, text: String(e?.message ?? e) };
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  fail(1, `${label} owner 登录失败 ${last?.status}: ${last?.text}`);
  return null;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const kbId = manifest.subjects?.kbId;
  if (!kbId) fail(1, "manifest.subjects.kbId 缺失");
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
    const { client: owner } = await loginOwner(aUrl, "实例A");
    // ping_echo 无 scope 要求，但 PAT 必须有效；授一个最小只读 scope 建令牌。
    const pat = await owner.post("/api/v1/pats", { name: "drill-body-limit", scopes: ["record:read"] });
    patFull = pat.token;

    // A4【准备段】：先在任何 413 大请求之前用 owner client 小请求建好有效 editor 分享、算出 path。
    // 对【运行时新建、确实可写】的公开 editor 分享匿名 PUT 1.1M -> 413；bodyLimit 在 mount.use("*")
    // 全局生效、先于 publicDoc 档位/乐观锁，故分享有效也照样 413，不被 403 抢先。承接 check-share-links
    // 移出的公开匿名写字节边界。建 doc/分享必须排在大请求前——413 后服务端关闭该 keep-alive 连接，
    // owner client 复用会 socket reset；故 A4 的 413 PUT 挪到实例 A 最末（A3 之后），死连接后不再有请求。
    const a4Doc = await owner.raw("POST", `/api/kb/${kbId}/docs`, { kind: "doc", title: "body-default-public-scratch" });
    if (a4Doc.status !== 201 && a4Doc.status !== 200) {
      fail(1, `A4 scratch doc 创建失败 ${a4Doc.status}: ${a4Doc.text}`);
    }
    const a4Id = a4Doc.json.doc.id;
    const a4Share = await owner.raw("POST", `/api/kb/docs/${a4Id}/share`,
      { shareEnabled: true, shareRole: "editor", shareIncludeChildren: false });
    if (a4Share.status !== 200 || !a4Share.json?.share?.shareToken) {
      fail(1, `A4 editor 分享开启失败 ${a4Share.status}: ${a4Share.text}`);
    }
    const a4Path = `/api/public/s/${a4Share.json.share.shareToken}/doc/${a4Id}/content`;

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

    // A4【收尾段】：默认 1MiB 档公开匿名写 1.1M -> 413，放实例 A 最末——413 关闭的 keep-alive 连接
    // 不再被任何后续请求复用。413 在 body 解析阶段触发、到不了乐观锁；占位 baseUpdatedAt 仅为合法形状。
    const a4 = await putRaw(aUrl, a4Path, { content: "x".repeat(1_100_000), baseUpdatedAt: "1970-01-01T00:00:00.000Z" });
    rec("A4 默认档公开匿名写 1,100,000 字符 -> 413 PAYLOAD_TOO_LARGE",
      a4.status === 413 && a4.code === "PAYLOAD_TOO_LARGE", { status: a4.status, code: a4.code });
  } finally {
    await srvA.stop();
  }

  // ---------------- 实例 B：GX_BODY_LIMIT_JSON=12（公开分享 + 内部 两条写路径的 10MB zod 边界） ----------------
  const logB = path.join(outDir, "body-server-b.log");
  const srvB = await startServer({
    name: "body-raised", cwd: apiDir, entry: distEntry, port: portB,
    databaseUrl: `file:${dbFile}`, dataDir, logFile: logB,
    extraEnv: { GX_DATA_DIR: dataDir, GX_BODY_LIMIT_JSON: "12" },
  });
  try {
    const bUrl = srvB.baseUrl;
    const { client: ownerB, token: tokenB } = await loginOwner(bUrl, "实例B");

    // ---- B1/B2：匿名【公开 editor 分享】写路径 10MB zod 上界 ----
    // 运行时在 kb 建独立 scratch doc（非任何 golden/对拍对象），由 owner 开 editor 分享——
    // sharing 写 shareCreatedBy=owner，editor 档经 resolveDocShareCaps 可写（旧 seed 分享由
    // v0.1.0 旧服务创建、shareCreatedBy=NULL，收紧后 editor 落 VIEW_ONLY 会 403）。
    const pubDoc = await ownerB.raw("POST", `/api/kb/${kbId}/docs`, { kind: "doc", title: "body-limit-public-scratch" });
    if (pubDoc.status !== 201 && pubDoc.status !== 200) {
      fail(1, `公开 scratch doc 创建失败 ${pubDoc.status}: ${pubDoc.text}`);
    }
    const pubId = pubDoc.json.doc.id;
    const share = await ownerB.raw("POST", `/api/kb/docs/${pubId}/share`,
      { shareEnabled: true, shareRole: "editor", shareIncludeChildren: false });
    if (share.status !== 200 || !share.json?.share?.shareToken) {
      fail(1, `公开 editor 分享开启失败 ${share.status}: ${share.text}`);
    }
    const pubToken = share.json.share.shareToken;
    // 公开 PUT 强制 baseUpdatedAt 乐观锁；开分享会 bump updatedAt，故以开分享后的当前值为基准。
    const listing = await ownerB.raw("GET", `/api/kb/${kbId}/docs`);
    const pubBaseTs = (listing.json.docs || []).find((d) => d.id === pubId)?.updatedAt;
    if (!pubBaseTs) fail(1, "读不到公开 scratch doc 的 updatedAt（无法构造 baseUpdatedAt 乐观锁）");
    const pubPath = `/api/public/s/${pubToken}/doc/${pubId}/content`;

    // 整包 10MB < 12MiB body 档，过 bodyLimit，由 publicDoc saveContentSchema 10,000,000 上界裁决。
    const b1 = await putRaw(bUrl, pubPath, { content: "x".repeat(CONTENT_LIMIT), baseUpdatedAt: pubBaseTs });
    rec("B1 匿名公开 editor PUT 恰 10,000,000 字符 -> 200", b1.status === 200, { status: b1.status, code: b1.code });
    // 上界外：zod 10MB 校验失败即 400（不涉及乐观锁是否命中，绝不会 200/413）。
    const b2 = await putRaw(bUrl, pubPath, { content: "x".repeat(CONTENT_LIMIT + 1), baseUpdatedAt: pubBaseTs });
    rec("B2 匿名公开 editor PUT 10,000,001 字符 -> 400(zod,非413)", b2.status === 400, { status: b2.status, code: b2.code });

    // ---- B3/B4：owner 认证【内部】kb doc 写路径 10MB zod 上界（R6 硬要求） ----
    // 独立内部 scratch，整包 10MB < 12MiB 过 bodyLimit，由 docs.ts zod 10,000,000 上界裁决。
    const scratch = await ownerB.raw("POST", `/api/kb/${kbId}/docs`, { kind: "doc", title: "body-limit-10mb-scratch" });
    if (scratch.status !== 201 && scratch.status !== 200) {
      fail(1, `内部 scratch doc 创建失败 ${scratch.status}: ${scratch.text}`);
    }
    const scratchId = scratch.json.doc.id;
    const internalPath = `/api/kb/docs/${scratchId}/content`;
    const b3 = await putRaw(bUrl, internalPath, { content: "y".repeat(CONTENT_LIMIT) }, { token: tokenB });
    rec("B3 owner 内部 kb doc PUT 恰 10,000,000 字符 -> 200", b3.status === 200, { status: b3.status, code: b3.code });
    const b4 = await putRaw(bUrl, internalPath, { content: "y".repeat(CONTENT_LIMIT + 1) }, { token: tokenB });
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

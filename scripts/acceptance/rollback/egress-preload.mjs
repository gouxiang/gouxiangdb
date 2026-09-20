// scripts/acceptance/rollback/egress-preload.mjs
// R5 零外网证据：经 NODE_OPTIONS="--import <本文件>" 注入【真 dist 服务子进程】，在任何业务
// 模块求值前安装探针。纯 Node 内置模块、零新依赖；只计数不改变行为。
//
// 三层计数（embedding off 纯 FTS/LIKE 路径下三层都必须为 0）：
//   fetchCalls ：global fetch 调用次数（cloud provider 唯一出网手段，cloud.ts 用全局 fetch）。
//   netCalls  ：net.connect 原始 TCP 连接次数（兜住绕过 fetch 的直连 socket/SDK）。
//   dnsCalls   ：dns.resolve/lookup 对外域名解析次数。
// 本机健康探针（127.0.0.1/localhost/::1）走 loopback，计入 loopback 但不计 netOther/dnsExternal。
//
// 结果在进程退出时落 GX_EGRESS_OUT 指向的 JSON（若设置）；GX_EGRESS_VERBOSE=1 时同步打 stderr。

import net from "node:net";
import dns from "node:dns";
import fs from "node:fs";

const OUT_FILE = process.env.GX_EGRESS_OUT || "";
const VERBOSE = process.env.GX_EGRESS_VERBOSE === "1";

const counters = {
  fetchCalls: 0,
  netCalls: 0,
  netLoopback: 0,
  netOther: 0,
  dnsCalls: 0,
  dnsExternal: 0,
  fetchHosts: [],
  netHosts: [],
};

function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

function note(msg) {
  if (VERBOSE) {
    try { process.stderr.write(`[egress-preload] ${msg}\n`); } catch { /* ignore */ }
  }
}

// 1) global fetch：任何方向都计数（本机不会用 fetch 打健康探针，故非零即异常出网）。
const origFetch = globalThis.fetch;
if (typeof origFetch === "function") {
  globalThis.fetch = async (...args) => {
    const u = args[0];
    let host = String(u);
    try { host = new URL(typeof u === "string" ? u : u?.url ?? String(u)).host; } catch { /* 保留原串 */ }
    counters.fetchCalls += 1;
    counters.fetchHosts.push(host);
    note(`fetch #${counters.fetchCalls} -> ${host}`);
    return origFetch.apply(globalThis, args);
  };
}

// 2) 原始 TCP：区分 loopback / 其它。
const origConnect = net.connect;
net.connect = function patchedConnect(opts, ...rest) {
  counters.netCalls += 1;
  let host = "";
  if (typeof opts === "object" && opts !== null) host = opts.host ?? opts.path ?? "";
  else if (typeof opts === "number") host = rest[0] ?? "";
  counters.netHosts.push(String(host));
  if (isLoopbackHost(host)) counters.netLoopback += 1;
  else { counters.netOther += 1; note(`non-loopback net.connect -> ${host}`); }
  return origConnect.call(this, opts, ...rest);
};
// http/https Agent 与任何 TCP 客户端都经 net.connect 建连；loopback 之外的连接即为出网。

// 3) DNS：resolve 对外域即外部；lookup 按 host 判 loopback。
const origResolve = dns.resolve;
dns.resolve = function patchedResolve(hostname, ...rest) {
  counters.dnsCalls += 1;
  if (!isLoopbackHost(hostname)) { counters.dnsExternal += 1; note(`dns.resolve -> ${hostname}`); }
  return origResolve.call(this, hostname, ...rest);
};
const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  counters.dnsCalls += 1;
  if (!isLoopbackHost(hostname)) { counters.dnsExternal += 1; note(`dns.lookup -> ${hostname}`); }
  return origLookup.call(this, hostname, ...rest);
};

function flush() {
  if (!OUT_FILE) return;
  try { fs.writeFileSync(OUT_FILE, JSON.stringify(counters, null, 2)); } catch { /* best-effort */ }
}
process.on("exit", flush);
process.on("SIGTERM", () => { flush(); process.exit(0); });
process.on("SIGINT", () => { flush(); process.exit(0); });

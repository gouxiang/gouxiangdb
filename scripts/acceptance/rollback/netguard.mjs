// scripts/acceptance/rollback/netguard.mjs
// 门③ R5 零外网探针：经 NODE_OPTIONS="--import <本文件>" 注入【服务子进程】，
// 在任何业务代码执行前包装出网面，把每次出网尝试以 JSON 行追加到 GX_NETGUARD_LOG。
//
// 只用 Node 内置模块，零新依赖。拦截面（层层兜底，避免漏掉非 fetch 的出网）：
//   1) globalThis.fetch（cloud embedding provider 的唯一出网方式，cloud.ts 用全局 fetch）；
//   2) node:http / node:https 的 request/get（防止有代码走 http 直连）；
//   3) node:dns 的 lookup/resolve*（域名解析即出网意图，向量检索必解析外部域名）；
//   4) node:net Socket.prototype.connect（最底 TCP 出口，兜住一切裸 TCP）。
//
// 不拦截、只记账：不改变程序行为，因此不会把"本应失败的外网调用"假性变成绿。
// better-sqlite3 走原生文件句柄读本地 search.db，不经 net，天然不计数。

import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

const LOG = process.env.GX_NETGUARD_LOG;
function record(kind, target) {
  try {
    if (LOG) {
      fs.appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), kind, target: String(target).slice(0, 200) })}\n`);
    }
  } catch { /* 探针自身永不影响被测进程 */ }
}

function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

// 1) fetch
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    let url = "";
    try { url = typeof input === "string" ? input : input?.url ?? String(input); } catch { url = String(input); }
    record("fetch", url);
    return origFetch(input, init);
  };
}

// 2) http / https
function wrapRequest(mod, name) {
  const orig = mod.request.bind(mod);
  mod.request = (urlOrOpts, ...rest) => {
    try {
      const host = typeof urlOrOpts === "object" && urlOrOpts ? urlOrOpts.hostname || urlOrOpts.host : urlOrOpts;
      record(name, host);
    } catch { record(name, "?"); }
    return orig(urlOrOpts, ...rest);
  };
  const origGet = mod.get.bind(mod);
  mod.get = (urlOrOpts, ...rest) => {
    try {
      const host = typeof urlOrOpts === "object" && urlOrOpts ? urlOrOpts.hostname || urlOrOpts.host : urlOrOpts;
      record(`${name}.get`, host);
    } catch { record(`${name}.get`, "?"); }
    return origGet(urlOrOpts, ...rest);
  };
}
wrapRequest(http, "http");
wrapRequest(https, "https");

// 3) dns 解析
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns[fn] !== "function") continue;
  const orig = dns[fn].bind(dns);
  dns[fn] = (hostname, ...rest) => {
    // 内部回环解析是系统调用但非外网意图，仍记录并由检查脚本按 host 判内外。
    record(`dns.${fn}`, hostname);
    return orig(hostname, ...rest);
  };
}

// 4) TCP 底层出口（最强兜底）。
//    注意 net.connect / net.createConnection 是模块上的【静态工厂】，并不调用
//    Socket.prototype.connect（直接 new Socket 后 connect 除外），故三处都要包。
function hostPortOf(args) {
  // 形态：connect(port, host?) / connect(path) / connect(options)
  const a0 = args[0];
  if (typeof a0 === "object" && a0 !== null) {
    return { host: a0.host ?? a0.hostname ?? "(none)", port: a0.port, path: a0.path };
  }
  if (typeof a0 === "number") return { host: typeof args[1] === "string" ? args[1] : "(none)", port: a0 };
  if (typeof a0 === "string") return { host: "(unix)", port: undefined, path: a0 };
  return { host: "(none)", port: undefined };
}
function recordTcp(args) {
  const { host, port, path } = hostPortOf(args);
  if (path) return; // unix 域套接字不是网络出口
  if (port === undefined) return;
  if (!isLoopbackHost(host)) record("tcp.connect", `${host}:${port}`);
}

const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  try { recordTcp(args); } catch { /* ignore */ }
  return origSocketConnect.apply(this, args);
};

const origNetConnect = net.connect;
net.connect = function (...args) {
  try { recordTcp(args); } catch { /* ignore */ }
  return origNetConnect.apply(this, args);
};
if (typeof net.createConnection === "function") {
  const origCreate = net.createConnection;
  net.createConnection = function (...args) {
    try { recordTcp(args); } catch { /* ignore */ }
    return origCreate.apply(this, args);
  };
}

if (LOG) record("bootstrap", `netguard armed pid=${process.pid}`);

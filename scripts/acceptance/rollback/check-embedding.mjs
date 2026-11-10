// scripts/acceptance/rollback/check-embedding.mjs
// 门③ R5：embedding 回 off 后检索退化为纯 FTS5 trigram/短词 LIKE，结果可用，且【检索/嵌入面】零外网。
//
// 两个独立证据（缺一不可）：
//   A. 旧面 GET /api/search?q=zephyrmarker（始终挂载，runLegacyGlobalSearch 纯 FTS/LIKE，与
//      GX_M5_SEARCH/GX_EMBEDDING_MODE 无关）必须真实命中种子记录/文档。
//   B. 服务进程由 netguard.mjs 预加载包装了 fetch/http/https/dns/tcp 出网面；本检查读取
//      GX_NETGUARD_LOG 逐条分类，断言【禁止域】出网为零。
//
// 为什么不再是"全程零外网"（2026-11 授权通电后的精确化，见 b863f29）：
//   生产构建（GX_LICENSE_PROD=1，fpk/dmg）在 resolveLicenseMode 里把 license 下限抬到 verify
//   ——"授权成品永不 off"，因此进程启动即产生授权心跳出网（公网 IP 探测 /v1/my-ip + 心跳 443）。
//   这是设计内的【授权面】出网，与嵌入/检索无关。旧断言（7a80e18，写于授权通电前）按"全程零外网"
//   一刀切，会把授权心跳误判为红灯。本检查据此把事件分三桶：
//     - nonRoute  回环/监听绑定等非外部出网（127.x/::1/localhost/0.0.0.0/空）；
//     - license   授权中心白名单 host（对齐 configLicense.PROD_LICENSE_URL），允许但计数可见；
//     - forbidden 其它任何外部域 —— 必须为 0，嵌入 provider 或未知外联一旦出现即 FAIL（安全意图不削弱）。
//
// 选择旧面 /api/search 作为主探针的理由：它是 off 回滚后用户实际依赖的检索面，其实现零云依赖，
// 最直接证明"翻 off 后无需任何外部嵌入服务即可检索"。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

// 授权面出网白名单：host 必须与 apps/api/src/domain/license/configLicense.ts 的 PROD_LICENSE_URL 同源。
// 仅授权中心域名可入列；新增任何外联域都应走禁止域被抓，而不是悄悄加白。可用 --allow-host 追加（测试用）。
const LICENSE_HOST_ALLOWLIST = new Set([
  "gouxiang.hn.takin.cc",
]);

function hostOf(target) {
  return String(target ?? "").toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
}

// 回环或非路由地址：不是"外部出网意图"。0.0.0.0 来自 server.listen 绑定阶段的本地 getaddrinfo，
// 数字 IP 不产生真实 DNS 报文，netguard 仅记账，故与回环同桶。
function isNonRoutableHost(host) {
  return host === "" || host === "(none)"
    || host === "127.0.0.1" || host.startsWith("127.")
    || host === "::1" || host === "localhost"
    || host === "0.0.0.0";
}

function isLicenseHost(host, allow) {
  if (allow.has(host)) return true;
  // 允许授权中心的子域，但不允许形似后缀的陌生域（evil-gouxiang... 不等于 .gouxiang...）。
  for (const d of allow) {
    if (host.endsWith(`.${d}`)) return true;
  }
  return false;
}

// 纯函数：netguard 事件数组 -> 三桶分类。无 fs 副作用，供单测直接喂构造事件。
export function classifyEgressEvents(events, extraAllow = []) {
  const allow = new Set(LICENSE_HOST_ALLOWLIST);
  for (const h of extraAllow) {
    const v = hostOf(h);
    if (v) allow.add(v);
  }
  const license = [];
  const forbidden = [];
  let nonRoute = 0;
  let bootstrap = 0;
  for (const e of events) {
    if (e.kind === "bootstrap") { bootstrap += 1; continue; }
    const host = hostOf(e.target);
    if (isNonRoutableHost(host)) {
      nonRoute += 1;
    } else if (isLicenseHost(host, allow)) {
      license.push(e);
    } else {
      forbidden.push(e);
    }
  }
  return { total: events.length, nonRoute, bootstrap, license, forbidden, lines: events };
}

function classifyEgress(logFile, extraAllow) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { total: 0, nonRoute: 0, bootstrap: 0, license: [], forbidden: [], lines: [] };
  }
  const events = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { kind: "unparseable", target: l }; }
  });
  return classifyEgressEvents(events, extraAllow);
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "embedding:off");
  const base = ctx.baseUrl;
  const q = encodeURIComponent(ctx.marker);
  const extraAllow = args["allow-host"]
    ? String(args["allow-host"]).split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // 证据 A：旧面 FTS 命中（记录或文档至少一处含 marker）
  const r = await http(base, "GET", `/api/search?q=${q}`, { token: ctx.tokens.owner });
  expectStatus(r, 200, "R5 旧面 /api/search 200", hits);
  const recs = Array.isArray(r.json?.records) ? r.json.records : [];
  const docs = Array.isArray(r.json?.docs) ? r.json.docs : [];
  const hay = JSON.stringify(r.json ?? {});
  expectTrue(
    hay.toLowerCase().includes(ctx.marker),
    `R5 FTS 命中标记词 "${ctx.marker}"（records=${recs.length} docs=${docs.length}）`,
    hits,
  );

  // 证据 B：禁止域零外网（授权心跳白名单放行且可见；嵌入/未知外部域一票否决）
  const audit = classifyEgress(args["net-log"], extraAllow);
  expectTrue(
    audit.forbidden.length === 0,
    `R5 检索/嵌入面零外网（总事件 ${audit.total}，非路由 ${audit.nonRoute}，`
      + `授权白名单 ${audit.license.length}，禁止域 ${audit.forbidden.length}）`,
    hits,
    audit.forbidden.slice(0, 3).map((e) => `${e.kind}:${e.target}`).join("; "),
  );

  // 把审计快照落盘，供报告引用
  if (args["audit-out"]) {
    fs.writeFileSync(args["audit-out"], JSON.stringify({
      total: audit.total,
      nonRoute: audit.nonRoute,
      bootstrap: audit.bootstrap,
      licenseEgress: audit.license,
      forbidden: audit.forbidden,
      allowHosts: [...LICENSE_HOST_ALLOWLIST, ...extraAllow],
    }, null, 2));
  }
  return hits.n;
}

// 仅作为 CLI 直接运行时才执行探针；被 import 做纯函数单测时不自动跑 main。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCheck("check-embedding", main);
}

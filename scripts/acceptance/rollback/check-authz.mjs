// scripts/acceptance/rollback/check-authz.mjs
// R3：引擎永久单一化后的不变量——即使显式传 GX_AUTHZ_ENGINE=off（旧开关），该变量也被完全忽略，
// 七守卫仍恒定由引擎（nav auth_policies）裁决。开关/三态/READY 门已物理删除，无旧引擎可回。
//
// 必须真起服务经 HTTP 打，不许只跑 vitest：本探针读一个受 requireCanView 守卫保护的旧面
// 端点 GET /api/records?tableId=（records.ts -> requireCanView -> 引擎）。
// 三身份对照：
//   owner    （超管/创建者，引擎兜底放行）            -> 200
//   member   （scope 授权进库 + 表/库门投影）          -> 200
//   outsider （有效 ACTIVE 账号，引擎无任何来源）      -> 403 引擎拒绝
// 关键：outsider 持的是【合法有效 token】，403 来自引擎授权而非认证（401）。
//
// 另核对服务启动日志【不含】 [authz] ... configured/effective 旧块（该启动日志已删除）。

import fs from "node:fs";
import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "authz:permanent");
  const base = ctx.baseUrl;
  const url = `/api/records?tableId=${encodeURIComponent(ctx.tableId)}&limit=5`;

  // owner 200（引擎超管/创建者兜底）
  const owner = await http(base, "GET", url, { token: ctx.tokens.owner });
  expectStatus(owner, 200, "R3 owner 经引擎裁决可读", hits);
  expectTrue(Array.isArray(owner.json?.records), "R3 owner 响应是 records 列表形状", hits);

  // 已授权 member 200（引擎库门 enter + scope 投影）
  const member = await http(base, "GET", url, { token: ctx.tokens.member });
  expectStatus(member, 200, "R3 授权 member 经引擎裁决可读", hits);

  // 未授权但有效 ACTIVE 的局外人 403（不是 401），证明决策来自引擎拒绝而非未登录
  const outsider = await http(base, "GET", url, { token: ctx.tokens.outsider });
  expectStatus(outsider, 403, "R3 局外人被引擎拒绝 403", hits);
  expectTrue(
    /无权|FORBIDDEN|权限/i.test(outsider.text),
    "R3 403 响应体为权限语义（非认证失败）",
    hits,
    outsider.text.slice(0, 120),
  );

  // 写面：member（viewer 档）对数据写应被引擎拒绝（无 edit_data）-> 403。
  const write = await http(
    base,
    "POST",
    `/api/records?tableId=${encodeURIComponent(ctx.tableId)}`,
    { token: ctx.tokens.member, body: { fields: { [ctx.primaryFieldId]: "viewer 越权写" } } },
  );
  expectStatus(write, 403, "R3 viewer 写被引擎拒绝 403", hits);

  // 启动日志证据：不含旧 [authz] configured/effective 块（开关删除后启动日志不再打印此行）。
  if (args["log-evidence"] && fs.existsSync(args["log-evidence"])) {
    const log = fs.readFileSync(args["log-evidence"], "utf8");
    const hasOldBlock = log.split("\n")
      .some((l) => l.includes("[authz]") && (l.includes("configured=") || l.includes("effective=")));
    expectTrue(!hasOldBlock, "R3 启动日志不含旧 [authz] configured/effective 块", hits, "");
  }

  return hits.n;
}

runCheck("check-authz", main);

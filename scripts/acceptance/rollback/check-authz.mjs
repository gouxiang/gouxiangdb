// scripts/acceptance/rollback/check-authz.mjs
// 门③ R3：GX_AUTHZ_ENGINE 从 shadow 翻回 off 后，七守卫完全走旧 members/kb_members/kb_doc_acls
// 三表决策（configAuthz.ts: off 时 authzShadowActive=false 短路，零新增 SQL）。
//
// 必须真起服务经 HTTP 打，不许只跑 vitest：本探针读一个受 requireCanView 守卫保护的旧面
// 端点 GET /api/records?tableId=（records.ts:68 -> requireCanView -> guards.ts roleOf 三表）。
// 三身份对照：
//   owner    （base 所有者，members.role=owner 行，经 signup 自举） -> 200
//   member   （seed 阶段 POST /bases/:id/members 授权为 viewer）   -> 200
//   outsider （有效 ACTIVE 账号，但不在该 base members）            -> 403 旧守卫拒绝
// 关键：outsider 持的是【合法有效 token】，403 来自授权而非认证（401），这才证明走的是守卫。
//
// 另核对服务启动日志确含 [authz] ... effective=off（由驱动 grep server log 传 --log-evidence）。

import fs from "node:fs";
import { parseArgs, loadContext, http, HitCounter, expectStatus, expectTrue, runCheck } from "./probe.mjs";

async function main() {
  const args = parseArgs(process.argv);
  const ctx = loadContext(args.context);
  const hits = new HitCounter(args["hit-file"], "authz:off");
  const base = ctx.baseUrl;
  const url = `/api/records?tableId=${encodeURIComponent(ctx.tableId)}&limit=5`;

  // owner 200
  const owner = await http(base, "GET", url, { token: ctx.tokens.owner });
  expectStatus(owner, 200, "R3 owner 经旧 members 守卫可读", hits);
  expectTrue(Array.isArray(owner.json?.records), "R3 owner 响应是旧 records 列表形状", hits);

  // 已授权 viewer 200（旧 members 表 viewer 行；off 态无策略引擎）
  const member = await http(base, "GET", url, { token: ctx.tokens.member });
  expectStatus(member, 200, "R3 授权 viewer 经旧 members 守卫可读", hits);

  // 未授权但有效 ACTIVE 的局外人 403（不是 401），证明决策来自旧守卫拒绝而非未登录
  const outsider = await http(base, "GET", url, { token: ctx.tokens.outsider });
  expectStatus(outsider, 403, "R3 局外人被旧 members 守卫拒绝 403", hits);
  expectTrue(
    /无权|FORBIDDEN|权限/i.test(outsider.text),
    "R3 403 响应体为权限语义（非认证失败）",
    hits,
    outsider.text.slice(0, 120),
  );

  // 写面：viewer 对数据写应被旧权限集拒绝（viewer 无 canEditData）-> 403。
  const write = await http(
    base,
    "POST",
    `/api/records?tableId=${encodeURIComponent(ctx.tableId)}`,
    { token: ctx.tokens.member, body: { fields: { [ctx.primaryFieldId]: "viewer 越权写" } } },
  );
  expectStatus(write, 403, "R3 viewer 写被旧权限集拒绝 403", hits);

  // 启动日志证据：effective=off（证明翻旗真的作用到了正在被测的进程，而不是打在旧 shadow 进程）。
  if (args["log-evidence"] && fs.existsSync(args["log-evidence"])) {
    const log = fs.readFileSync(args["log-evidence"], "utf8");
    const line = log.split("\n").find((l) => l.includes("[authz]") && l.includes("effective=off"));
    expectTrue(Boolean(line), "R3 服务启动日志含 [authz] effective=off", hits, "");
  }

  return hits.n;
}

runCheck("check-authz", main);

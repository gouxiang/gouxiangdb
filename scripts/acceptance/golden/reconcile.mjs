// scripts/acceptance/golden/reconcile.mjs
// D 段：auth_policies 回填对账幂等（必须在任何新策略构造之前跑，保证对账面=纯迁移投影）。
// 只读：exit 0 且 summary A/B/C=0；--apply：exit 0、打印 no changes、fix 全 0。

import path from "node:path";
import { spawn } from "node:child_process";
import { parseJsonHead } from "../lib/jsonHead.mjs";

function runTsx(apiDir, args, env) {
  const tsx = path.join(apiDir, "node_modules/tsx/dist/cli.mjs");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsx, ...args], { cwd: apiDir, env: { ...process.env, ...env } });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

export async function runReconcileIdempotency(apiDir, dbFile) {
  const dbEnv = { DATABASE_URL: `file:${dbFile}` };

  const ro = await runTsx(apiDir, ["scripts/authz/reconcile-policies.ts", "--json"], dbEnv);
  // 只读 --json 直接打印 reconcile 报告对象本身（含 summary/A/B/C）。
  const parsed = parseJsonHead(ro.out);
  const roSummary = parsed?.summary ?? parsed?.before?.summary ?? null;
  const readOnlyPass = ro.code === 0 && roSummary !== null && roSummary.A === 0 && roSummary.B === 0 && roSummary.C === 0;

  const applied = await runTsx(apiDir, ["scripts/authz/reconcile-policies.ts", "--apply", "--json"], dbEnv);
  // --apply --json 打印 {before,fix,after} 后追加 "no changes"，必须用 JSON-head 解析才能真正读到 fix。
  const aParsed = parseJsonHead(applied.out);
  const fix = aParsed?.fix ?? null;
  const noChanges = applied.code === 0 && /no changes/.test(applied.out)
    && fix !== null
    && (fix.created ?? -1) === 0 && (fix.updated ?? -1) === 0 && (fix.deleted ?? -1) === 0;

  return {
    readOnly: { exit: ro.code, summary: roSummary, pass: readOnlyPass },
    apply: { exit: applied.code, noChanges, fix, pass: noChanges },
  };
}

// apps/api/scripts/smoke-dist.mjs 自测（真 spawn、真临时库、真临时端口；绝不改真 dist 产物）。
//
// 为什么全用子进程驱动、不 import 那些 .mjs：apps/api/tsconfig.json 未开 allowJs，
// 从 .ts 里 import .mjs 会让 tsc --noEmit 报 TS7016，等于把门禁自己搞红。
//
// 覆盖（对应「构建后真跑产物」这道门的四项验收）：
//  ① 静态扫描函数：含 esbuild 动态 require 特征串的产物 -> 判失败，并报出文件 + 行号；
//     四个干净产物 -> 判通过。
//  ② 主门·健康产物：对当前真实 dist 跑 `node scripts/smoke-dist.mjs` -> 退出 0。
//  ③ 主门·坏产物：在临时 api 根里放一个「启动即抛错」的假 index.js（不动真产物），
//     主门必须非 0 退出，且把子进程的完整栈打印出来（这次事故唯一的定位依据）。
//  ④ 隔离铁律：跑完临时目录被清干净（不留临时库/临时数据目录）。

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 删临时目录。为什么不直接 fs.rmSync：受管 dev shell 经 NODE_OPTIONS 注入 node-safe-delete-shim，
 * 会把「递归删临时目录」劫持成需人工确认并抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED（scripts/ci-quality.sh
 * 用的是同一个开关 CODEBUDDY_SAFE_DELETE_ENABLED=0）。该 shim 在进程启动时读 env，测试进程内再置已无效，
 * 故另起一个禁用了 shim 的 node 子进程来删——真实 CI/裸机/Docker 不注入 shim，此路径同样成立。
 */
function forceRemove(dir: string): void {
  const r = spawnSync(
    process.execPath,
    ["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", dir],
    { env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: "0" }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`清理临时目录失败 ${dir}：${r.stderr ?? r.stdout ?? ""}`);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const API_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(API_ROOT, "scripts", "smoke-dist.mjs");
const SCAN_MODULE = path.join(API_ROOT, "scripts", "smoke", "scan-dynamic-require.mjs");
const REAL_DIST_ENTRY = path.join(API_ROOT, "dist", "index.js");

/** 进程自带 30s 预算 + 迁移开销，单测预算放宽；挂死由显式 timeout 证明，不由预算掩盖。 */
const RUN_TIMEOUT_MS = 120_000;
const ARTIFACTS = ["index.js", "init-admin.js", "nav-reconcile.js", "mcp-stdio.js"];

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

function runNode(script: string, args: string[] = [], cwd = API_ROOT): RunResult {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: "0" },
  });
  if (r.error) throw r.error;
  return {
    status: r.status,
    signal: r.signal,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个 dist 目录：marker 为空即四个干净产物。 */
function writeDist(dir: string, marker = ""): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ARTIFACTS) {
    const body = marker
      ? [`// fixture`, `const line2 = 1;`, `throw new Error(${JSON.stringify(marker)});`]
      : [`// clean artifact`, `export const ok = true;`];
    fs.writeFileSync(path.join(dir, name), `${body.join("\n")}\n`);
  }
}

// ---------------------------------------------------------------------------
// ① 静态扫描函数（纯函数，经一次性 driver 子进程调用，避开 .ts import .mjs）
// ---------------------------------------------------------------------------
describe("静态扫描：esbuild 动态 require 特征串", () => {
  const tmp = mkTmp("gx-smoke-scan-");
  afterAll(() => forceRemove(tmp));

  it("含特征串的产物被判失败，并报出文件与行号", () => {
    const dist = path.join(tmp, "dirty");
    writeDist(dist, 'Dynamic require of "events" is not supported');
    const driver = path.join(tmp, "scan-dirty.mjs");
    fs.writeFileSync(
      driver,
      `import { scanDynamicRequire, formatHits } from ${JSON.stringify(SCAN_MODULE)};\n`
      + `const r = scanDynamicRequire(${JSON.stringify(dist)});\n`
      + `console.log(JSON.stringify({ failures: r.failures, text: formatHits(r.failures, ${JSON.stringify(dist)}) }));\n`,
    );
    const run = runNode(driver);

    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.out.trim()) as {
      failures: Array<{ file: string; line: number; context: string }>;
      text: string;
    };
    // 四个产物各命中一处（每个产物只报第一处）。
    expect(parsed.failures).toHaveLength(ARTIFACTS.length);
    const hit = parsed.failures.find((f) => f.file === "index.js");
    expect(hit).toBeDefined();
    // 特征串写在第 3 行：行号必须指到真出问题的那一行，而不是笼统报"文件有问题"。
    expect(hit?.line).toBe(3);
    expect(hit?.context).toContain("Dynamic require of");
    expect(parsed.text).toContain("index.js:3");
  });

  it("四个干净产物判通过（零命中）", () => {
    const dist = path.join(tmp, "clean");
    writeDist(dist);
    const driver = path.join(tmp, "scan-clean.mjs");
    fs.writeFileSync(
      driver,
      `import { scanDynamicRequire } from ${JSON.stringify(SCAN_MODULE)};\n`
      + `const r = scanDynamicRequire(${JSON.stringify(dist)});\n`
      + `console.log(JSON.stringify({ failures: r.failures, warnings: r.warnings }));\n`,
    );
    const run = runNode(driver);

    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.out.trim()) as {
      failures: unknown[];
      warnings: unknown[];
    };
    expect(parsed.failures).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ② 主门·健康产物（真产物必须绿）
// ---------------------------------------------------------------------------
describe("主门：真跑 dist/index.js", () => {
  it("当前真实产物上退出 0", () => {
    // 前置：产物得先存在（CI 第 5 步构建先于测试；本机 `pnpm build` 即可）。
    expect(fs.existsSync(REAL_DIST_ENTRY)).toBe(true);
    const run = runNode(SCRIPT);
    expect(run.status).toBe(0);
    expect(run.out).toContain("静态扫描通过");
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// ③ 主门·坏产物：启动即崩必须非 0 退出 + 打印完整栈
// ---------------------------------------------------------------------------
describe("主门：坏产物必须红且吐栈", () => {
  // 假 api 根必须落在 apps/api 之下：scripts/smoke/run-index.mjs 用 createRequire 从自身位置
  // 向上解析 prisma CLI，只有 apps/api 的子目录才能解析到 apps/api/node_modules。
  const fixtureRoot = fs.mkdtempSync(path.join(API_ROOT, ".smoke-fixture-"));
  afterAll(() => forceRemove(fixtureRoot));

  it("一启动就抛错的假 index.js：非 0 退出且打印完整栈", () => {
    const BOOM = "SMOKE_FIXTURE_BOOM_SENTINEL";
    fs.mkdirSync(path.join(fixtureRoot, "scripts", "smoke"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(fixtureRoot, "scripts", "smoke-dist.mjs"));
    for (const f of fs.readdirSync(path.join(API_ROOT, "scripts", "smoke"))) {
      fs.copyFileSync(
        path.join(API_ROOT, "scripts", "smoke", f),
        path.join(fixtureRoot, "scripts", "smoke", f),
      );
    }
    // 真产物的三个 CLI 兄弟产物不参与执行，写空壳只为让静态扫描有完整四份。
    writeDist(path.join(fixtureRoot, "dist"));
    fs.writeFileSync(
      path.join(fixtureRoot, "dist", "index.js"),
      `throw new Error(${JSON.stringify(BOOM)});\n`,
    );
    // migrate deploy 需要 schema + 迁移目录（与真产物同口径）。
    fs.mkdirSync(path.join(fixtureRoot, "prisma"), { recursive: true });
    fs.copyFileSync(
      path.join(API_ROOT, "prisma", "schema.prisma"),
      path.join(fixtureRoot, "prisma", "schema.prisma"),
    );
    fs.cpSync(
      path.join(API_ROOT, "prisma", "migrations"),
      path.join(fixtureRoot, "prisma", "migrations"),
      { recursive: true },
    );

    const run = runNode(path.join(fixtureRoot, "scripts", "smoke-dist.mjs"));

    expect(run.status).not.toBe(0);
    // 失败必须回吐子进程完整栈：只报"启动失败"等于把这次事故的唯一线索掐掉。
    expect(run.out).toContain(BOOM);
    expect(run.out).toMatch(/at .*index\.js:\d+/);
  }, RUN_TIMEOUT_MS);
});

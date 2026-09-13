#!/usr/bin/env node
// apps/api/scripts/bench/run-gate.ts
// M1/S9 可配并发压测 harness 主入口。
//   gen-data 库 → 预置场景视图到【模板副本】→ 复制出独立 read.db / write.db（写不污染读计时）
//   → read.db 起生产 dist 服务跑读场景（含深翻窗口边缘 400）→ write.db 起服务跑写/混合场景
//   → 停机离线对拍 write.db sidecar drift=0 → 汇总 P50/P95/P99/QPS/失败/超时/物理SQL/ORM/RSS
//   与 shadow drift 到 artifacts/bench 的 JSON+MD。50 预热丢弃 + ≥200 采样。
//
// 用法：
//   pnpm tsx scripts/bench/run-gate.ts --manifest /abs/x.manifest.json \
//     --mode off|shadow|on [--concurrency 8] [--warmup 50] [--samples 200] [--limit 100] \
//     [--read-p95-ms 1500] [--max-failure-rate 0.01] [--tag <name>] [--out-dir <dir>] \
//     [--keep-db] [--skip-build] [--host "local:Apple M?/16G"]
// 退出码：0=PASS；2=门未过（有失败/超时/drift≠0/shadow drift）；1=运行错误。
// 铁律：写场景真实建 records，必须指向 gen-data 专用库副本，严禁打生产库。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startServer, type ServerFlags, type ServerHandle } from "./server.js";
import { runScene, type GateMode } from "./load.js";
import { judge, writeReports, type GateConfig } from "./report.js";
import { countSidecarDrift } from "./drift.js";
import { prepareScenesFile } from "./prep-scenes.js";
import type { ResolvedScene } from "./prep-scenes.js";

interface ScenesFile {
  dbFile: string;
  rows: number;
  shape: string;
  seed: number;
  ownerEmail: string;
  ownerPassword: string;
  mainTableId: string;
  pageLimit: number;
  scenes: ResolvedScene[];
  fieldIds: Record<string, { id: string; name: string; type: string }>;
}

interface Cli { [k: string]: string; }

function parseCli(): Cli {
  const out: Cli = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    // 裸布尔 flag（--skip-build / --keep-db）：下一个 token 缺失或本身是 flag 时记 "true"，
    // 绝不把后续 flag 名吞成它的值。
    if (next === undefined || next.startsWith("--")) {
      out[a.slice(2)] = "true";
    } else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

function scaleLabel(rows: number): string {
  if (rows >= 1_000_000) return "1m";
  if (rows >= 500_000) return "500k";
  if (rows >= 100_000) return "100k";
  if (rows >= 10_000) return "10k";
  return `${rows}`;
}

function copyDb(src: string, dst: string): void {
  // 只清理目标侧残留；源库 gen-data/prep-scenes 末尾已 wal_checkpoint(TRUNCATE)。
  for (const ext of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dst + ext)) fs.rmSync(dst + ext);
  }
  fs.copyFileSync(src, dst);
  // 关键固化：源库处于 WAL 模式（header writeVer=2）。裸 cp 出的副本在被生产进程以
  // Prisma 写连接 + rawRead/sidecar 两只只读连接【并发打开】时，Prisma 首次查询会报
  // SQLite 522 disk I/O error（readyz 的单连接探针却 200，极隐蔽）。复制后立刻用
  // better-sqlite3 强制 checkpoint 并切回 DELETE 模式：把全部页落进主文件、删除 -wal/-shm，
  // 得到自洽单文件；之后被测服务再自行切 WAL 是在干净基础上，三连接并发不再 522。
  const fix = new Database(dst);
  try {
    fix.pragma("wal_checkpoint(TRUNCATE)");
    fix.pragma("journal_mode = DELETE");
  } finally {
    fix.close();
  }
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dst + ext, { force: true });
}

/** 统计服务日志里 shadow/keyset-shadow 差异行数（去重样例）。 */
function readShadowWarnings(logFile: string): { count: number; samples: string[] } {
  if (!fs.existsSync(logFile)) return { count: 0, samples: [] };
  const lines = fs.readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.includes("[queryPlan][shadow]") || l.includes("[queryPlan][keyset-shadow]"))
    .filter((l) => l.includes("差异"));
  return { count: lines.length, samples: [...new Set(lines)].slice(0, 10) };
}

async function main(): Promise<number> {
  const cli = parseCli();
  const manifestPath = cli.manifest;
  if (!manifestPath) throw new Error("必须提供 --manifest /path/x.manifest.json（gen-data 产物）");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ScenesFile & { dbFile: string };

  const mode = (cli.mode ?? "on") as GateMode;
  if (!["off", "shadow", "on"].includes(mode)) throw new Error("--mode 必须是 off|shadow|on");
  // 便捷语义：--mode 一键切两档。读轮 read/keyset 同档；写轮固定 on/on（写队列常开、sidecar 维护）。
  const flags: ServerFlags = {
    read: (cli.read ?? mode) as ServerFlags["read"],
    keyset: (cli.keyset ?? mode) as ServerFlags["keyset"],
    prefetch: (cli.prefetch ?? "on") as ServerFlags["prefetch"],
  };
  const concurrency = Number(cli.concurrency ?? "8");
  const warmup = Number(cli.warmup ?? "50");
  const samples = Number(cli.samples ?? "200");
  const pages = Number(cli.pages ?? "0");
  const limit = Number(cli.limit ?? String(manifest.pageLimit ?? 100));
  const timeoutMs = Number(cli.timeout ?? "30000");
  const gate: GateConfig = {
    readP95Ms: Number(cli["read-p95-ms"] ?? "1500"),
    maxFailureRate: Number(cli["max-failure-rate"] ?? "0.01"),
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const apiRoot = path.resolve(here, "..", "..");
  const repoRoot = path.resolve(apiRoot, "..", "..");
  const tag = cli.tag ?? `${scaleLabel(manifest.rows)}-r${flags.read}-k${flags.keyset}`;
  const outDir = cli["out-dir"] ?? path.join(repoRoot, "artifacts", "bench");
  const host = cli.host ?? `local:${os.cpus()[0]?.model ?? "unknown"}/${Math.round(os.totalmem() / 1024 / 1024 / 1024)}G/${process.platform}`;
  fs.mkdirSync(outDir, { recursive: true });

  // 隔离工作目录：母库 → 模板（预置视图）→ read.db / write.db 两份干净副本。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-gate-"));
  const template = path.join(workDir, "template.db");
  copyDb(manifest.dbFile, template);
  const tplManifest = path.join(workDir, "template.manifest.json");
  fs.writeFileSync(tplManifest, JSON.stringify({ ...manifest, dbFile: template }, null, 2));
  const scenesPath = path.join(workDir, "scenes.json");
  prepareScenesFile(tplManifest, scenesPath, limit, pages);
  const sf = JSON.parse(fs.readFileSync(scenesPath, "utf8")) as ScenesFile;

  const readDb = path.join(workDir, "read.db");
  const writeDb = path.join(workDir, "write.db");
  copyDb(template, readDb);
  copyDb(template, writeDb);

  const titleFieldId = sf.fieldIds?.title?.id ?? "";
  if (!titleFieldId) throw new Error("scenes.json 缺 fieldIds.title");
  // 可选场景白名单（逗号分隔）；不传跑完整矩阵（S9 默认）。S10 证伪门只测物理索引命中场景时
  // 用它裁掉随行数线性劣化的 T3 宽口径（文本排序/分组/搜索/残余 OR），使 50 万档可在本机完成；
  // T3 仍可在全量小样本中单独留证（其不算 ADR-0008 触发项，见 plan §S10/SPEC AC-M1-1）。
  const sceneFilter = cli.scenes
    ? new Set(cli.scenes.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const keepScene = (name: string): boolean => sceneFilter === null || sceneFilter.has(name);
  const readScenes = sf.scenes.filter((s) => s.kind !== "write" && s.kind !== "mixed" && keepScene(s.name));
  const writeScenes = sf.scenes.filter((s) => (s.kind === "write" || s.kind === "mixed") && keepScene(s.name));

  console.log(`[run-gate] ${sf.rows} 行 ${sf.shape} mode=${mode}(read=${flags.read},keyset=${flags.keyset}) C=${concurrency} 场景=${sf.scenes.length}`);

  // on 档深页游标准备：用只读连接在覆盖索引上一次性定位 home_deep 边界行，避免 load.ts 逐
  // HTTP 翻到 cursorPage（10 万行 80% 页=800 次当页 hydrate，数千秒）。游标格式与
  // queryPlan/cursor.ts encodeCursor 严格一致（base64url JSON{v:1,c,id}）。仅无过滤 T1 首页
  // 深页需要；带 viewId 的场景无 cursorPage（矩阵里只有 home_deep）。
  const deepScene = readScenes.find((s) => s.cursorPage && s.cursorPage > 1);
  let deepCursor: string | null = null;
  if (mode === "on" && deepScene) {
    const boundaryOffset = (deepScene.cursorPage! - 1) * limit - 1;
    const ro = new Database(readDb, { readonly: true });
    try {
      const row = ro
        .prepare(
          `SELECT "id" AS id, "createdAt" AS c FROM records ` +
          `WHERE "tableId"=? AND "deletedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC LIMIT 1 OFFSET ?`,
        )
        .get(sf.mainTableId, boundaryOffset) as { id: string; c: number } | undefined;
      if (row) {
        deepCursor = Buffer.from(JSON.stringify({ v: 1, c: row.c, id: row.id }), "utf8").toString("base64url");
      }
    } finally {
      ro.close();
    }
  }

  // ---- 读轮（read.db）----
  const readLog = path.join(outDir, `${tag}.read.server.log`);
  const readServer = await startServer({
    apiRoot, dbFile: readDb, email: sf.ownerEmail, password: sf.ownerPassword,
    flags, logFile: readLog, skipBuild: cli["skip-build"] === "true",
  });
  const results = [];
  try {
    for (const scene of readScenes) {
      const r = await runScene(scene, {
        baseUrl: readServer.baseUrl, token: readServer.token, tableId: sf.mainTableId,
        titleFieldId, limit, warmup, samples, concurrency, mode, timeoutMs,
        deepCursor: scene === deepScene ? deepCursor : null,
      });
      logLine(r);
      results.push(r);
    }
  } finally {
    readServer.stop();
  }
  const shadow = readShadowWarnings(readLog);

  // ---- 写轮 + 混合（write.db；读档固定 on，保证 sidecar 维护与当页 hydrate）----
  const writeLog = path.join(outDir, `${tag}.write.server.log`);
  const writeServer: ServerHandle = await startServer({
    apiRoot, dbFile: writeDb, email: sf.ownerEmail, password: sf.ownerPassword,
    flags: { read: "on", keyset: "on", prefetch: flags.prefetch }, logFile: writeLog, skipBuild: true,
  });
  try {
    for (const scene of writeScenes) {
      const r = await runScene(scene, {
        baseUrl: writeServer.baseUrl, token: writeServer.token, tableId: sf.mainTableId,
        titleFieldId, limit, warmup, samples: scene.kind === "mixed" ? samples : Math.min(samples, 200),
        concurrency, mode: "on", timeoutMs,
      });
      logLine(r);
      results.push(r);
    }
  } finally {
    writeServer.stop();
  }
  // WAL 落盘后离线对拍（服务已停，无竞争）。
  let sidecarDrift;
  {
    const wdb = new Database(writeDb, { timeout: 60000 });
    wdb.pragma("wal_checkpoint(TRUNCATE)");
    sidecarDrift = countSidecarDrift(wdb);
    wdb.close();
    console.log(`[run-gate] 写后 sidecar drift=`, sidecarDrift);
  }

  // 门判定：读 P95/失败率/超时 + 写后 sidecar drift；shadow 档额外要求双跑零差异。
  const verdict0 = judge(results, gate, sidecarDrift);
  if (mode === "shadow" && shadow.count > 0) {
    verdict0.pass = false;
    verdict0.breaches.push(`shadow drift 差异 ${shadow.count} 行（见 .read.server.log 与报告样例）`);
  }
  const now = new Date();
  const written = writeReports(outDir, tag, {
    generatedAt: now.toISOString(), dbFile: sf.dbFile, rows: sf.rows, shape: sf.shape, seed: sf.seed,
    scale: scaleLabel(sf.rows),
    flags: { read: flags.read, keyset: flags.keyset, prefetch: flags.prefetch },
    warmup, samples, concurrency, limit, host, node: process.version,
    shadowDrift: shadow, timeoutMs, sidecarDrift,
  }, results, verdict0);

  console.log(`[run-gate] 裁决 ${verdict0.pass ? "PASS" : "FAIL"} → ${written.mdPath}`);
  if (!verdict0.pass) for (const b of verdict0.breaches) console.log(`  超标：${b}`);
  if (shadow.count > 0) shadow.samples.forEach((s) => console.log(`  shadow: ${s}`));
  if (cli["keep-db"] === "true") console.log(`[run-gate] 工作库保留：${workDir}`);
  else fs.rmSync(workDir, { recursive: true, force: true });
  return verdict0.pass ? 0 : 2;
}

function logLine(r: { scene: string; kind: string; stats: { samples: number; failureRate: number; qps: number; serve: { p95: number }; physicalSqlAvg: number; prismaCallsAvg: number; timeouts: number } }): void {
  const s = r.stats;
  console.log(
    `  ${r.scene.padEnd(24)} ${r.kind.padEnd(6)} n=${s.samples} 失败=${(s.failureRate * 100).toFixed(1)}% ` +
    `超时=${s.timeouts} QPS=${s.qps.toFixed(1)} serveP95=${s.serve.p95.toFixed(2)}ms ` +
    `phys=${s.physicalSqlAvg.toFixed(1)} prisma=${s.prismaCallsAvg.toFixed(1)}`,
  );
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[run-gate] 运行错误：", e);
    process.exit(1);
  });

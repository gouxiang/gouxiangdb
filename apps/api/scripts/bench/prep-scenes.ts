// apps/api/scripts/bench/prep-scenes.ts
// M1/S9 压测前置：把场景矩阵中 kind=view 的配置预置成真实 grid view（与前端"先保存视图
// 再查询"一致），输出 resolved 场景 JSON（含 viewId）供 run-gate 直接请求。
//
// 为什么要预置 view：GET /api/records 的 filter/sort/aggregation/group 全部来自 view config
// （查询参数只有 tableId/viewId/limit/offset/search/cursor）。直插 views 表避免压测过程中
// 反复写配置，且确定性可复现。view id 用确定性 seqId，同 seed 一致。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { resetIds, seqId } from "./gen/prng.js";
import { buildSceneDefs, type FieldCatalog, type SceneDef } from "./scenarios.js";

export interface ManifestShape {
  dbFile: string;
  rows: number;
  shape: string;
  seed: number;
  ownerEmail: string;
  ownerPassword: string;
  tableReports: Array<{
    mainTableId: string;
    viewId: string;
    fieldIds: FieldCatalog;
    peerFieldIds: FieldCatalog;
  }>;
}

export interface ResolvedScene extends SceneDef {
  /** kind=view 时预置出的视图 id；其它 kind 为 null。 */
  resolvedViewId: string | null;
}

/** 解析 manifest 路径参数。 */
function arg(flag: string, def = ""): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

/** 预置场景视图并写 scenes.json；供 CLI 与 run-gate 进程内复用（免再起 tsx 子进程）。 */
export function prepareScenesFile(
  manifestPath: string,
  outPath: string,
  pageLimit = 100,
  pagesOverride = 0,
): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManifestShape;
  const t0 = manifest.tableReports[0]!;
  const fieldIds = t0.fieldIds;

  const defs = buildSceneDefs(fieldIds, manifest.rows, pageLimit)
    // pagesOverride 仅覆盖 home_deep 的落点页；deep_window_edge 不受影响（按窗口算）。
    .map((d) => (d.name === "home_deep" && pagesOverride > 0 ? { ...d, cursorPage: pagesOverride } : d));

  const dbFile = manifest.dbFile;
  if (!path.isAbsolute(dbFile)) throw new Error("manifest.dbFile 必须是绝对路径");
  const db = new Database(dbFile, { timeout: 60_000 });
  const BASE_MS = Date.parse("2026-02-01T00:00:00.000Z");

  // view id 确定性：复位到高起始段，避免与生成期 view（Bench Grid，seq 早期）撞号。
  resetIds(9_000_000);
  const insView = db.prepare(
    `INSERT INTO views (id,"tableId",name,type,"lockMode","order",config,"createdAt")
     VALUES (?,?,?,?,?,?,?,?)`,
  );

  let order = 100; // Bench Grid 占 order 0
  const resolved: ResolvedScene[] = defs.map((s) => {
    if (s.kind !== "view") return { ...s, resolvedViewId: null };
    const viewId = seqId("view_scn");
    const config = {
      hiddenFieldIds: [], fieldOrder: [], rowHeight: "medium",
      filters: null, sorts: [], search: "", groupByFieldId: null,
      collapsedGroupKeys: [], aggregations: {}, rowColor: { mode: "none", conditions: [] },
      coverFieldId: null, cardFieldIds: [], kanbanFieldId: null, dateFieldId: null,
      formFields: [], formTitle: "", formDescription: "",
      detailFieldIds: [], detailLayout: null,
      ...s.config,
    };
    insView.run(viewId, t0.mainTableId, `Bench: ${s.name}`, "grid", "collaborative", order++, JSON.stringify(config), BASE_MS);
    return { ...s, resolvedViewId: viewId };
  });

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  const payload = {
    version: 1,
    manifest: manifestPath,
    dbFile,
    rows: manifest.rows,
    shape: manifest.shape,
    seed: manifest.seed,
    ownerEmail: manifest.ownerEmail,
    ownerPassword: manifest.ownerPassword,
    mainTableId: t0.mainTableId,
    fieldIds,
    pageLimit,
    scenes: resolved,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`[prep-scenes] ${resolved.length} 场景（${resolved.filter((s) => s.kind === "view").length} 预置视图）→ ${outPath}`);
}

function main(): void {
  const manifestPath = arg("--manifest");
  const pageLimit = Number(arg("--limit", "100")) || 100;
  const pagesArg = Number(arg("--pages", "0"));
  const outPath = arg("--out");
  if (!manifestPath) throw new Error("必须提供 --manifest /path/manifest.json");
  if (!outPath) throw new Error("必须提供 --out /path/scenes.json");
  prepareScenesFile(manifestPath, outPath, pageLimit, pagesArg);
}

// 仅直接运行时走 CLI；被 run-gate import 时只导出 prepareScenesFile，不读 argv。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

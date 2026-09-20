#!/usr/bin/env node
// apps/api/scripts/check-link-source-integrity.mjs
// 查阅/聚合/计数三类字段的「关联源完整性」只读巡检（不连 ORM、不改任何数据）。
//
// 背景：hydrate.ts 的取值链路只认 linkField.type === "links"
//   - resolveLookup（hydrate.ts:628）：`if (!linkField || linkField.type !== "links") return [];`
//   - resolveCount （hydrate.ts:701）：同口径 return 0;
// 因此这三类字段一旦把关联源指向 subtable / 其它类型（或指向已删字段、跨表字段、干脆没设），
// 字段就变成「永远为空」的死字段：lookup 恒 []、rollup 恒 null、count 恒 0，而界面无任何提示。
// 写入侧已由 domain/fieldValidation.ts 硬校验（POST/PATCH /api/fields 返回 400），新数据不会再产生；
// **存量**靠本脚本发现 + 人工修（读取侧刻意保持惰性、不改成硬错误：否则存量脏数据会让整张表
// 每次读取都炸——影响面覆盖列表/详情/导出/MCP/搜索索引）。
//
// 用法（cwd 任意）：
//   node apps/api/scripts/check-link-source-integrity.mjs --db /abs/app.db
//   node apps/api/scripts/check-link-source-integrity.mjs --db /abs/app.db --json
//   DATABASE_URL=file:/abs/app.db node apps/api/scripts/check-link-source-integrity.mjs --strict
//
// 退出码：0=完成（默认即使有发现也 0，本脚本是巡检不是门禁）；
//         1=--strict 且存在 error 级发现；64=参数/数据库不可用。
// 输出：默认人读（中文、可行动：库/表/字段/关联源真实类型/运行时表现/修复建议）；--json 机读归档。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 三类依赖「关联源」的计算字段；与 fieldValidation.ts 的判定口径一致。 */
const TARGET_TYPES = ["lookup", "rollup", "count"];

/** 字段类型 → 关联源非法时的运行时表现（hydrate.ts 惰性返回，不报错）。 */
const RUNTIME_EFFECT = {
  lookup: "lookup 恒为空数组（resolveLookup 早退 return []）",
  rollup: "rollup 恒为 null（同链路取不到关联行）",
  count: "count 恒为 0（resolveCount 早退 return 0）",
};

const CATEGORY_TEXT = {
  WRONG_TYPE: "关联源不是「关联(links)」类型字段",
  MISSING_TARGET: "关联源字段不存在或已被删除",
  CROSS_TABLE: "关联源字段不属于当前数据表",
  NO_SOURCE: "未指定关联源（运行时回退）",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
function hasFlag(name) {
  return process.argv.includes(name);
}
function fail(code, msg) {
  console.error(`[check-link-source] ${msg}`);
  process.exit(code);
}

function printUsage() {
  console.log(`用法：node apps/api/scripts/check-link-source-integrity.mjs --db <绝对路径.db> [--json] [--strict]

  --db      目标 SQLite 库绝对路径（也可用 DATABASE_URL=file:/abs/app.db 提供）
  --json    机读输出（单份 JSON，便于归档/比对），不打印人读文本
  --strict  存在 error 级发现时退出码 1（默认恒 0：本脚本只巡检不做门禁）
  退出码：0 完成 / 1 --strict 且有 error / 64 参数或数据库不可用`);
}

function resolveDbPath() {
  const fromArg = arg("--db");
  if (fromArg) return path.resolve(fromArg);
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("file:")) return path.resolve(url.slice("file:".length));
  return null;
}

function openReadonly(dbFile) {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    try {
      Database = require(path.join(
        path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
        "node_modules/better-sqlite3",
      ));
    } catch {
      fail(64, "无法解析 better-sqlite3（请在 apps/api 下用 pnpm 安装依赖后重试）");
    }
  }
  try {
    return new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch (e) {
    fail(64, `数据库不可读：${dbFile}（${e.message}）`);
  }
}

/** 目标库必须有这三张表（Prisma @@map：bases / tables / fields）。 */
function assertSchema(db) {
  const need = ["bases", "tables", "fields"];
  const present = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  const missing = need.filter((t) => !present.includes(t));
  if (missing.length > 0) {
    fail(64, `目标库缺少表 ${missing.join("/")}（迁移未跑或不是本应用的库）`);
  }
}

function scan(db) {
  const rows = db
    .prepare(
      `SELECT f.id AS fieldId, f.name AS fieldName, f.type AS fieldType, f.tableId AS tableId,
              f.linkFieldId AS linkFieldId,
              t.id AS tableId2, t.name AS tableName, t.baseId AS baseId,
              b.name AS baseName
       FROM fields f
       JOIN tables t ON t.id = f.tableId
       LEFT JOIN bases b ON b.id = t.baseId
       WHERE f.deletedAt IS NULL AND f.type IN (${TARGET_TYPES.map(() => "?").join(",")})`,
    )
    .all(...TARGET_TYPES);

  const targetStmt = db.prepare(
    "SELECT id, name, type, tableId, deletedAt FROM fields WHERE id = ?",
  );
  const tableNameStmt = db.prepare("SELECT name FROM tables WHERE id = ?");
  const linksCountStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM fields WHERE tableId = ? AND type = 'links' AND deletedAt IS NULL",
  );

  const findings = [];
  const byType = { lookup: 0, rollup: 0, count: 0 };
  for (const r of rows) {
    if (byType[r.fieldType] !== undefined) byType[r.fieldType] += 1;
    const ctx = {
      base: { id: r.baseId ?? null, name: r.baseName ?? "(库已删除/未知)" },
      table: { id: r.tableId, name: r.tableName },
      field: { id: r.fieldId, name: r.fieldName, type: r.fieldType },
    };
    const effect = RUNTIME_EFFECT[r.fieldType] ?? "取值恒为空";

    if (!r.linkFieldId) {
      const n = linksCountStmt.get(r.tableId)?.n ?? 0;
      findings.push({
        severity: "warn",
        category: "NO_SOURCE",
        ...ctx,
        linkField: null,
        runtimeEffect: n === 0
          ? `${effect}（本表无 links 字段，回退也无源可取）`
          : `未显式指定关联源，运行时回退到本表第 1 个 links 字段（本表现有 ${n} 个），取值可能不是预期那个`,
        suggestion: n === 0
          ? "先在本表建一个「关联」字段，再把该字段的关联源指向它；否则该字段永远取不到值。"
          : "打开字段设置 →「关联源」显式选择目标关联字段，避免依赖回退顺序（回退顺序随字段 order 变化）。",
      });
      continue;
    }

    const t = targetStmt.get(r.linkFieldId);
    if (!t || t.deletedAt !== null) {
      findings.push({
        severity: "error",
        category: "MISSING_TARGET",
        ...ctx,
        linkField: { id: r.linkFieldId, name: "(不存在或已删除)", type: "-", tableId: null },
        runtimeEffect: effect,
        suggestion: "重新选择关联源：指向本表一个仍然存在的「关联(links)」类型字段。",
      });
      continue;
    }
    const targetTableName = tableNameStmt.get(t.tableId)?.name ?? "(表已删除)";
    if (t.type !== "links") {
      findings.push({
        severity: "error",
        category: "WRONG_TYPE",
        ...ctx,
        linkField: {
          id: t.id,
          name: t.name,
          type: t.type,
          tableId: t.tableId,
          tableName: targetTableName,
        },
        runtimeEffect: effect,
        suggestion: `把「关联源」重新选择为一个「关联(links)」类型字段（当前指向的是「${t.name}」，真实类型 ${t.type}）；改之前该字段永远取不到值。`,
      });
      continue;
    }
    if (t.tableId !== r.tableId) {
      findings.push({
        severity: "error",
        category: "CROSS_TABLE",
        ...ctx,
        linkField: {
          id: t.id,
          name: t.name,
          type: t.type,
          tableId: t.tableId,
          tableName: targetTableName,
        },
        runtimeEffect: effect,
        suggestion: "关联源必须属于当前数据表：改选本表内的「关联(links)」字段。",
      });
    }
  }
  return { scanned: rows.length, byType, findings };
}

function renderHuman(dbFile, result) {
  const errors = result.findings.filter((f) => f.severity === "error");
  const warns = result.findings.filter((f) => f.severity === "warn");
  const lines = [];
  lines.push(`[check-link-source] 数据库：${dbFile}`);
  lines.push(
    `[check-link-source] 扫描 lookup/rollup/count 字段 ${result.scanned} 条`
      + `（lookup ${result.byType.lookup} / rollup ${result.byType.rollup} / count ${result.byType.count}）`,
  );
  lines.push(
    `[check-link-source] 发现异常 ${result.findings.length} 条：错误 ${errors.length}、提醒 ${warns.length}`,
  );
  if (result.findings.length === 0) {
    lines.push("[check-link-source] 全部关联源均指向本表的 links 字段，无需处理。");
    return lines.join("\n");
  }
  lines.push("");
  result.findings.forEach((f, i) => {
    const tag = f.severity === "error" ? "错误" : "提醒";
    lines.push(`${tag} ${i + 1}/${result.findings.length} [${f.category}] ${CATEGORY_TEXT[f.category]}`);
    lines.push(`  库         : ${f.base.name} (${f.base.id ?? "-"})`);
    lines.push(`  表         : ${f.table.name} (${f.table.id})`);
    lines.push(`  字段       : ${f.field.name} (${f.field.id}) 类型=${f.field.type}`);
    lines.push(
      f.linkField
        ? `  关联源     : ${f.linkField.name} (${f.linkField.id}) 真实类型=${f.linkField.type} 所在表=${f.linkField.tableName ?? "-"}`
        : "  关联源     : 未设置",
    );
    lines.push(`  运行时表现 : ${f.runtimeEffect}`);
    lines.push(`  修复建议   : ${f.suggestion}`);
    lines.push("");
  });
  return lines.join("\n");
}

function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return 0;
  }
  const dbFile = resolveDbPath();
  if (!dbFile) {
    console.error("[check-link-source] 缺少 --db <绝对路径.db>（或 DATABASE_URL=file:/abs/app.db）");
    printUsage();
    return 64;
  }
  if (!fs.existsSync(dbFile)) fail(64, `数据库文件不存在：${dbFile}`);

  const db = openReadonly(dbFile);
  try {
    assertSchema(db);
    const result = scan(db);
    if (hasFlag("--json")) {
      const errors = result.findings.filter((f) => f.severity === "error");
      const warns = result.findings.filter((f) => f.severity === "warn");
      console.log(
        JSON.stringify(
          { db: dbFile, scanned: result.scanned, byType: result.byType, findings: result.findings,
            summary: { error: errors.length, warn: warns.length } },
          null,
          2,
        ),
      );
    } else {
      console.log(renderHuman(dbFile, result));
    }
    if (hasFlag("--strict")) {
      return result.findings.some((f) => f.severity === "error") ? 1 : 0;
    }
    return 0;
  } finally {
    db.close();
  }
}

process.exit(main());

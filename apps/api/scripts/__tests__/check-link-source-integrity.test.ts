// apps/api/scripts/check-link-source-integrity.mjs 自测（真临时库 + 真 spawn，只读脚本不改数据）。
//
// 覆盖：
//  ① 干净库（三类字段均指向本表 links）-> 退出 0，报告「无需处理」，findings 为空；
//  ② 脏库 -> 四类判定各就位：WRONG_TYPE（指向 subtable）/ MISSING_TARGET（指向已删或无字段）/
//     CROSS_TABLE（指向别表 links）/ NO_SOURCE（未设源，提醒级）；干净字段不被误报；
//     输出可行动（带库名/表名/字段名/关联源真实类型/修复建议）；--json 结构可机读；
//     --strict 时退出 1，默认（不带 --strict）退出 0；
//  ③ 缺 --db -> 退出 64；--db 指向不存在文件 -> 退出 64。
//  ④ 只读铁律：跑完后库内容字节不变（不写、不修）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const API_ROOT = path.resolve(HERE, "../..");
const SCRIPT = path.join(API_ROOT, "scripts/check-link-source-integrity.mjs");

let tmpDir: string;
let cleanDb: string;
let dirtyDb: string;

interface Report {
  db: string;
  scanned: number;
  byType: Record<string, number>;
  findings: Array<{
    severity: string;
    category: string;
    base: { id: string | null; name: string };
    table: { id: string; name: string };
    field: { id: string; name: string; type: string };
    linkField: { id: string; name: string; type: string; tableName?: string } | null;
    runtimeEffect: string;
    suggestion: string;
  }>;
  summary: { error: number; warn: number };
}

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function reportOf(dbPath: string): Report {
  const r = run(["--db", dbPath, "--json"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as Report;
}

/** 用真迁移造库，再用裸 SQL 播种（脚本也是裸 SQL，不依赖 ORM）。 */
function seed(dbPath: string, withDirty: boolean): void {
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: API_ROOT,
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  });
  // 用脚本自身依赖的 better-sqlite3（apps/api 安装）写种子。
  const seeder = `
    const Database = require(${JSON.stringify(path.join(API_ROOT, "node_modules/better-sqlite3"))});
    const db = new Database(${JSON.stringify(dbPath)});
    const f = (id, tableId, name, type, order, extra = {}) => {
      const keys = Object.keys(extra);
      const cols = ['id', 'tableId', 'name', 'type', '"order"', ...keys.map((k) => '"' + k + '"')];
      const sql = 'INSERT INTO fields (' + cols.join(',')
        + ') VALUES (' + cols.map(() => '?').join(',') + ')';
      db.prepare(sql).run(id, tableId, name, type, order, ...keys.map((k) => extra[k]));
    };
    db.prepare("INSERT INTO bases (id,name,createdBy) VALUES ('b1','干净库','u'),('b2','脏库','u')").run();
    db.prepare("INSERT INTO tables (id,baseId,name,primaryFieldId,createdBy) VALUES ('t1','b1','订单','f_name_1','u'),('t2','b2','订单','f_name_2','u'),('t3','b2','客户','f_name_3','u')").run();
    f('f_name_1','t1','名称','singleLineText',0);
    f('f_link_1','t1','关联客户','links',1,{ relationKind: 'mm' });
    f('f_ok_count','t1','客户数','count',2,{ linkFieldId: 'f_link_1', lookupFieldId: 'f_name_1' });
    f('f_ok_lookup','t1','客户名','lookup',3,{ linkFieldId: 'f_link_1', lookupFieldId: 'f_name_1' });

    f('f_name_2','t2','名称','singleLineText',0);
    f('f_sub_2','t2','明细表','subtable',1,{ relationKind: 'hm' });
    f('f_link_2','t2','关联客户','links',2,{ relationKind: 'mm' });
    f('f_name_3','t3','名称','singleLineText',0);
    f('f_link_3','t3','关联订单','links',1,{ relationKind: 'mm' });
    db.close();
  `;
  execFileSync(process.execPath, ["-e", seeder], { cwd: API_ROOT, stdio: "ignore" });

  if (!withDirty) return;
  const dirty = `
    const Database = require(${JSON.stringify(path.join(API_ROOT, "node_modules/better-sqlite3"))});
    const db = new Database(${JSON.stringify(dbPath)});
    const f = (id, tableId, name, type, order, extra = {}) => {
      const keys = Object.keys(extra);
      const cols = ['id', 'tableId', 'name', 'type', '"order"', ...keys.map((k) => '"' + k + '"')];
      const sql = 'INSERT INTO fields (' + cols.join(',')
        + ') VALUES (' + cols.map(() => '?').join(',') + ')';
      db.prepare(sql).run(id, tableId, name, type, order, ...keys.map((k) => extra[k]));
    };
    // ① 关联源指向 subtable（存量脏数据主因）
    f('f_bad_type','t2','明细合计','rollup',3,{ linkFieldId: 'f_sub_2', lookupFieldId: 'f_name_2' });
    // ② 关联源字段不存在/已删
    f('f_bad_missing','t2','幽灵计数','count',4,{ linkFieldId: 'f_gone' });
    // ③ 关联源是 links 但属于别的表
    f('f_bad_cross','t2','跨表计数','count',5,{ linkFieldId: 'f_link_3' });
    // ④ 未设关联源（提醒级，运行时回退）
    f('f_bad_none','t2','未设源查阅','lookup',6,{});
    db.close();
  `;
  execFileSync(process.execPath, ["-e", dirty], { cwd: API_ROOT, stdio: "ignore" });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-linksrc-"));
  cleanDb = path.join(tmpDir, "clean.db");
  dirtyDb = path.join(tmpDir, "dirty.db");
  seed(cleanDb, false);
  seed(dirtyDb, true);
}, 120000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("check-link-source-integrity（真 spawn）", () => {
  it("① 干净库：退出 0，报告无需处理，findings 为空", () => {
    const r = run(["--db", cleanDb]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("无需处理");
    const rep = reportOf(cleanDb);
    expect(rep.scanned).toBe(2);
    expect(rep.summary).toEqual({ error: 0, warn: 0 });
    expect(rep.findings).toHaveLength(0);
  });

  it("② 脏库：四类判定齐全且干净字段不被误报", () => {
    const rep = reportOf(dirtyDb);
    // 2 条干净（t1）+ 4 条脏（t2）
    expect(rep.scanned).toBe(6);
    const cats = rep.findings.map((x) => x.category);
    expect(cats).toContain("WRONG_TYPE");
    expect(cats).toContain("MISSING_TARGET");
    expect(cats).toContain("CROSS_TABLE");
    expect(cats).toContain("NO_SOURCE");
    // 干净库（b1）的字段一条都不该被报（防过报）。
    expect(rep.findings.every((x) => x.base.id !== "b1")).toBe(true);
    expect(rep.summary.error).toBe(3);
    expect(rep.summary.warn).toBe(1);
  });

  it("②b 输出可行动：带库名/表名/字段名/关联源真实类型/修复建议", () => {
    const r = run(["--db", dirtyDb]);
    expect(r.code).toBe(0);
    const text = r.stdout;
    for (const s of ["脏库", "订单", "明细合计", "subtable", "修复建议"]) {
      expect(text, `人读输出应包含「${s}」`).toContain(s);
    }
    const rep = reportOf(dirtyDb);
    const wrongType = rep.findings.find((x) => x.category === "WRONG_TYPE")!;
    expect(wrongType.base.name).toBe("脏库");
    expect(wrongType.table.name).toBe("订单");
    expect(wrongType.field.name).toBe("明细合计");
    expect(wrongType.linkField?.type).toBe("subtable");
    expect(wrongType.suggestion).toContain("关联(links)");
    expect(wrongType.runtimeEffect).toContain("恒为 null");
  });

  it("②c --strict：有 error 级发现时退出 1，默认退出 0", () => {
    expect(run(["--db", dirtyDb]).code).toBe(0);
    expect(run(["--db", dirtyDb, "--strict"]).code).toBe(1);
    expect(run(["--db", cleanDb, "--strict"]).code).toBe(0);
  });

  it("③ 参数错误 -> 退出 64（缺 --db / 文件不存在 / 非本应用库）", () => {
    expect(run([]).code).toBe(64);
    expect(run(["--db", path.join(tmpDir, "nope.db")]).code).toBe(64);
    const emptyDb = path.join(tmpDir, "empty.db");
    fs.writeFileSync(emptyDb, "");
    expect(run(["--db", emptyDb]).code).toBe(64);
  });

  it("④ 只读铁律：跑完后数据库文件字节不变（绝不修数据）", () => {
    const before = fs.readFileSync(dirtyDb);
    run(["--db", dirtyDb]);
    run(["--db", dirtyDb, "--json"]);
    run(["--db", dirtyDb, "--strict"]);
    const after = fs.readFileSync(dirtyDb);
    expect(after.equals(before)).toBe(true);
  });
});

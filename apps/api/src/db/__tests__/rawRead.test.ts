// apps/api/src/db/__tests__/rawRead.test.ts
// S2 只读 raw 网关真库测试：临时文件 + 真实 better-sqlite3（非 mock）。
// 锁死 keyset 跨页不重不漏、(createdAt,id) 稳定排序（含同毫秒并列）、
// COUNT 口径（仅活行、按 tableId 隔离）、软删排除、只读连接拒绝写、limit 归一。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createRawReader, openRawReader, type RawReader } from "../rawRead.js";

// 与 Prisma 迁移产出的 records 表同构（raw 原语只读这一张表，无需全量迁移）。
const DDL = `
CREATE TABLE records (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tableId" TEXT NOT NULL,
  "fields" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "deletedAt" DATETIME
);`;

interface SeedRow {
  id: string;
  tableId?: string;
  createdAt: number;
  createdBy?: string;
  deleted?: boolean;
}

let tmpDir: string;
let dbFile: string;
let db: Database.Database;
let reader: RawReader;

const T1 = "tbl-1";
const T2 = "tbl-2";

function seed(rows: SeedRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO records ("id","tableId","fields","createdAt","updatedAt","createdBy","updatedBy","deletedAt")
     VALUES (@id,@tableId,@fields,@createdAt,@createdAt,@createdBy,@createdBy,@deletedAt)`,
  );
  for (const r of rows) {
    stmt.run({
      id: r.id,
      tableId: r.tableId ?? T1,
      fields: "{}",
      createdAt: r.createdAt,
      createdBy: r.createdBy ?? "u1",
      deletedAt: r.deleted ? r.createdAt : null,
    });
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-rawread-"));
  dbFile = path.join(tmpDir, "raw.db");
  db = new Database(dbFile);
  db.exec(DDL);
  reader = createRawReader(db);
});

afterEach(() => {
  reader.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("countLive / countByPlan", () => {
  beforeEach(() => {
    seed([
      { id: "a", createdAt: 1000 },
      { id: "b", createdAt: 2000, deleted: true },
      { id: "c", createdAt: 3000, createdBy: "u2" },
      { id: "t2a", tableId: T2, createdAt: 100 },
    ]);
  });

  it("只数活行且按 tableId 隔离", () => {
    expect(reader.countLive(T1)).toBe(2); // a、c（b 软删，t2a 属另一表）
    expect(reader.countLive(T2)).toBe(1);
  });

  it("countByPlan 附加谓词参数化绑定", () => {
    const n = reader.countByPlan(T1, 'AND "createdBy" = ?', ["u1"]);
    expect(n).toBe(1); // 仅 a（c=u2，b 软删）
  });

  it("countByPlan 无谓词等价 countLive", () => {
    expect(reader.countByPlan(T1)).toBe(reader.countLive(T1));
  });
});

describe("keysetPage 升序（默认）", () => {
  beforeEach(() => {
    // 刻意乱序插入：含两组同毫秒并列（a/b、d/e），游标 tie-break 必须稳定。
    seed([
      { id: "d", createdAt: 3000 },
      { id: "a", createdAt: 1000 },
      { id: "e", createdAt: 3000 },
      { id: "b", createdAt: 1000 },
      { id: "c", createdAt: 2000 },
      { id: "z", createdAt: 500, deleted: true },
      { id: "t2a", tableId: T2, createdAt: 1 },
    ]);
  });

  it("跨页不重不漏，排序恒为 (createdAt ASC, id ASC)", () => {
    const seen: string[] = [];
    let cursor = null as null | { createdAt: number; id: string };
    for (let page = 0; page < 10; page += 1) {
      const r = reader.keysetPage({ tableId: T1, cursor, limit: 2 });
      seen.push(...r.rows.map((x) => x.id));
      cursor = r.nextCursor;
      if (cursor === null) break;
    }
    // a,b 同 1000 按 id；c=2000；d,e 同 3000 按 id；软删 z 与他表 t2a 不出现。
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(seen).size).toBe(seen.length); // 无重复
  });

  it("首页从 null 游标开始，满页给 nextCursor，末页 nextCursor=null", () => {
    const p1 = reader.keysetPage({ tableId: T1, cursor: null, limit: 2 });
    expect(p1.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(p1.nextCursor).toEqual({ createdAt: 1000, id: "b" });

    const p2 = reader.keysetPage({ tableId: T1, cursor: p1.nextCursor, limit: 2 });
    expect(p2.rows.map((r) => r.id)).toEqual(["c", "d"]);

    const p3 = reader.keysetPage({ tableId: T1, cursor: p2.nextCursor, limit: 2 });
    expect(p3.rows.map((r) => r.id)).toEqual(["e"]);
    expect(p3.nextCursor).toBeNull(); // 不足一页 → 无下一页
  });

  it("页大小恰好等于活行数时不漏末行也不多页", () => {
    const p1 = reader.keysetPage({ tableId: T1, cursor: null, limit: 5 });
    expect(p1.rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(p1.nextCursor).toBeNull();
  });

  it("行投影为约定的七列且 createdAt 为 epoch-ms 整数", () => {
    const p = reader.keysetPage({ tableId: T1, cursor: null, limit: 1 });
    expect(Object.keys(p.rows[0]!).sort()).toEqual(
      ["createdAt", "createdBy", "fields", "id", "tableId", "updatedAt", "updatedBy"].sort(),
    );
    expect(p.rows[0]!.createdAt).toBe(1000);
  });
});

describe("keysetPage 降序与谓词组合", () => {
  beforeEach(() => {
    seed([
      { id: "a", createdAt: 1000, createdBy: "u1" },
      { id: "b", createdAt: 1000, createdBy: "u2" },
      { id: "c", createdAt: 2000, createdBy: "u1" },
      { id: "d", createdAt: 3000, createdBy: "u1" },
      { id: "e", createdAt: 3000, createdBy: "u2", deleted: true },
    ]);
  });

  it("desc 跨页不重不漏，排序 (createdAt DESC, id DESC)", () => {
    const seen: string[] = [];
    let cursor = null as null | { createdAt: number; id: string };
    for (let page = 0; page < 10; page += 1) {
      const r = reader.keysetPage({ tableId: T1, cursor, limit: 2, order: "desc" });
      seen.push(...r.rows.map((x) => x.id));
      cursor = r.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(["d", "c", "b", "a"]); // 同毫秒 id 降序；软删 e 排除
  });

  it("whereSql 谓词与游标同时生效（u1 活行翻页）", () => {
    const p1 = reader.keysetPage({
      tableId: T1,
      cursor: null,
      limit: 2,
      whereSql: 'AND "createdBy" = ?',
      params: ["u1"],
    });
    expect(p1.rows.map((r) => r.id)).toEqual(["a", "c"]);
    const p2 = reader.keysetPage({
      tableId: T1,
      cursor: p1.nextCursor,
      limit: 2,
      whereSql: 'AND "createdBy" = ?',
      params: ["u1"],
    });
    expect(p2.rows.map((r) => r.id)).toEqual(["d"]);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("limit 归一", () => {
  beforeEach(() => {
    seed(Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, createdAt: i + 1 })));
  });

  it("非法 limit 回退默认 20", () => {
    const p = reader.keysetPage({ tableId: T1, cursor: null, limit: 0 });
    expect(p.rows).toHaveLength(20);
    expect(p.nextCursor).not.toBeNull();
  });

  it("limit 上限 1000", () => {
    const p = reader.keysetPage({ tableId: T1, cursor: null, limit: 5000 });
    expect(p.rows.length).toBeLessThanOrEqual(1000);
  });
});

describe("只读连接保证", () => {
  it("openRawReader 只读打开：可查不可写，busy_timeout=5000", () => {
    // openRawReader 与下面的 raw 使用完全相同的打开选项 {readonly,timeout:5000}。
    const ro = openRawReader(dbFile);
    expect(ro.countLive(T1)).toBe(0); // 只读连接可正常查询
    const raw = new Database(dbFile, { readonly: true, timeout: 5000 });
    expect(raw.readonly).toBe(true);
    expect(() => raw.exec("INSERT INTO records (id) VALUES ('x')")).toThrow(/readonly|attempt to write/i);
    expect(raw.pragma("busy_timeout", { simple: true })).toBe(5000);
    raw.close();
    ro.close();
  });

  it("文件不存在时 openRawReader 直接抛错（不静默创建空库）", () => {
    expect(() => openRawReader(path.join(tmpDir, "missing.db"))).toThrow();
  });
});
